"""Derive executable point-score specs for library calculators from their published points tables.

Used by build_calculator_library.py. A calculator gets a `score` spec only when the formula text
says the score is a sum of points AND every option of every input could be matched,
unambiguously, to a points value in the table. Anything that does not parse cleanly is left
as reference-only, so a wrong score is never produced from a half-parsed table.

    score = {"items": [{"input": i, "points": [p per option]}], "bands": {...} | absent}
"""
import re
from difflib import SequenceMatcher

NUM = re.compile(r"^[+−\-–]?\s*\d+(\.\d+)?$")
ADDITIVE = re.compile(
    r"addition of|sum of|\badd(ed|ing)?\b.{0,40}\bpoints|points (are|were) (summed|added)|total (score|points)|"
    r"calculated by (adding|summing)|summ?ing (the|all)|score is the sum|points? for each", re.I)
SUP = re.compile(r"<sup>.*?</sup>", re.I | re.S)
TAG = re.compile(r"<[^>]+>")
# Abbreviations used in input labels but spelled out in the points tables.
ABBREV = [("chf", "congestive heart failure"), ("htn", "hypertension"), ("dm", "diabetes mellitus"), ("hx", "history")]
YES_NO = [{"no", "yes"}, {"absent", "present"}]


def num(s):
    return float(s.replace("−", "-").replace("–", "-").replace(" ", ""))


def norm(s):
    s = SUP.sub("", s or "")
    s = TAG.sub("", s)
    s = s.replace("–", "-").replace("—", "-").replace("−", "-").replace("’", "'")
    s = re.sub(r"[*†‡§¶]+", "", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    for short, full in ABBREV:
        s = re.sub(rf"\b{short}\b", full, s)
    return s.rstrip("?:. ")


def strip_footnote(s):
    # "Favorable1" in a table row stands for "Favorable" with footnote 1.
    return re.sub(r"(?<=[a-z)])\d$", "", s)


def cells_of(text):
    out = []
    for c in (text or "").split("|"):
        c = c.strip()
        if not c:
            continue
        # "Interpretation:\n\nScore" -> keep the last line (the table header cell).
        lines = [l.strip() for l in c.split("\n") if l.strip()]
        out.append(lines[-1] if lines else c)
    return out


def sim(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b or strip_footnote(b) == a or strip_footnote(a) == b:
        return 1.0
    r = SequenceMatcher(None, a, b).ratio()
    # Table rows often add a qualifier: "<65" vs "<65 years old".
    if len(a) >= 2 and (b.startswith(a + " ") or b.startswith(a + ",") or b.startswith(a + " (")):
        r = max(r, 0.9)
    # One extra word in the table: "Diabetes history" vs "Diabetes mellitus history".
    ta, tb = a.split(), b.split()
    if len(ta) >= 2 and len(tb) == len(ta) + 1 and all(t in tb for t in ta) and [t for t in tb if t in ta] == ta:
        r = max(r, 0.85)
    return r


def column_header(cells, before, opts):
    """Tables laid out as columns ("Criterion | No | Yes" then "x | 0 | +1"): the option header row."""
    want = [norm(o) for o in opts]
    for k in range(before - len(want), -1, -1):
        got = [norm(c) for c in cells[k:k + len(want)]]
        if sorted(got) == sorted(want):
            return got
    return None


def block_after(cells, i, opts=()):
    """(option text, points) pairs listed under the criterion at cells[i]; or a single points value."""
    run = []
    while i + 1 + len(run) < len(cells) and NUM.match(cells[i + 1 + len(run)]):
        run.append(num(cells[i + 1 + len(run)]))
    if len(run) >= 2:
        head = column_header(cells, i, opts) if len(run) == len(opts) else None
        return None, list(zip(head, run)) if head else []
    if len(run) == 1:
        return run[0], []
    pairs, j = [], i + 1
    while j + 1 < len(cells) and not NUM.match(cells[j]) and NUM.match(cells[j + 1]):
        pairs.append((cells[j], num(cells[j + 1])))
        j += 2
    return None, pairs


def score_spec(version, fixes=None):
    inputs = version.get("inputs") or []
    formula = version.get("formula") or ""
    if not inputs or not ADDITIVE.search(formula[:600]):
        return None
    if any(i.get("type") != "choice" or not i.get("options") for i in inputs):
        return None
    cells = cells_of(formula)
    if len(cells) < 4:
        return None
    used, items = set(), []
    for idx, inp in enumerate(inputs):
        cand = sorted(((sim(inp["label"], c), k) for k, c in enumerate(cells) if k not in used and not NUM.match(c)), reverse=True)
        cand = [(s, k) for s, k in cand if s >= 0.82]
        # Among equally good label matches take the earliest unused (repeated labels, in order).
        if not cand:
            return None
        best = max(s for s, _ in cand)
        k = min(k for s, k in cand if s == best)
        opts = inp["options"]
        single, pairs = block_after(cells, k, opts)
        if single is not None:
            if {norm(o) for o in opts} not in YES_NO:
                return None
            pts = [single if norm(o) in ("yes", "present") else 0.0 for o in opts]
        else:
            pts = []
            for o in opts:
                scored = sorted(((sim(o, t), n) for t, n in pairs), key=lambda x: -x[0])
                if not scored or scored[0][0] < 0.82:
                    return None
                # Ambiguous: two different point values match the option equally well.
                if len(scored) > 1 and scored[1][0] == scored[0][0] and scored[1][1] != scored[0][1]:
                    return None
                pts.append(scored[0][1])
        fix = (fixes or {}).get(inp["label"])
        if fix:
            pts = [fix[o] for o in opts]
        if len(set(pts)) == 1:
            return None  # an answer that never changes the score means the table was misread
        used.add(k)
        items.append({"input": idx, "points": [int(p) if p == int(p) else p for p in pts]})
    spec = {"items": items}
    bands = band_table(version.get("interpretation") or "")
    if bands:
        spec["bands"] = bands
    return spec


RANGE = re.compile(
    r"^(?P<op>[<>≤≥]=?|=)?\s*(?P<a>-?\d+(\.\d+)?)\s*(?:(?P<plus>\+)|\s*(?:-|–|to)\s*(?P<b>-?\d+(\.\d+)?))?\s*(points?|pts?)?$", re.I)


def parse_range(s):
    s = norm(s).replace(" ", " ")
    m = RANGE.match(s)
    if not m:
        return None
    a = float(m.group("a"))
    op = m.group("op")
    if m.group("b") is not None:
        return [a, float(m.group("b"))]
    if m.group("plus") or op in (">=", "≥"):
        return [a, None]
    if op == ">":
        return [a, None, "gt"]
    if op in ("<=", "≤"):
        return [None, a]
    if op == "<":
        return [None, a, "lt"]
    return [a, a]


def band_table(text):
    cells = cells_of(text)
    for start in range(1, min(len(cells), 8)):
        if parse_range(cells[start]) is None:
            continue
        head = cells[:start]
        if any(parse_range(h) for h in head):
            return None
        ncol = len(head)
        if ncol < 2:
            return None
        rows, j = [], start
        while j + ncol <= len(cells) and parse_range(cells[j]) is not None:
            rows.append(cells[j:j + ncol])
            j += ncol
        if len(rows) < 2:
            return None
        return {"head": head, "rows": [{"range": parse_range(r[0]), "cells": r} for r in rows]}
    return None


# Typos in the source tables, checked against the original publications: (id, input label) -> points.
FIXES = {
    # Wells 2003: calf swelling >3 cm scores +1 only when present (the source table lists No = 1).
    ("wells-criteria-dvt", "Calf swelling >3 cm compared to the other leg"): {"No": 0, "Yes": 1},
}


def annotate(lib):
    n = 0
    for e in lib:
        for v in e["versions"]:
            fixes = {label: pts for (cid, label), pts in FIXES.items() if cid == e["id"]}
            s = score_spec(v, fixes)
            if s:
                v["score"] = s
                n += 1
    return n


if __name__ == "__main__":
    # Re-annotate the built library in place:  python3 scripts/calculator_scoring.py src/data/calculator-library.json
    import json, sys
    path = sys.argv[1]
    lib = json.load(open(path, encoding="utf-8"))
    for e in lib:
        for v in e["versions"]:
            v.pop("score", None)
    n = annotate(lib)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(lib, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{n} calculators can be scored from their points tables")
