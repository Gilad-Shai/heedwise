// Generic webhook source: a local HTTP listener that accepts signed JSON events.
// Protections (THREAT_MODEL.md T2): 127.0.0.1 only, HMAC-SHA256 over
// `${timestamp}.${body}`, ±5 min window, Host allowlist, no Origin, JSON only,
// body ≤ 64 KB, rate limit. Replays of the same event id are dropped by the engine.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { z } from "zod";
import { log, registerSecret } from "../log.ts";
import type { SourceEvent } from "../types.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_SKEW_SECONDS = 300;
const RATE_PER_SECOND = 50;

const ident = z.string().regex(/^[A-Za-z0-9._/#:@+-]{1,100}$/);
const fieldName = z.string().regex(/^[A-Za-z0-9_]{1,40}$/);
const value = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
const EventBody = z.object({
  id: ident,
  account: ident,
  entity: ident,
  type: ident,
  ts: z.iso.datetime().optional(),
  changes: z.record(fieldName, z.object({ from: value.optional(), to: value })).default({}),
  text: z.object({ author: ident, body: z.string().max(10_000) }).optional(),
}).strict();

export interface WebhookOptions {
  /** Source name; events are tagged `webhook:<name>`. */
  name: string;
  secret: string;
  port: number;
  /** Bind address. Anything but loopback requires `allowNonLoopback`. */
  host?: string;
  allowNonLoopback?: boolean;
  onEvent: (ev: SourceEvent) => void;
  nowSeconds?: () => number;
}

export function sign(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export async function startWebhookSource(opts: WebhookOptions): Promise<Server> {
  if (!/^[a-z0-9_-]{1,32}$/.test(opts.name)) throw new Error("webhook name must match [a-z0-9_-]{1,32}");
  if (!opts.secret || opts.secret.length < 32) throw new Error("webhook secret is required (at least 32 characters)");
  const host = opts.host ?? "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !opts.allowNonLoopback) throw new Error(`refusing to bind to non-loopback address ${host}`);
  if (!loopback) log(`WARNING: webhook listener bound to ${host}; it is reachable from the network`);
  registerSecret(opts.secret);
  const now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  const path = `/events/${opts.name}`;
  let windowStart = 0;
  let windowCount = 0;

  const server = createServer(async (req, res) => {
    const reply = (code: number, msg: string) => res.writeHead(code, { "content-type": "text/plain" }).end(msg + "\n");
    // cheap checks first, before reading the body
    const t = now();
    if (t !== windowStart) { windowStart = t; windowCount = 0; }
    if (++windowCount > RATE_PER_SECOND) return reply(429, "rate limited");
    if (req.method !== "POST" || req.url !== path) return reply(404, "not found");
    if (!allowedHosts.has(req.headers.host ?? "")) return reply(403, "forbidden host");
    if (req.headers.origin !== undefined) return reply(403, "browser requests are not accepted");
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return reply(415, "json only");
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return reply(413, "too large");

    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) return reply(413, "too large");

    const ts = Number(req.headers["x-heedwise-timestamp"]);
    const sig = String(req.headers["x-heedwise-signature"] ?? "");
    if (!Number.isInteger(ts) || Math.abs(t - ts) > MAX_SKEW_SECONDS) return reply(401, "bad or expired timestamp");
    const expected = Buffer.from(sign(opts.secret, ts, body));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(401, "bad signature");

    let parsed: z.infer<typeof EventBody>;
    try {
      parsed = EventBody.parse(JSON.parse(body));
    } catch {
      return reply(400, "invalid event"); // never echo the body or parser details
    }
    const ev: SourceEvent = {
      id: `webhook:${opts.name}:${parsed.id}`,
      source: `webhook:${opts.name}`,
      account: parsed.account,
      entity: parsed.entity,
      type: parsed.type,
      ts: parsed.ts ?? new Date(t * 1000).toISOString(),
      changes: parsed.changes as SourceEvent["changes"],
      ...(parsed.text ? { text: parsed.text } : {}),
    };
    opts.onEvent(ev);
    return reply(202, "accepted");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      log(`webhook source '${opts.name}' listening on ${host}:${opts.port}${path}`);
      resolve(server);
    });
  });
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { over = true; req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", () => resolve(null));
  });
}
