#!/usr/bin/env python3
"""Build RADHA's calculator library from the scraped calculator data folder.

    python3 scripts/build_calculator_library.py "/path/to/ALL CALCULATOR DATA"

Merges the four sources into one de-duplicated catalog (src/data/calculator-library.json).
Every descriptive field is kept (description, inputs, formula/equations, interpretation,
evidence, notes, article, FAQs, references, codes) but the originating website is removed:
no URLs, site names, site-specific access notes, authors/reviewers or ratings.
"""
import csv
import html
import json
import os
import re
import sys

from calculator_scoring import annotate

csv.field_size_limit(10**9)

SITE_WORDS = re.compile(r"\b(md\s?calc|omni\s?calculator|omnicalculator|omni|medscape|ebm\s?calc|qxmd|calculate by qxmd)(\.com)?('s)?\b", re.I)
# Credit lines that name the site/app a calculator was taken from.
CREDIT = re.compile(r"(calculator|tool|score) (is|was) (created|developed|provided|built|powered) by|^\s*(created|provided|powered) by\b", re.I)
URL = re.compile(r"(https?://|www\.)\S+", re.I)
EMOJI = re.compile(r"[\U0001F000-\U0001FAFF☀-➿️]")


def clean(s):
    if s is None:
        return ""
    if not isinstance(s, str):
        s = str(s)
    s = html.unescape(s)
    s = URL.sub("", s)
    s = SITE_WORDS.sub("this calculator", s)
    s = re.sub(r"this calculator calculator", "this calculator", s, flags=re.I)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def jload(s, default):
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


def norm_name(n):
    # Drop only acronym brackets such as "(ANC)" or "(FENa)"; method/variant brackets
    # like "(Brooke estimate)" or "(STEMI)" identify different calculators and are kept.
    n = re.sub(r"\(\s*([A-Za-z0-9\-]{2,10})\s*\)", lambda m: " " if sum(ch.isupper() for ch in m.group(1)) >= 2 and m.group(1) not in ("STEMI", "NSTEMI", "SI") else m.group(0), n)
    n = n.lower()
    n = re.sub(r"\b(calculator|calc|the|for|of|and|&)\b", " ", n)
    n = re.sub(r"[^a-z0-9]+", " ", n)
    return " ".join(n.split())


def split_list(s, sep):
    return [x.strip() for x in (s or "").split(sep) if x.strip()]


def inp(label, type_="number", options=None, units=None, help_=""):
    d = {"label": clean(label), "type": type_}
    if options:
        d["options"] = [clean(o) for o in options]
    if units:
        d["units"] = units
    if help_:
        d["help"] = clean(help_)
    return d


# ------------------------------------------------------------------ loaders
def load_mdcalc(root):
    path = os.path.join(root, "Med Calc Data", "mdcalc-calculators-evidence-data.json")
    out = []
    for c in json.load(open(path, encoding="utf-8")):
        cat = c.get("category") or ""
        specialties, _, kinds = cat.partition("|")
        refs = [clean((r.get("group") + ": " if r.get("group") else "") + r.get("text", "")) for r in (c.get("references") or [])]
        out.append({
            "name": clean(c["name"]),
            "categories": split_list(specialties, ","),
            "types": split_list(kinds, ","),
            "description": clean(c.get("description")),
            "inputs": [inp(i.get("label"), "choice" if i.get("options") else "number", i.get("options"),
                           help_="optional" if i.get("optional") else "") for i in c.get("inputs") or []],
            "formula": clean(c.get("formula")),
            "interpretation": clean(c.get("interpretation")),
            "evidence": clean(c.get("evidence")),
            "references": [r for r in refs if r and not CREDIT.search(r)],
        })
    return out


def load_omni(root):
    path = os.path.join(root, "Omni calculator data", "omni-health-calculators-full.json")
    out = []
    for c in json.load(open(path, encoding="utf-8")):
        sections = []
        for s in c.get("articleSections") or []:
            t = clean(s.get("text"))
            if t:
                sections.append({"title": clean(s.get("title")), "text": t})
        refs = []
        for s in c.get("sources") or []:
            parts = [s.get("author"), s.get("title"), s.get("publication"), s.get("date")]
            refs.append(clean(". ".join(p for p in parts if p)))
        out.append({
            "name": clean(c["name"]),
            "categories": [EMOJI.sub("", c.get("subcategory") or "").replace(" calculators", "").strip()] if c.get("subcategory") else [],
            "types": [],
            "description": clean(c.get("description")),
            "inputs": [inp(i.get("label"), "choice" if i.get("options") else "number", i.get("options"),
                           units=[i["unitType"]] if i.get("unitType") else None, help_=i.get("helpText"))
                       for i in c.get("inputs") or [] if not i.get("outputOnly")],
            "results": [clean(r.get("label")) for r in c.get("results") or []],
            "equations": [clean(e) for e in c.get("equations") or []],
            "article": sections,
            "faqs": [{"q": clean(f.get("question")), "a": clean(f.get("answer"))} for f in c.get("faqs") or []],
            "references": [r for r in refs if r],
        })
    return out


def load_ebm(root):
    path = os.path.join(root, "ebmcalc_calculators.csv")
    out = []
    for r in csv.DictReader(open(path, encoding="utf-8-sig")):
        tags = [t for t in split_list(r.get("index_tags"), ";") if not t.startswith("fac_")]
        other = jload(r.get("other_sections"), {})
        out.append({
            "name": clean(r["name"] or r.get("title")),
            "categories": tags,
            "types": [],
            "description": "",
            "inputs": [inp(i.get("label"), units=i.get("units"), help_=("default " + i["default"]) if i.get("default") else "")
                       for i in jload(r.get("inputs"), [])],
            "results": [clean(i.get("label")) for i in jload(r.get("results"), [])],
            "equations": split_list(clean(r.get("equations")), ";"),
            "notes": clean(r.get("notes")),
            "references": [x for x in split_list(clean(r.get("references")), ";") if not CREDIT.search(x)],
            "mesh": split_list(r.get("mesh_terms"), ";"),
            "loinc": jload(r.get("loinc"), {}),
            "icd": clean(r.get("icd9") or r.get("index_icd9")),
            "extra": {clean(k): clean(v) for k, v in other.items()} if isinstance(other, dict) else {},
        })
    return out


def load_medscape(root):
    path = os.path.join(root, "medscape_calculators.csv")
    out = []
    for r in csv.DictReader(open(path, encoding="utf-8-sig")):
        refs = [clean(x.get("text") if isinstance(x, dict) else x) for x in jload(r.get("references"), [])]
        refs = [x for x in refs if not CREDIT.search(x)]
        out.append({
            "name": clean(r["name"] or r.get("title")),
            "categories": split_list(r.get("categories"), ";"),
            "types": [],
            "description": clean(r.get("description")),
            "inputs": [inp(i.get("label"), "choice" if i.get("options") else "number", i.get("options"))
                       for i in jload(r.get("inputs_in_html"), [])],
            "about": "\n".join(l for l in clean(r.get("about")).split("\n") if not CREDIT.search(l)),
            "references": [x for x in refs if x],
        })
    return out


# ------------------------------------------------------------------ merge
TEXT_FIELDS = ["description", "formula", "interpretation", "evidence", "notes", "about", "icd"]


def merge(entries):
    lib = {}
    for e in entries:
        if not e["name"]:
            continue
        k = norm_name(e["name"]) or e["name"].lower()
        if k not in lib:
            lib[k] = {"id": re.sub(r"[^a-z0-9]+", "-", k).strip("-")[:80], "name": e["name"], "aliases": [],
                      "categories": [], "types": [], "versions": []}
        m = lib[k]
        if e["name"] != m["name"] and e["name"] not in m["aliases"]:
            m["aliases"].append(e["name"])
        for f in ("categories", "types"):
            for x in e.get(f, []):
                if x and x not in m[f]:
                    m[f].append(x)
        # Each source's write-up is kept as its own version so nothing is lost or mixed up.
        v = {f: e[f] for f in e if f not in ("name", "categories", "types") and e[f] not in ("", [], {}, None)}
        if v:
            m["versions"].append(v)
    out = sorted(lib.values(), key=lambda x: x["name"].lower())
    seen = set()
    for m in out:  # unique ids
        base, i = m["id"] or "calc", 2
        while m["id"] in seen:
            m["id"] = f"{base}-{i}"; i += 1
        seen.add(m["id"])
        m["description"] = next((v["description"] for v in m["versions"] if v.get("description")), "")
    return out


def main():
    root = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, "..", "src", "data", "calculator-library.json")
    sources = [load_mdcalc(root), load_omni(root), load_ebm(root), load_medscape(root)]
    raw = sum(len(s) for s in sources)
    lib = merge([e for s in sources for e in s])
    scored = annotate(lib)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(lib, f, ensure_ascii=False, separators=(",", ":"))
    leaks = sum(1 for m in lib if URL.search(json.dumps(m)) or SITE_WORDS.search(json.dumps(m)))
    print(f"{raw} source records -> {len(lib)} unique calculators; {os.path.getsize(dest) / 1e6:.1f} MB; entries mentioning a source site: {leaks}; {scored} auto-scored")


if __name__ == "__main__":
    main()
