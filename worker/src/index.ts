import { bootWorker } from "./boot.js";
import { startWorker } from "./queue.js";

// W1 (#26) is the engine lane's skeleton: a process that boots **like the API** — openStore →
// migrate → seedDomainTaxonomy (the O1 #21 carry) → requeue a crash-orphaned run — and then drains
// the in-process run queue (ADR-0004). The run body is still the stub (`queue.ts`), so no provider
// is reached; W2 swaps in the engine and this file does not change.
const db = bootWorker();
startWorker(db);
console.log("[worker] up — draining the spark run queue");
