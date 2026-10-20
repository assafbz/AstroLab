# `core/seed/` — the domain taxonomy (O1 · #21)

`domain-taxonomy.yaml` is the shipped vocabulary behind `domain_cluster` / `domain_map`
(`ARCHITECTURE.md` §2.4, §3.2). It is **data, not code**: the loader (`src/store/domain-seed.ts`) reads it
at boot and upserts it, so the S0 picker's own value and the ordinary tags a person types resolve
without an AI call. Nothing here is user content — the guard against synthetic seeds lives engine-side
in W7.

The file is the artifact of record, and the acceptance oracle is `test/o1_check.py` run on **this file**
(its own CI job, `o1-taxonomy`). The loader adds only what the harness cannot see: the SQL it writes.

**The app cannot read this file (#184).** A device bundle has no filesystem — Metro resolves `node:fs` to an
empty module — so the loader takes the taxonomy as **text**, and the text the bundle carries is
`src/seed/domain-taxonomy.ts`, **generated** from this YAML by `node scripts/gen-taxonomy-text.mjs` and
drift-checked by `test/taxonomy-text.test.ts` (the shipped constant must equal these bytes). Editing the YAML
without regenerating is a red test, not a silent divergence. Node-side readers — the harness, the scripts and
the loader's own tests — go through `src/seed/taxonomy-file.node.ts`, which is deliberately not on the package
entry (`core/test/boundary-node-adapter.test.ts` walks the entry's closure).

## The curation rule (artifact v1.2, unchanged)

1. **28 clusters**, named at the level a person picks as *"the domain I'm working in"* — market/industry
   space, not tech stack. The six families (Software & data, Money & commerce, Health & life, Industry
   & planet, People & society, Culture & consumer) are a **presentation grouping only**; they are not
   the hop rule and they are not stored.
2. **The S0 picker is this list** (`ARCHITECTURE.md` §3.2, option a) and **the picker's value is the
   cluster key** (`ai-ml`, `retail-commerce`). The loader registers **each cluster's key — and only the
   key — as a tag in its own cluster**, so every *picked* S0 tag is `resolved` by construction;
   `Other → free text` stays provisional and never opens the gate. The `name:` label is what S0 renders
   and is **never** registered as a tag: normalising a label mints rows like `ai-&-ml`, which are
   reachable aliases carrying an `&` that needs URL-encoding if it ever reaches `?domain=`.
3. **Tag resolution normalises:** lowercase → trim → collapse whitespace to `-`, so `machine learning`
   resolves to `machine-learning`.
4. **Adjacency carries near relations only:** `1` = near (commonly overlapping), `2` = linked, and
   **every unlisted pair is FAR (3)**. Near is deliberately conservative, because marking a pair near
   *suppresses it as cliché-risk* — over-marking shrinks the spark space. Same cluster = `0` = cliché
   (`PRD.md` §3.3 item 3).
5. **Tag map:** 246 tags, **≥ 8 per cluster** — each cluster's key plus the synonyms an ordinary user
   actually types.
6. **Acceptance stays measurable:** the 40-tag fixture (`test/o1-fixture.txt`) must all resolve, and
   `resolved` must never decrease — asserted **as a sequence**, one tag at a time.
7. **No synthetic seeds, no note import** — a shipped vocabulary, never user content.

## The loader contract

| # | rule | why |
| :-- | :-- | :-- |
| 1 | **symmetrise adjacency on write** | the file lists each of the 53 pairs once; `adjacency` is `{other_cluster_id: hops}`, so both directions are written or `distance(A,B) ≠ distance(B,A)`. 53 listed → **106** directed edges |
| 2 | **idempotent upsert** | `INSERT … ON CONFLICT DO UPDATE`, guarded so a repeat writes *nothing*; re-seeding at every boot is a no-op |
| 3 | **forward-only, additive across versions** | it never deletes and never *silently* re-points. A tag that already maps elsewhere must be declared in `corrections` — an undeclared re-point throws and the transaction rolls back |
| 4 | **key-only registration** | rule 2 above |
| 5 | **seed-lint** `^[a-z0-9]+(-[a-z0-9]+)*$` | over the **map** (`tag2cl ∪ keys`) **only** — never over `corrections`, because a retirement names a tag precisely because it is not clean. No leading, trailing or doubled hyphen: `norm("AI - ML")` is `ai---ml`, the `&`-class's sibling |
| 6 | **validate before writing** | `version` must be a quoted string; no tag in two clusters; a cluster key cannot also be another cluster's tag; adjacency ids known, no self-pairs, no pair listed twice |

## Shipping a new version

- **v1.2 ships unversioned.** The `version:` and `corrections:` keys are reserved for the first
  *versioned* ship, **v1.3**. A version is an **identifier, not a number** — always quote it
  (`version: "1.3"`), or YAML parses `1.10` as `1.1` and two versions collide.
- **A re-point is declared, atomically, with the version it belongs to:**

  ```yaml
  version: "1.3"
  corrections:
    - {tag: streaming, from: media-entertainment, to: data-infra, reason: "mis-clustered"}
  ```

  A declaration that names no actual move is a non-failing no-op ("stale"); the harness prints it.
- **A retirement is audit-only.** The loader never deletes, so dropping a tag from the file stops future
  seeding and nothing else — a row already in a database survives. The hatch is therefore only
  effective **pre-first-seed**, which is why prevention (rule 5) is the load-bearing half. Cleaning a
  database would need a declared-retirement `DELETE` exception to rule 3 — recorded, not taken.
- **Adjacency edits are the sanctioned recalibration lever** (W9): a hop re-grade does not touch
  `resolved`, so it is allowed and the harness **prints** the delta (non-failing) rather than blocking it.
- Update the fixture if a tag it names changes — it is the guard that the ordinary tags stay resolvable.

## Running the harness

```sh
python3 core/test/o1_check.py core/seed/domain-taxonomy.yaml core/test/o1-fixture.txt
python3 core/test/o1_check.py core/seed/domain-taxonomy.yaml core/test/o1-fixture.txt --strict  # must FAIL
python3 core/test/o1_check.py core/seed/domain-taxonomy.yaml core/test/o1-fixture.txt --prev <old.yaml>
```

The run prints an acceptance record — `(curr, prev, harness, fixture)` hashes plus the parser versions —
so a pasted log identifies the bytes it is a verdict on.
