#!/usr/bin/env python3
"""Content policy for RADHA's calculator library.

Applied at the end of build_calculator_library.py, and runnable on its own:

    python3 scripts/library_policy.py src/data/calculator-library.json

1. Long-form prose written by the source websites (About, Evidence, Articles, FAQs,
   Notes, Additional information) is not shipped. Entries keep only functional content:
   name, short description, inputs, formula/equations, interpretation bands, results,
   references and codes.
2. Instruments whose rights holders require a licence or permission for use in software
   are excluded. Add a pattern here (with the reason) before adding such a tool back.
3. Entries left with nothing to calculate (no inputs, formula or equations) are dropped.
"""
import json
import re
import sys

PROSE_FIELDS = ("about", "article", "evidence", "faqs", "notes", "extra")

# Licensed or permission-only instruments (name or alias, case-insensitive).
LICENSED = [
    (r"montreal cognitive|\bmoca\b", "MoCA: MoCA Cognition licence and training"),
    (r"positive and negative syndrome|\bpanss\b", "PANSS: licensed through Mapi Research Trust"),
    (r"copd assessment test", "CAT: GSK copyright and trademark; electronic use by agreement"),
    (r"epworth", "Epworth Sleepiness Scale: licence through Mapi Research Trust"),
    (r"braden", "Braden Scale: licence from Health Sense Ai"),
    (r"clinical frailty", "Clinical Frailty Scale: Dalhousie University permission"),
    (r"insomnia severity", "Insomnia Severity Index: licence through Mapi Research Trust"),
    (r"pittsburgh sleep", "PSQI: University of Pittsburgh permission"),
    (r"\biief|international index of erectile", "IIEF: licence through Mapi Research Trust"),
    (r"edmonton frail", "Edmonton Frail Scale: University of Alberta licence"),
    (r"clinical dementia rating", "CDR: Washington University permission"),
    (r"seattle heart failure", "Seattle Heart Failure Model: University of Washington licence"),
    (r"rome iv", "Rome IV criteria: Rome Foundation permission"),
    (r"diabetes distress", "Diabetes Distress Scale: Behavioral Diabetes Institute licence"),
    (r"columbia suicide|c-ssrs", "C-SSRS: Columbia permission for commercial/electronic use"),
    (r"caprini", "Caprini score: author's permission"),
    (r"fibromyalgia impact|\bfiqr\b", "FIQR: author's permission"),
    (r"expanded disability status", "EDSS: Neurostatus licence"),
]
_LICENSED = re.compile("|".join(f"(?:{p})" for p, _ in LICENSED), re.I)


def is_licensed(entry):
    return any(_LICENSED.search(n) for n in [entry["name"], *entry.get("aliases", [])])


def apply_policy(lib):
    """Filter the library in place-safe fashion; returns (new_lib, stats)."""
    out, removed, emptied, chars = [], [], 0, 0
    for e in lib:
        if is_licensed(e):
            removed.append(e["name"])
            continue
        versions = []
        for v in e["versions"]:
            for f in PROSE_FIELDS:
                if f in v:
                    chars += len(json.dumps(v.pop(f), ensure_ascii=False))
            if v.get("inputs") or v.get("formula") or v.get("equations"):
                versions.append(v)
        if not versions:
            emptied += 1
            continue
        e["versions"] = versions
        e["description"] = next((v["description"] for v in versions if v.get("description")), e.get("description", ""))
        out.append(e)
    return out, {"licensed_removed": removed, "no_content_removed": emptied, "prose_chars_removed": chars}


if __name__ == "__main__":
    path = sys.argv[1]
    lib = json.load(open(path, encoding="utf-8"))
    before = len(lib)
    lib, st = apply_policy(lib)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(lib, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{before} -> {len(lib)} calculators; {len(st['licensed_removed'])} licensed instruments removed; "
          f"{st['no_content_removed']} entries with nothing to calculate removed; "
          f"{st['prose_chars_removed']:,} characters of website prose removed")
