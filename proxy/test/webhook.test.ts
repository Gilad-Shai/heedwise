// THREAT_MODEL.md §6 item 4: webhook protections.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { sign, startWebhookSource, MAX_BODY_BYTES } from "../src/sources/webhook.ts";
import type { SourceEvent } from "../src/types.ts";

const SECRET = "s".repeat(40);
const PORT = 18788;
const received: SourceEvent[] = [];
const server = await startWebhookSource({ name: "shop", secret: SECRET, port: PORT, onEvent: (e) => received.push(e) });
after(() => server.close());

function post(body: string, headers: Record<string, string> = {}, path = "/events/shop") {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, method: "POST", path,
      headers: { "content-type": "application/json", ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(body);
  });
}
const good = (id: string) => JSON.stringify({ id, account: "store-1", entity: "sku/A", type: "inventory.adjusted",
  changes: { on_hand: { from: 20, to: 12 } } });
const signed = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
  "x-heedwise-timestamp": String(ts), "x-heedwise-signature": sign(SECRET, ts, body) });

test("valid signed event is accepted and normalized", async () => {
  const body = good("e1");
  assert.equal(await post(body, signed(body)), 202);
  const ev = received.at(-1)!;
  assert.equal(ev.source, "webhook:shop");
  assert.equal(ev.id, "webhook:shop:e1");
  assert.deepEqual(ev.changes, { on_hand: { from: 20, to: 12 } });
});

test("missing or wrong signature -> 401", async () => {
  const body = good("e2");
  assert.equal(await post(body), 401);
  assert.equal(await post(body, { ...signed(body), "x-heedwise-signature": "sha256=" + "0".repeat(64) }), 401);
  assert.equal(await post(body + " ", signed(body)), 401, "signature covers the exact body");
});

test("expired timestamp -> 401 (replay window)", async () => {
  const body = good("e3");
  assert.equal(await post(body, signed(body, Math.floor(Date.now() / 1000) - 3600)), 401);
});

test("foreign Host or any Origin -> 403 (DNS rebinding / CSRF)", async () => {
  const body = good("e4");
  assert.equal(await post(body, { ...signed(body), host: "evil.example:18788" }), 403);
  assert.equal(await post(body, { ...signed(body), origin: "https://evil.example" }), 403);
});

test("non-JSON -> 415, oversized -> 413, wrong path -> 404", async () => {
  const body = good("e5");
  assert.equal(await post(body, { ...signed(body), "content-type": "text/plain" }), 415);
  const big = "x".repeat(MAX_BODY_BYTES + 10);
  assert.equal(await post(big, signed(big)), 413);
  assert.equal(await post(body, signed(body), "/events/other"), 404);
});

test("schema violations -> 400 without echoing input", async () => {
  for (const bad of [
    JSON.stringify({ id: "x; rm -rf", account: "a", entity: "b", type: "t" }),
    JSON.stringify({ id: "e6", account: "a", entity: "b", type: "t", extra: 1 }),
    JSON.stringify({ id: "e7", account: "a", entity: "b", type: "t", changes: { "bad-field": { to: 1 } } }),
    "{not json",
  ]) assert.equal(await post(bad, signed(bad)), 400);
});

test("refuses to start without a strong secret or on a non-loopback address", async () => {
  await assert.rejects(() => startWebhookSource({ name: "x", secret: "short", port: 0, onEvent: () => {} }), /secret/);
  await assert.rejects(() => startWebhookSource({ name: "x", secret: SECRET, port: 0, host: "0.0.0.0", onEvent: () => {} }), /non-loopback/);
});
