#!/usr/bin/env node
// G5 (#57): guard the `§X.Y item N` citation form.
//
// G4 (#52) re-pointed 66 item-level citations from third-level sub-anchors
// (`§3.3.2`, `§8.4`) to the item form. Nothing stopped the old form from coming
// back; this job does. Contract pinned on #57:
//
//   - anchor: `§` **and** `Sec.`
//   - singular and plural: `§3.3 item 3` · `§3.3 items 2–4`
//   - a range expands to its **span**: `items 2–4` names items 2, 3, 4
//   - tier 1: the target section resolves; tier 2: item N <= the section's
//     **top-level** item count (its own list, not every numbered line beneath it)
//   - revision ids (`r3.x.y`, `r3.x`) are not refs and are ignored
//
// Usage: node scripts/lint-citations.mjs [--self-check]

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The five sections whose items are cited by *position*. A sub-anchor pointing
// into one of these (§A.B.C, or §8.N / §12.N for the two top-level ones) is the
// old form this lint rejects. Section → the document that owns it.
const TARGETS = {
  3.2: "docs/PRD.md",
  3.3: "docs/PRD.md",
  3.4: "docs/PRD.md",
  8: "docs/VISION.md",
  12: "docs/ARCHITECTURE.md",
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "artifacts", ".agents"]);

// `items 2–4` (en dash) and `items 2-4` (hyphen) both expand to 2, 3, 4.
const NEW_REF = /(?:§|Sec\.)\s?(\d+(?:\.\d+)*)\s+items?\s+(\d+)(?:\s*[–-]\s*(\d+))?/g;
const ANY_REF = /(?:§|Sec\.)\s?(\d+(?:\.\d+)*)/g;

const esc = (s) => s.replace(/\./g, "\\.");

// Tier 1 on a real doc: find the section heading, then count the section's own
// list. Column-0 numbered lines only, so a nested list does not inflate the count.
function topLevelItemCount(docText, section) {
  const heading = new RegExp(`^#{1,6}\\s+${esc(section)}(?:\\s|\\.(?!\\d)|$)`);
  const lines = docText.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let count = 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (/^\d+\.\s/.test(lines[i])) count += 1;
  }
  return count;
}

function lintText(name, text, counts) {
  const violations = [];
  let tokens = 0;
  let targets = 0;

  text.split("\n").forEach((line, index) => {
    const at = `${name}:${index + 1}`;

    for (const match of line.matchAll(NEW_REF)) {
      tokens += 1;
      const [, section, first, last] = match;
      const doc = TARGETS[section];
      if (!doc) {
        violations.push(`TIER1 ${at} §${section} — not a numbered-list target`);
        continue;
      }
      const lo = Number(first);
      const hi = last ? Number(last) : lo;
      if (hi < lo) {
        violations.push(`RANGE ${at} §${section} items ${lo}–${hi} — descending`);
        continue;
      }
      const max = counts[section];
      for (let n = lo; n <= hi; n += 1) {
        targets += 1;
        if (max === null) {
          violations.push(`TIER1 ${at} §${section} — section does not resolve in ${doc}`);
        } else if (n < 1 || n > max) {
          violations.push(`TIER2 ${at} §${section} item ${n} — out of range (1..${max})`);
        }
      }
    }

    for (const match of line.matchAll(ANY_REF)) {
      const parts = match[1].split(".");
      const parent = parts.slice(0, -1).join(".");
      if (Object.hasOwn(TARGETS, parent)) {
        violations.push(
          `OLD   ${at} §${match[1]} — third-level sub-anchor; use \`§${parent} item N\``,
        );
      }
    }
  });

  return { violations, tokens, targets };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

function lintRepo() {
  const counts = {};
  for (const [section, doc] of Object.entries(TARGETS)) {
    counts[section] = topLevelItemCount(readFileSync(join(ROOT, doc), "utf8"), section);
  }

  const violations = [];
  let tokens = 0;
  let targets = 0;
  const files = walk(ROOT).sort();
  for (const file of files) {
    const name = relative(ROOT, file);
    const result = lintText(name, readFileSync(file, "utf8"), counts);
    violations.push(...result.violations);
    tokens += result.tokens;
    targets += result.targets;
  }
  return { files: files.length, tokens, targets, violations };
}

// Assert-based self-check: the examples in the #57 contract, both ways.
function selfCheck() {
  const counts = { 3.2: 3, 3.3: 8, 3.4: 3, 8: 4, 12: 6 };
  const cases = [
    ["singular item form", "(`PRD.md` §3.3 item 3)", 0, 1, 1],
    ["plural span form", "(`PRD.md` §3.3 items 2–4)", 0, 1, 3],
    ["hyphen span form", "(`PRD.md` §3.3 items 2-4)", 0, 1, 3],
    ["Sec. anchor", "(Sec. 3.3 item 5)", 0, 1, 1],
    ["top-level form", "(`VISION.md` §8 item 4)", 0, 1, 1],
    ["old sub-anchor (PRD)", "(`PRD.md` §3.3.2)", 1, 0, 0],
    ["old two-part (VISION)", "(`VISION.md` §8.4)", 1, 0, 0],
    ["old two-part (ARCH)", "(§12.6)", 1, 0, 0],
    ["out of range", "(`PRD.md` §3.3 item 9)", 1, 1, 1],
    ["descending range", "(`PRD.md` §3.3 items 4–2)", 1, 1, 0],
    ["heading ref is not an item ref", "(`ARCHITECTURE.md` §3.2, §4)", 0, 0, 0],
    ["non-target item form", "(§4.2 item 3)", 1, 1, 0],
    ["revision id is ignored", "landed in `FLOW.md` r3.2.1 (§12 item 4)", 0, 1, 1],
  ];

  let failed = 0;
  for (const [label, text, wantV, wantT, wantN] of cases) {
    const got = lintText("self-check", text, counts);
    const ok = got.violations.length === wantV && got.tokens === wantT && got.targets === wantN;
    if (ok) {
      console.log(`✓ ${label}`);
    } else {
      failed += 1;
      console.error(
        `✗ ${label}: ${got.violations.length} violations / ${got.tokens} tokens / ${got.targets} targets` +
          ` — wanted ${wantV} / ${wantT} / ${wantN}`,
      );
    }
  }
  console.log(failed === 0 ? "\nself-check: all cases pass" : `\nself-check: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv.includes("--self-check")) {
  selfCheck();
} else {
  const { files, tokens, targets, violations } = lintRepo();
  console.log(
    `citation lint — ${files} .md files · ${tokens} item-form tokens · ${targets} span-expanded targets`,
  );
  if (violations.length > 0) {
    console.error(`\n${violations.length} violation(s):\n${violations.join("\n")}`);
    process.exit(1);
  }
  console.log("0 violations — no third-level sub-anchors");
}
