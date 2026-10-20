/**
 * The provider boundary's surface (`ARCHITECTURE.md` §5; L3 · #166). Nothing outside `core/src/engine/`
 * (its only caller) or the app's own reach directories may import this module: NFR-A1 holds because the
 * vault has no reachable path to a provider, and `boundary.test.ts` fails the suite if one appears.
 */
export {
  ADJUDICATION_SYSTEM,
  EXTRACTION_SYSTEM,
  TAG_NORMALISATION_SYSTEM,
  adjudicationUser,
  extractionUser,
  tagNormalisationUser,
} from "./prompts.js";
export {
  ADJUDICATION_SCHEMA,
  DESCRIPTOR_SCHEMA,
  TAG_SCHEMA,
  parseAdjudication,
  parseDescriptor,
  parseTagCluster,
  type JsonSchema,
} from "./schema.js";
export {
  DEFAULT_MODEL,
  buildRequest,
  createFetchTransport,
  createOpenRouterAdapter,
  type BuildRequestInput,
  type ChatRequest,
  type ChatResponse,
  type FetchTransportOptions,
  type OpenRouterAdapterOptions,
  type Transport,
  type ZdrPinnedRequest,
} from "./openrouter.js";
export { failureCause } from "./failure.js";
export { normalizeKey, readKey, type KeyStore } from "./key.js";
export { NATIVE_ONLY_CAUSE, webReachFor, type NativeOnly, type WebReach } from "./web.js";
export {
  InvalidOutputError,
  NoKeyError,
  ProviderError,
  type ClusterOption,
  type IdeaText,
  type MechanismDescriptor,
  type MechanismExtractor,
  type MechanismPair,
  type Provider,
  type SparkAdjudicator,
  type SparkDraft,
  type TagNormalizer,
} from "./types.js";
