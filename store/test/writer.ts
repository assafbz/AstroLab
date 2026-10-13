// One of the two competing writers the concurrency test spawns. Run via `node --import tsx`.
import { openStore, writeTransaction } from "../src/store.js";

const [path, countRaw] = process.argv.slice(2);
if (!path || !countRaw) throw new Error("usage: writer.ts <db-path> <count>");

// busy_timeout = 0, so the two processes really do collide and the retry is what carries them.
const db = openStore(path, { busyTimeoutMs: 0 });
const count = Number(countRaw);
for (let k = 0; k < count; k++) {
  writeTransaction(db, () => db.exec(`INSERT INTO t (k) VALUES (${k})`), {
    attempts: 50,
    baseDelayMs: 1,
    maxDelayMs: 25,
  });
}
db.close();
console.log(`[writer ${process.pid}] wrote ${count} rows`);
