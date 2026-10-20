import { StyleSheet, Text, View } from "react-native";

import { tokens } from "../theme/tokens";

/**
 * S1 — the deck's **placeholder** (`DESIGN.md` §9). This is what the shell boots to so M1 has a
 * surface to render; Task 4 replaces this file with the real deck (band, card, actions, undo).
 *
 * It renders only tokens — no business logic, no `core` import — which is the shape every screen keeps
 * (plan invariant 4): the composition root holds the rules, the screens hold the pixels.
 */
export function Sparks(): React.JSX.Element {
  return (
    <View style={styles.canvas}>
      <Text style={styles.id}>S1</Text>
      <Text style={styles.title}>Sparks</Text>
      <Text style={styles.note}>The deck lands here.</Text>
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
  },
});
