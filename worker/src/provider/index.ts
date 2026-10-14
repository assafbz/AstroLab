/**
 * The provider boundary's surface (`ARCHITECTURE.md` §5). Nothing in `api/` or `store/` may import this
 * module: NFR-A1 holds because the vault has no reachable path to a provider, and `boundary.test.ts`
 * fails the suite if one appears.
 */
export {
  ADJUDICATION_SYSTEM,
  EXTRACTION_SYSTEM,
  adjudicationUser,
  extractionUser,
} from "./prompts.js";
export {
  ADJUDICATION_SCHEMA,
  DESCRIPTOR_SCHEMA,
  parseAdjudication,
  parseDescriptor,
  type JsonSchema,
} from "./schema.js";
export {
  DEFAULT_MODEL,
  buildRequest,
  createAdapterFromEnv,
  createFetchTransport,
  createOpenRouterAdapter,
  type AdapterFromEnvOptions,
  type BuildRequestInput,
  type ChatRequest,
  type ChatResponse,
  type FetchTransportOptions,
  type OpenRouterAdapterOptions,
  type Transport,
  type ZdrPinnedRequest,
} from "./openrouter.js";
export {
  InvalidOutputError,
  ProviderError,
  type IdeaText,
  type MechanismDescriptor,
  type MechanismExtractor,
  type MechanismPair,
  type Provider,
  type SparkAdjudicator,
  type SparkDraft,
} from "./types.js";
