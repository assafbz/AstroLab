// Metro for the Expo app. Expo enables the tsconfig `paths` mapping (Task 1 Step 3), so nothing here
// needs to teach Metro about `@astrolab/core/dist/*` — only the one asset type `expo-sqlite` ships.
import { getDefaultConfig } from "expo/metro-config";

const config = getDefaultConfig(import.meta.dirname);

// `expo-sqlite`'s web implementation is a `.wasm` asset (ADR-0006; `docs/ARCHITECTURE.md` v2 §9).
// Without this Metro treats `.wasm` as unknown and the web bundle cannot resolve it. Harmless on
// native, where the module is linked rather than bundled.
config.resolver.assetExts.push("wasm");

export default config;
