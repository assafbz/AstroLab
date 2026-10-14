import { bootWorker } from "./boot.js";
import { createEngineFromEnv } from "./compose.js";
import { startWorker } from "./queue.js";

// W1 (#26) is the engine lane's skeleton: a process that boots **like the API** — openStore →
// migrate → seedDomainTaxonomy (the O1 #21 carry) → requeue a crash-orphaned run — and then drains
// the in-process run queue (ADR-0004).
const db = bootWorker();
// W8 (#33) names the run surface — the environment's adapter and the four composed stages
// (`worker/src/compose.ts`) — so the loop no longer runs W1's stub. A provider that cannot be built
// does **not** stop this boot: it fails every run (→ E4), so the queue and the vault stay up while
// spark generation is unavailable (`FLOW.md` §5.6).
const engine = createEngineFromEnv(db);
startWorker(db, engine.body, { commit: engine.commit });
console.log("[worker] up — draining the spark run queue");
