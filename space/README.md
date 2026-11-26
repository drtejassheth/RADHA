---
title: RADHA demo
emoji: 🩺
colorFrom: green
colorTo: blue
sdk: static
pinned: false
license: other
short_description: Lab report text to a checked summary, in your browser
tags:
  - medical
  - healthcare
  - lab-results
  - clinical-decision-support
---

# RADHA — Report Analysis & Deterministic Health Assistant (web demo)

Paste the text of a blood test report, or load a synthetic one, and RADHA:

- reads each test, its value, unit and reference range, and converts it to a standard unit;
- runs up to 83 medical calculators (eGFR, FIB-4, HOMA-IR, LDL estimates and more) on the values it found;
- applies 15 rule families to produce plain-language observations with their evidence;
- writes a list of questions to take to the doctor;
- reads patient details (history, complications, examination) from clinical documents such as a diabetes case record, each with the line it came from.

Every number comes from deterministic code, not from an AI model. Everything runs in your browser: the text you paste is not uploaded or stored.

This demo uses the same extraction, calculator and rule code as the desktop app. The **desktop app** (macOS and Windows) adds PDF and OCR reading, a verification screen, patient profiles, multi-year trends, translation into 23 languages and PDF export: [download it from GitHub](https://github.com/drtejassheth/RADHA/releases/latest).

**Decision support only. Not a diagnosis.** All demo data is synthetic.

[Source on GitHub](https://github.com/drtejassheth/RADHA) · [♥ Sponsor](https://github.com/sponsors/drtejassheth)
