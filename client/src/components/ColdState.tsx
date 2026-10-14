import type { VaultSummary } from "../api/types.ts";
import { StarChart } from "./StarChart.tsx";

/**
 * S1's **E0 Cold** composition (`DESIGN.md` §9 E0; `FLOW.md` §5.2) — what S1 shows when the vault is
 * below the spark floor.
 *
 * *"The composition is progress, not failure"*: the same mark S0 renders (`StarChart`), the one-line
 * reason, and a single brass **Add idea** CTA (→ S2). No error, no spinner, no global empty state —
 * E0 is a *breadth* state, and the only lever it offers is adding an idea from another field.
 *
 * The state is a **prop-fed** component: it renders a summary and reads nothing itself, so the
 * engine's own E0/E1/E2/E3/E4 read (W8 `#33`, K2 `#36`) can drive it later without rework here.
 */
export function ColdState(props: { summary: VaultSummary }) {
  return (
    <section className="empty" aria-label="Sparks need more domains">
      <StarChart summary={props.summary} />
      <p className="empty__body">Sparks pair distant domains — add ideas from another field.</p>
      {/* The widening CTA: the one lever E0 offers (`FLOW.md` §5.2) — S2's Add idea. */}
      <a className="button" href="#/capture">
        Add idea
      </a>
    </section>
  );
}
