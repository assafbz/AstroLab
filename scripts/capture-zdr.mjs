// PRIV1 build evidence: capture OpenRouter's ZDR-classified endpoint list.
// The spec names this as the artifact's only home (ARCHITECTURE.md §5, §11; audit issue EV6).
// The URL is the provider's own path (/api/v1/...), not AstroLab's (/v1/...).
import { mkdir, writeFile } from "node:fs/promises";

const source = process.env.ZDR_ENDPOINTS_URL ?? "https://openrouter.ai/api/v1/endpoints/zdr";
const out = "artifacts/zdr-endpoints.json";

// Hard-fails on a non-200 so a missing artifact is never mistaken for evidence.
const res = await fetch(source);
if (!res.ok) {
  console.error(`[zdr] ${source} -> HTTP ${res.status}`);
  process.exit(1);
}

const { data } = await res.json();
await mkdir("artifacts", { recursive: true });
await writeFile(
  out,
  `${JSON.stringify(
    {
      source,
      fetched_at: new Date().toISOString(),
      http_status: res.status,
      count: data?.length ?? 0,
      data,
    },
    null,
    2,
  )}\n`,
);
console.log(`[zdr] wrote ${out} — ${data?.length ?? 0} endpoints at ${source}`);
