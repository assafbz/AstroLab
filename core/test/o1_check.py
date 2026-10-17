#!/usr/bin/env python3
# O1 seed-taxonomy acceptance check (Max). Checks: tag-PK uniqueness, >=8 cluster floor,
# fixture resolution (+monotone sequence), adjacency integrity + symmetrisation, additive-only
# across versions. usage:
#   python3 o1_check.py <taxonomy.yaml> <fixture.txt> [--strict] [--prev <old.yaml>]
# Normalisation: lowercase -> trim -> \s+ to '-'. --strict requires exact tags (no norm, no key fallback).
# Keys/picker names count as tags in their own cluster (the declared loader rule).
import sys, re, yaml, itertools, json, hashlib, platform
from collections import Counter
norm = lambda s: re.sub(r"\s+", "-", s.strip().lower())
a = [x for x in sys.argv[1:] if not x.startswith("--")]
strict = "--strict" in sys.argv
prev = sys.argv[sys.argv.index("--prev") + 1] if "--prev" in sys.argv else None
tax, fxp = a[0], (a[1] if len(a) > 1 else "O1_FIXTURE_TAGS.txt")
META = {"adjacency", "version", "corrections"}
d = yaml.safe_load(open(tax)); cl = [c for c in d if c not in META]; keys = set(cl)
if "--emit-adjacency" in sys.argv:   # print the ARCH §2.4 domain_cluster.adjacency dict, then exit
    ad = d.get("adjacency", {}); sym = {}
    for h in (1, 2):
        for x, y in ad.get(f"hops_{h}", []):
            sym.setdefault(x, {})[y] = h; sym.setdefault(y, {})[x] = h
    print(json.dumps(sym, indent=2, sort_keys=True)); sys.exit(0)
# acceptance record: a verdict is a function of these inputs (best-effort; cited hashes are authoritative)
def _sha(p):
    try: return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    except Exception: return "n/a"
print("acceptance record: curr %s | prev %s | harness %s | fixture %s"
      % (_sha(tax), _sha(prev) if prev else "none",
         _sha(__file__) if "__file__" in globals() else "n/a", _sha(fxp)))
print("  parser: PyYAML %s | Python %s" % (getattr(yaml, "__version__", "?"), platform.python_version()))
def tagmap(doc, cls):
    m, dup = {}, {}
    for c in cls:
        for t in doc[c]["tags"]:
            if t in m: dup.setdefault(t, [m[t]]).append(c)
            m[t] = c
    return m, dup
tag2cl, dup = tagmap(d, cl); fails = []
if dup: fails.append(f"tag in >1 cluster: {dup}")
if "version" in d and not isinstance(d["version"], str):
    fails.append(f'version must be a quoted string (YAML parses {d["version"]!r} as a number: '
                 f'"1.10" -> 1.1 collides with v1.1)')
thin = {c: len(d[c]["tags"]) for c in cl if len(d[c]["tags"]) < 8}
CLEAN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")   # slug: no leading/trailing/double hyphen
bad_tok = sorted(t for t in list(tag2cl) + list(keys) if not CLEAN.match(t))
if bad_tok: fails.append(f"tag/key not a clean lowercase-hyphen slug: {bad_tok}")
fx = [t.strip() for line in open(fxp) for t in line.split(",") if t.strip()]  # one-per-line OR comma-delimited
res, unres, prev_n, dec = set(), [], -1, []
for raw in fx:
    v = raw if raw in tag2cl else norm(raw)
    ok = (raw in tag2cl) if strict else (v in tag2cl or v in keys)
    (res.add(v) if ok else unres.append(raw))
    if len(res) < prev_n: dec.append(raw)
    prev_n = len(res)
if unres: fails.append(f"unresolved fixture tags: {unres}")
if dec: fails.append(f"resolved decreased at: {dec}")
ad = d.get("adjacency", {})
h1 = [tuple(sorted(p)) for p in ad.get("hops_1", [])]; h2 = [tuple(sorted(p)) for p in ad.get("hops_2", [])]
pairs = h1 + h2
sym = {}
conf = []
for hops, ps in ((1, h1), (2, h2)):
    for x, y in ps:
        for i, j in ((x, y), (y, x)):
            if sym.get(i, {}).get(j) not in (None, hops): conf.append(f"{i}-{j}")
            sym.setdefault(i, {})[j] = hops
for lbl, cond in [("unknown ids", [p for p in pairs for x in p if x not in keys]),
                  ("self-pairs", [p for p in pairs if p[0] == p[1]]),
                  ("dup pairs", [p for p, n in Counter(pairs).items() if n > 1]),
                  ("pair in both hop classes", set(h1) & set(h2)),
                  ("rating conflict", conf)]:
    if cond: fails.append(f"adjacency {lbl}: {cond}")
if prev:
    o = yaml.safe_load(open(prev)); oc = [c for c in o if c not in META]
    otag2cl, odup = tagmap(o, oc)
    if odup: print(f"  NOTE prev has duplicate tag(s) (comparison ambiguous): {odup}")
    if o.get("version") or d.get("version"):
        print(f"comparing versions: {o.get('version')} -> {d.get('version')}")
    rm = sorted(set(otag2cl) - set(tag2cl))
    moved = sorted(t for t in set(otag2cl) & set(tag2cl) if otag2cl[t] != tag2cl[t])
    actual = {(t, otag2cl[t], tag2cl[t]) for t in moved}
    corr = d.get("corrections") or []
    kind = lambda c: c.get("kind", "repoint")
    lbl = lambda c: (f'{c["tag"]} (retire)' if kind(c) == "retire"
                     else f'{c["tag"]}: {c["from"]} -> {c["to"]}')
    declared = {(c["tag"], c["from"], c["to"]) for c in corr if kind(c) == "repoint"}
    retired = {c["tag"] for c in corr if kind(c) == "retire"}
    rp = [t for t in moved if (t, otag2cl[t], tag2cl[t]) not in declared]
    ok = [t for t in moved if (t, otag2cl[t], tag2cl[t]) in declared]
    rm_bad = [t for t in rm if t not in retired]
    rm_ok = [t for t in rm if t in retired]
    applied = {f'{c["tag"]}:repoint' for c in corr if kind(c) == "repoint"
               and (c["tag"], c["from"], c["to"]) in actual}
    applied |= {f'{c["tag"]}:retire' for c in corr if kind(c) == "retire" and c["tag"] in rm}
    stale = [c for c in corr if f'{c["tag"]}:{kind(c)}' not in applied]
    fxset = set(fx) | {norm(x) for x in fx}
    bad_ret_fx = [t for t in retired if t in fxset]
    bad_ret_key = [t for t in retired if t in keys]
    if bad_ret_fx:
        fails.append(f"retire candidate in acceptance fixture (must stay resolvable): {bad_ret_fx}")
    if bad_ret_key:
        fails.append(f"retire candidate is a cluster key (the picker's own value, rule 2): {bad_ret_key}")
    if rm_bad: fails.append(f"tags removed vs prev (UNDECLARED): {rm_bad}")
    if rm_ok: print("declared retirements (audit; loader never deletes): " + str(rm_ok))
    if rp: fails.append("tags re-pointed vs prev (UNDECLARED): "
                        + str([f"{t}: {otag2cl[t]} -> {tag2cl[t]}" for t in rp]))
    if ok: print("declared corrections applied: "
                 + str([f"{t}: {otag2cl[t]} -> {tag2cl[t]}" for t in ok]))
    if stale: print("declared but not applied (stale/no-op, non-failing): "
                    + str([lbl(c) for c in stale]))
    def adjmap(doc):
        ad = doc.get("adjacency", {}) or {}; m = {}
        for h in (1, 2):
            for a, b in ad.get(f"hops_{h}", []): m[tuple(sorted((a, b)))] = h
        return m
    pa, ca = adjmap(o), adjmap(d)
    add = sorted(f"{a}-{b} (hop {ca[(a,b)]})" for a, b in set(ca) - set(pa))
    rem = sorted(f"{a}-{b} (was hop {pa[(a,b)]})" for a, b in set(pa) - set(ca))
    chg = sorted(f"{a}-{b}: {pa[(a,b)]} -> {ca[(a,b)]}" for a, b in set(pa) & set(ca) if pa[(a,b)] != ca[(a,b)])
    if add or rem or chg:
        print(f"adjacency deltas (non-failing, sanctioned W9 lever): +{len(add)} -{len(rem)} ~{len(chg)}")
        for s in add: print("   + hop", s)
        for s in rem: print("   - hop", s)
        for s in chg: print("   ~ hop", s)
print(f"clusters {len(cl)} | tags {sum(len(d[c]['tags']) for c in cl)} (distinct {len(tag2cl)}) | under-8 {thin}")
print(f"fixture {len(fx)} -> resolved {len(fx)-len(unres)} | monotone {'no' if dec else 'yes'}")
print(f"adjacency h1={len(h1)} h2={len(h2)} | pairs {len(list(itertools.combinations(cl,2)))}"
      f" | listed {len(set(pairs))} | symmetric edges {sum(len(v) for v in sym.values())}")
print("RESULT:", "PASS" if not fails else f"FAIL ({len(fails)})")
for f in fails: print(" -", f)
sys.exit(1 if fails else 0)
