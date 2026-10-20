import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { boot, type Booted } from "./bootstrap";
import { Sparks } from "./screens/Sparks";
import { tokens } from "./theme/tokens";

/**
 * The shell: it runs the boot sequence and renders the screen the vault answers for
 * (`docs/ARCHITECTURE.md` v2 §1; `FLOW.md` §2.1, §4.1).
 *
 * **The boot is not a splash screen and does not await the engine.** It opens the vault, migrates and
 * seeds, and picks S0 or S1 — all local reads. There is no spinner (banned, `DESIGN.md` §4 *Loaders*),
 * no timer, and no provider on this path: a run is never awaited by a read path (§4.1), which is also
 * why the shell renders while the engine is down.
 *
 * Task 1 renders **S0 and S1 only**, with placeholders. The bottom tab bar and the remaining surfaces
 * (S2–S6) land with Tasks 3–6; the navigation frame is deferred until there are screens to frame — a
 * recorded deviation, since the plan's Task 1 named "navigation" while nothing reviewable precedes the
 * screens.
 */
export default function App(): React.JSX.Element {
  const [booted, setBooted] = useState<Booted | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setBooted(boot());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  if (error !== null) {
    return (
      <Frame id="boot" title="Astrolab">
        The vault could not be opened: {error}
      </Frame>
    );
  }
  if (booted === null) {
    return (
      <Frame id="boot" title="Astrolab">
        Opening your vault…
      </Frame>
    );
  }
  return booted.start === "S1" ? (
    <Sparks />
  ) : (
    <Frame id="S0" title="Astrolab">
      Add a few ideas across unrelated domains to see sparks.
    </Frame>
  );
}

/** S0's placeholder until Task 3 — the same token frame the real screens keep. */
function Frame({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.canvas}>
      <Text style={styles.id}>{id}</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.note}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    backgroundColor: tokens.canvas,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    gap: 8,
  },
  id: {
    color: tokens.faint,
    fontSize: 12,
    letterSpacing: 1,
  },
  title: {
    color: tokens.ink,
    fontSize: 21,
    fontWeight: "600",
  },
  note: {
    color: tokens.muted,
    fontSize: 15,
    textAlign: "center",
  },
});
