// Placeholder so `npm test` runs in CI until the engine tests land (plan step 3).
import { test } from "node:test";
import assert from "node:assert/strict";

test("node:sqlite is available (planned storage)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  assert.equal(db.prepare("select 1 as x").get()?.x, 1);
});
