import { InvalidOutputError, type MechanismDescriptor, type SparkDraft } from "./types.js";

/**
 * Structured output (`ARCHITECTURE.md` §5): both calls ask for JSON validated against a schema **before
 * anything is stored**, and *"invalid output = a failed call, retried per §4, never stored"*.
 *
 * Validation is hand-rolled rather than a schema library: two small objects do not earn a dependency,
 * and this is the same shape `store/src/domain-seed.ts` already uses to validate its YAML. The
 * `…_SCHEMA` constants are what the model is *asked* for; the parsers are what it is *held to* — a model
 * that ignores the schema is caught here, not by the schema's existence.
 */

/** The subset of JSON Schema this boundary emits — enough for two flat objects, no more. */
export interface JsonSchema {
  type: "object";
  additionalProperties: false;
  required: readonly string[];
  properties: Record<string, { type: string | readonly string[] }>;
}

/** §3.3 step 1 — the descriptor. Four non-empty strings; the field set is W9's to confirm (§12.2). */
export const DESCRIPTOR_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verb", "object_class", "constraint", "transferable_structure"],
  properties: {
    verb: { type: "string" },
    object_class: { type: "string" },
    constraint: { type: "string" },
    transferable_structure: { type: "string" },
  },
};

/**
 * §3.3 step 3 — the adjudication. Each field is nullable so the model can decline in the same shape it
 * accepts: **all null** is a refusal (a real answer — the pair becomes suppressed noise), and **all
 * non-empty** is a draft. A half-null reply is neither, and is rejected rather than guessed at.
 */
export const ADJUDICATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["shared_mechanism", "direction", "claim", "what_it_takes", "first_step"],
  properties: {
    shared_mechanism: { type: ["string", "null"] },
    direction: { type: ["string", "null"] },
    claim: { type: ["string", "null"] },
    what_it_takes: { type: ["string", "null"] },
    first_step: { type: ["string", "null"] },
  },
};

/**
 * §3.2 step 2 — the tag normalisation. One non-empty `cluster_id`; the offered set is known to the
 * caller, so the *parser* (not the schema) holds the answer to membership.
 */
export const TAG_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cluster_id"],
  properties: { cluster_id: { type: "string" } },
};

function fail(where: string, message: string): never {
  throw new InvalidOutputError(`provider output: ${where} ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * A required, non-empty string. Extra keys are deliberately *not* an error: the schema asks the model
 * not to send them, and an ignored extra cannot corrupt storage — where a missing or blank field can.
 */
function asText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") fail(key, "must be a non-empty string");
  return value;
}

/**
 * A nullable string. A **missing** key is an error while an explicit `null` is a refusal: conflating
 * them would turn a model that dropped a field into a silent "no spark here" (suppressed noise) instead
 * of a failed call.
 */
function asNullableText(record: Record<string, unknown>, key: string): string | null {
  if (!(key in record)) fail(key, "is missing");
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    fail(key, "must be a non-empty string or null");
  }
  return value;
}

/** `§3.3` step 1 — throws `InvalidOutputError` rather than returning a partial descriptor. */
export function parseDescriptor(raw: unknown): MechanismDescriptor {
  const record = asRecord(raw, "descriptor");
  return {
    verb: asText(record, "verb"),
    object_class: asText(record, "object_class"),
    constraint: asText(record, "constraint"),
    transferable_structure: asText(record, "transferable_structure"),
  };
}

/** `§3.3` step 3 — a draft, or `null` for a declared refusal. Nothing partial ever comes back. */
export function parseAdjudication(raw: unknown): SparkDraft | null {
  const record = asRecord(raw, "adjudication");
  const values = (
    ["shared_mechanism", "direction", "claim", "what_it_takes", "first_step"] as const
  ).map((key) => asNullableText(record, key));

  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    fail("adjudication", "is neither a complete draft nor a complete refusal");
  }

  const [mechanism, direction, claim, what_it_takes, first_step] = values as [
    string,
    string,
    string,
    string,
    string,
  ];
  return { mechanism, direction, claim, what_it_takes, first_step };
}

/**
 * `§3.2` step 2 — the answer must be one of the offered clusters. An id outside the set is invalid
 * output (a failed call, retried per §4, never stored), not a made-up cluster: `domain_map.cluster_id`
 * is a foreign key, so a hallucinated id would otherwise surface as a database error rather than the
 * provider error it is.
 */
export function parseTagCluster(raw: unknown, allowed: ReadonlySet<string>): string {
  const record = asRecord(raw, "tag normalisation");
  const clusterId = asText(record, "cluster_id");
  if (!allowed.has(clusterId))
    fail("cluster_id", `is not one of the offered clusters: ${clusterId}`);
  return clusterId;
}
