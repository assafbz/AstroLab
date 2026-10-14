/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The client's bearer for `/v1` (`docs/API.md` §1). Vite exposes only `VITE_`-prefixed vars to the
   * bundle, so the client's copy of the token carries its own name. Empty → requests go out without
   * the header and the server answers `401` (it fails closed).
   */
  readonly VITE_API_TOKEN?: string;
}
