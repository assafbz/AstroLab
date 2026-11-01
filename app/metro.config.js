// Metro for the Expo app. Expo enables the tsconfig `paths` mapping (Task 1 Step 3), so nothing here
// needs to teach Metro about `@astrolab/core/dist/*` — only the one asset type `expo-sqlite` ships.
import { getDefaultConfig } from "expo/metro-config";

const config = getDefaultConfig(import.meta.dirname);

// `.wasm` is an *asset*, not a module: `expo-sqlite` fetches its SQLite build as bytes and instantiates
// it in the worker. Metro has to emit it as an asset for web, and to copy it into the native bundle for
// native, where the module is linked rather than bundled.
config.resolver.assetExts.push("wasm");

// **Cross-origin isolation is deliberately not set here (#186).** `expo-sqlite`'s web target needs a
// cross-origin-isolated page, and the vendor skill prescribes adding `COOP`/`COEP` from
// `config.server.enhanceMiddleware`. On Expo SDK 58 that does not cover the page: the dev server serves
// the HTML document from `ManifestMiddleware`, which `MetroBundlerDevServer` *prepends* to the front of
// the middleware stack (`build/src/start/server/metro/MetroBundlerDevServer.js:961` ->
// `prependMiddleware()` -> `stack.unshift`), ahead of anything `enhanceMiddleware` can wrap. Measured:
// `/app/index.bundle` carries the headers, `/` carries only `content-type`, so `crossOriginIsolated` is
// still `false`. A middleware that cannot deliver the isolation is worse than none — it reads as if it
// works. The web run path, and the host that does supply the headers, are in `app/README.md`.

export default config;
