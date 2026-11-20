// End-to-end over stdio: an MCP client (as Claude Code would be) talks to the real
// server process; events arrive through the signed webhook source.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { sign } from "../src/sources/webhook.ts";

const SECRET = "w".repeat(40);
const PORT = 18790;
const pushes: string[] = [];
let client: Client;

const ChannelNote = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../src/server.ts", import.meta.url).pathname],
    env: { PATH: process.env.PATH ?? "", HEEDWISE_WEBHOOK_SECRET: SECRET, HEEDWISE_WEBHOOK_PORT: String(PORT),
      HEEDWISE_WEBHOOK_NAME: "shop", HEEDWISE_PUSH: "on", HEEDWISE_STATE_DIR: mkdtempSync(join(tmpdir(), "ap-srv-")) },
    stderr: "ignore",
  });
  client = new Client({ name: "test-host", version: "0.0.1" });
  client.setNotificationHandler(ChannelNote, (n) => { pushes.push(n.params.content); });
  await client.connect(transport);
});
after(async () => { await client.close(); });

async function postEvent(body: object) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`http://127.0.0.1:${PORT}/events/shop`, { method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-heedwise-timestamp": String(ts), "x-heedwise-signature": sign(SECRET, ts, raw) } });
  return res.status;
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[])[0]?.text ?? "", isError: !!r.isError };
};
const waitFor = async (pred: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

test("declares the channel capability and the expected tools only", async () => {
  assert.deepEqual(client.getServerCapabilities()?.experimental, { "claude/channel": {} });
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_updates", "list_watches", "unwatch", "watch_entity", "watch_github_pr"]);
});

test("watch -> signed event -> HIGH update pushed into the session as a channel notification", async () => {
  const w = await call("watch_entity", { account: "store-1", entity: "sku/A", conditions: [{ field: "on_hand", op: "lt", value: 15 }] });
  assert.match(w.text, /Watching store-1 sku\/A/);
  assert.equal(await postEvent({ id: "n1", account: "store-1", entity: "sku/B", type: "inventory.adjusted", changes: { on_hand: { from: 9, to: 1 } } }), 202);
  assert.equal(await postEvent({ id: "e1", account: "store-1", entity: "sku/A", type: "inventory.adjusted", changes: { on_hand: { from: 20, to: 16 } } }), 202);
  assert.equal(await postEvent({ id: "e2", account: "store-1", entity: "sku/A", type: "inventory.adjusted", changes: { on_hand: { from: 16, to: 11 } } }), 202);
  await waitFor(() => pushes.length > 0);
  assert.equal(pushes.length, 1, "burst coalesced into one push");
  assert.match(pushes[0]!, /\[HIGH\] store-1 sku\/A on_hand: 20 -> 11 \(condition met: on_hand lt 15\)/);
  assert.doesNotMatch(pushes[0]!, /sku\/B/, "unwatched entity not delivered");
  assert.equal((await call("get_updates")).text, "No changes since the last update.");
});

test("replayed event id is ignored end to end", async () => {
  const before = pushes.length;
  assert.equal(await postEvent({ id: "e2", account: "store-1", entity: "sku/A", type: "inventory.adjusted", changes: { on_hand: { from: 16, to: 11 } } }), 202);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(pushes.length, before);
});

test("list and unwatch", async () => {
  const list = await call("list_watches");
  const id = /(sub_[a-z0-9_]+)/.exec(list.text)?.[1];
  assert.ok(id);
  assert.match((await call("unwatch", { id })).text, /Stopped/);
  assert.equal((await call("list_watches")).text, "No active subscriptions.");
});

test("GitHub tool refuses cleanly when not configured", async () => {
  const r = await call("watch_github_pr", { repo: "octo/repo", pr: 1 });
  assert.equal(r.isError, true);
  assert.match(r.text, /not configured/);
});
