// F1 = a process that starts. The in-process queue, run lifecycle (E0-E4) and the
// two-stage engine land in W1 (ARCHITECTURE.md §3, §4; ADR-0004) — nothing polls here.
console.log("[worker] up — queue and engine land in W1");
