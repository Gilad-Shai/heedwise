// SQLite-backed attention state (node:sqlite, no extra dependency).
// Stores ONLY subscriptions and seen event ids. Never secrets, never payloads.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StateStore } from "./engine.ts";
import type { Subscription } from "./types.ts";

const SEEN_RETENTION_MS = 7 * 24 * 3600 * 1000;

export class SqliteStore implements StateStore {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Create the file with owner-only permissions before SQLite opens it.
      if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, session TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
    `);
  }

  putSubscription(sub: Subscription): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO subscriptions (id, session, body, expires_at) VALUES (?, ?, ?, ?)")
      .run(sub.id, sub.session, JSON.stringify(sub), sub.expiresAt);
  }

  deleteSubscription(id: string): void {
    this.#db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
  }

  listSubscriptions(): Subscription[] {
    const rows = this.#db.prepare("SELECT body FROM subscriptions").all() as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as Subscription);
  }

  markSeen(eventId: string, atMs: number): boolean {
    const res = this.#db
      .prepare("INSERT OR IGNORE INTO seen_events (id, seen_at) VALUES (?, ?)")
      .run(eventId, atMs);
    if (Math.random() < 0.01) {
      this.#db.prepare("DELETE FROM seen_events WHERE seen_at < ?").run(atMs - SEEN_RETENTION_MS);
    }
    return Number(res.changes) === 1;
  }

  close(): void {
    this.#db.close();
  }
}
