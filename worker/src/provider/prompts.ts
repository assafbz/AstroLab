import type { ClusterOption, IdeaText, MechanismPair } from "./types.js";

/**
 * The three prompts, kept beside the adapter that sends them and out of the engine's logic: what is asked
 * of the model is part of *talking to the model*, and §5's interface (`extract(idea)`,
 * `adjudicate(a, b, mechanisms)`) has no prompt parameter for a caller to supply.
 *
 * Only the operation's payload is ever interpolated (§5: no vault listing, no unrelated ideas). W9's
 * calibration run tunes these; W3 and W6 own the *results*, not the wording.
 */

export const EXTRACTION_SYSTEM = [
  "You extract the transferable mechanism of an idea.",
  "Return JSON matching the given schema exactly, with no commentary.",
  "Fields: verb (the action performed), object_class (what it acts on), constraint (what limits it),",
  "transferable_structure (the abstract pattern that could move to another field).",
].join(" ");

export const ADJUDICATION_SYSTEM = [
  "You decide whether two ideas share a real, transferable mechanism.",
  "Return JSON matching the given schema exactly, with no commentary.",
  "If they do, fill every field: shared_mechanism, direction (a headline for the combined idea),",
  "claim (one or two lines on why it matters), what_it_takes, first_step.",
  "If they do not, set every field to null.",
].join(" ");

export const TAG_NORMALISATION_SYSTEM = [
  "You classify one free-text domain tag into the nearest cluster.",
  "Return JSON matching the given schema exactly, with no commentary.",
  "Set cluster_id to exactly one id from the list provided by the user.",
].join(" ");

/** The tag, then the offered clusters as `id — name` lines. The id, never the display name, is asked for. */
export function tagNormalisationUser(tag: string, clusters: readonly ClusterOption[]): string {
  return [
    `Tag: ${tag}`,
    "Clusters:",
    ...clusters.map((cluster) => `${cluster.id} — ${cluster.name}`),
  ].join("\n");
}

export function extractionUser(idea: IdeaText): string {
  return [
    `Hypothesis: ${idea.hypothesis}`,
    `Problem: ${idea.problem}`,
    `Monetization: ${idea.monetization}`,
  ].join("\n");
}

export function adjudicationUser(a: IdeaText, b: IdeaText, mechanisms: MechanismPair): string {
  return [
    "Idea A:",
    extractionUser(a),
    "Mechanism A:",
    JSON.stringify(mechanisms.a),
    "Idea B:",
    extractionUser(b),
    "Mechanism B:",
    JSON.stringify(mechanisms.b),
  ].join("\n");
}
