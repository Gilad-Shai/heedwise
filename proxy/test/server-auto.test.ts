// Push mode "auto" with a client that is not Claude Code: nothing is pushed and the
// update stays available through get_updates (regression test for lost updates).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { sign } from "../src/sources/webhook.ts";

const SECRET = "a".repeat(40);
const PORT = 18791;
let pushes = 0;
let client: Client;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../src/server.ts", import.meta.url).pathname],
    env: { PATH: process.env.PATH ?? "", HEEDWISE_WEBHOOK_SECRET: SECRET, HEEDWISE_WEBHOOK_PORT: String(PORT),
      HEEDWISE_WEBHOOK_NAME: "shop", HEEDWISE_STATE_DIR: mkdtempSync(join(tmpdir(), "ap-auto-")) },
    stderr: "ignore",
  });
  client = new Client({ name: "some-other-host", version: "1.0.0" });
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }), () => { pushes++; });
  await client.connect(transport);
});
after(async () => { await client.close(); });

test("non-Claude client: no push, update kept for get_updates", async () => {
  await client.callTool({ name: "watch_entity", arguments: { account: "store-1", entity: "sku/A" } });
  const raw = JSON.stringify({ id: "x1", account: "store-1", entity: "sku/A", type: "inventory.adjusted", changes: { on_hand: { from: 9, to: 3 } } });
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`http://127.0.0.1:${PORT}/events/shop`, { method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-heedwise-timestamp": String(ts), "x-heedwise-signature": sign(SECRET, ts, raw) } });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 2500)); // longer than the push debounce
  assert.equal(pushes, 0);
  const r = await client.callTool({ name: "get_updates", arguments: {} });
  assert.match((r.content as { text: string }[])[0]!.text, /\[HIGH\] store-1 sku\/A on_hand: 9 -> 3/);
});
