import { useCallback, useEffect, useState } from "react";

import type { VaultSummary } from "../api/types.ts";
import { vaultSummary } from "../api/vault.ts";
import { ColdState } from "../components/ColdState.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { spreadGate } from "../domain/spread-gate.ts";

/**
 * S1 — Sparks, the home (`FLOW.md` §2.1 S1, §4.2 T03/T05; `DESIGN.md` §9).
 *
 * **What O4 `#24` builds here is one branch of the state machine: E0.** The deck, the shimmer, the
 * unreviewed count and the recompute control are K2 `#36`, and the engine's state read is W8 `#33` —
 * neither exists yet. So this screen reads the vault summary and asks the one question O4 owns:
 *
 * - **gate closed (`!eligible`, below the floor) → E0 Cold.** `FLOW.md` §5.2 makes the floor *"the
 *   only condition"* that puts S1 in E0, so `!eligible` **implies** the engine's E0 — a sufficient
 *   condition, never an attempt to derive E0's full definition. The `< 2 ideas` clause and the
 *   E1/E2/E3/E4 reads stay the engine's (the `#24` carry): the client must not compute E0 from
 *   `VaultSummary`, and it does not.
 * - **gate open → the deck's placeholder.** T03's *"else → E1 Computing"* needs engine state, so O4
 *   ships the E0 branch only and leaves the other four to K2/W8.
 *
 * Both entries land here — S0's T03 `Skip` and T04 `See your sparks` (slice 4), and the `#/` launch.
 */
export function Sparks() {
  const [summary, setSummary] = useState<VaultSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const loadSummary = useCallback(async () => {
    setFailed(false);
    try {
      setSummary(await vaultSummary());
    } catch {
      // The state read failed, not the vault: the screen says so and offers the retry, never a
      // silent E0 (which would tell the user to add ideas when the truth is unknown).
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  if (summary === null) {
    if (!failed) {
      return (
        <p className="sr-only" role="status">
          Loading your sparks…
        </p>
      );
    }
    return (
      <EmptyState
        title="Sparks are out of reach."
        body="Your vault is still there — the spark state needs the summary read to answer."
        action={{ label: "Try again", onClick: () => void loadSummary() }}
      />
    );
  }

  return spreadGate(summary) ? <DeckPending /> : <ColdState summary={summary} />;
}

/**
 * The deck's seat until K2 `#36`. Deliberately the shell's existing placeholder, so `#/` still says
 * what it said before O4 wherever the gate is open.
 */
function DeckPending() {
  return (
    <section className="placeholder">
      <p className="placeholder__id">S1 · Sparks</p>
      <h1>Sparks</h1>
      <p>Placeholder — the deck is not built yet.</p>
    </section>
  );
}
