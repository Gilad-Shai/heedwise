// Core data model. Sources normalize whatever they read into `SourceEvent`;
// the engine never sees raw payloads.

/** Structured, typed values only. Free text never goes here (see `text`). */
export type FieldValue = string | number | boolean | null;

export interface SourceEvent {
  /** Globally unique, stable id (used for dedupe). */
  id: string;
  /** e.g. "github" or "webhook:billing". */
  source: string;
  /** Owner of the entity, e.g. "octo/repo". */
  account: string;
  /** The thing that changed, e.g. "pr/171", "sku/SKU-5693". */
  entity: string;
  /** e.g. "ci.run_completed", "inventory.adjusted". */
  type: string;
  /** ISO-8601 timestamp of the change at the source. */
  ts: string;
  /** State changes as field -> {from, to}. `from` may be unknown. */
  changes: Record<string, { from?: FieldValue; to: FieldValue }>;
  /** Fixed explanatory note written by our own source code (never external text). */
  note?: string;
  /** Optional free text (comment body, email body...). Untrusted. Off by default. */
  text?: { author: string; body: string };
}

export type ConditionOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in";

export interface Condition {
  field: string;
  op: ConditionOp;
  value: FieldValue | FieldValue[];
}

export interface Subscription {
  id: string;
  /** The agent session that owns this subscription. */
  session: string;
  source: string;
  account: string;
  entity: string;
  /** Only these event types (all if omitted). */
  types?: string[];
  /** Annotate deltas when a condition on the new value holds (e.g. on_hand lt 15). */
  conditions?: Condition[];
  /** Also report changes on other entities of the same account, at low priority. */
  includeRelated?: boolean;
  /** Free text is delivered only from these authors. Empty/omitted = never. */
  allowTextFrom?: string[];
  /** Epoch ms. */
  expiresAt: number;
}

export type Priority = "HIGH" | "low";

export interface DeltaLine {
  priority: Priority;
  source: string;
  account: string;
  entity: string;
  field: string;
  from: FieldValue | undefined;
  to: FieldValue;
  ts: string;
  conditionsMet: string[];
  texts: { author: string; body: string }[];
  /** Free text existed but the author is not allowlisted, so it was not delivered. */
  textWithheld: number;
  /** Note from the latest event that touched this line (cleared by later events without one). */
  note: string | undefined;
}

export interface Delivery {
  session: string;
  asOf: string;
  lines: DeltaLine[];
  /** Lines dropped because of the token budget. */
  omitted: number;
  /** Rendered, sanitized text ready to inject into the agent's context. */
  rendered: string;
  estimatedTokens: number;
}
