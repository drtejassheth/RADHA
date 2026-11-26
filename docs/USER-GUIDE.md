# RADHA — Illustrated User Guide

**R**eport **A**nalysis & **D**eterministic **H**ealth **A**ssistant turns blood-test PDFs into a verified, easy-to-read health summary on your own computer.

![RADHA walkthrough](images/radha-walkthrough.gif)

> All screenshots use RADHA's built-in **demo patient** (synthetic data). RADHA supports understanding and consultation preparation — it does **not** diagnose. Always follow your medical practitioner's advice.

**Contents**
1. [Install and open](#1-install-and-open)
2. [Quick start in 5 steps](#2-quick-start-in-5-steps)
3. [Feature tour](#3-feature-tour)
4. [How a report is generated](#4-how-a-report-is-generated)
5. [The exported PDF report](#5-the-exported-pdf-report)
6. [Settings: AI and translation services](#6-settings-ai-and-translation-services)
7. [Privacy and safety](#7-privacy-and-safety)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Install and open

1. Download the latest **`RADHA-…-arm64.dmg`** from the [Releases](../../../releases) page (Apple-silicon Macs).
2. Open the DMG and drag **RADHA** into **Applications**.
3. First launch only (the app is not code-signed, so macOS quarantines it after download): if macOS says RADHA can't be opened or is damaged, open **Terminal** (Applications → Utilities), paste this command, press Return, and open RADHA again:

   ```bash
   xattr -dr com.apple.quarantine /Applications/RADHA.app
   ```

   It only removes the "downloaded from the internet" flag from RADHA. Alternatively, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.
4. Optional one-click helpers in the repository: **`Open RADHA.command`** and **`Close RADHA.command`**.

**Optional extras**
- **Offline PDF reading:** on the **Ingest reports** screen click **Install essentials** (≈ 0.2 GB) or **Install all local engines** (≈ 2.2 GB). RADHA sets up its own private Python and downloads the models — nothing to configure. See [Local engines](#311-local-engines--one-click-install-and-tuning).
- **Online services:** add a Sarvam AI key (parsing and translation) and any AI provider keys in **Settings**. Free options need no key.

---

## 2. Quick start in 5 steps

| Step | What you do | Where |
|---|---|---|
| 1 | Drag and drop one or more PDF reports (or click **Load demo reports**) | **Ingest reports** |
| 2 | Check the extracted values, correct anything, choose the patient, then click **Confirm & analyse** | **Verify values** |
| 3 | Read the summary, lab results, calculators and findings | **Results** section |
| 4 | Choose a **Language** (and the translation service next to it) if you want | Top bar |
| 5 | Click **Export PDF** and take it to your doctor | Top right |

---

## 3. Feature tour

### 3.1 Ingest reports — online or 100% offline

Drop PDFs onto the box, or browse. Choose how they are read:

| Engine | Where it runs | Best for |
|---|---|---|
| **Sarvam AI** | Online (needs key) | Complex layouts, Indian lab formats |
| **Auto** (recommended) | Offline | Reads the PDF's text layer; only pages without text (scanned) go to OCR — digital, scanned and mixed reports |
| **pdfplumber / PyMuPDF** | Offline | Digital (text) PDFs — instant and exact |
| **Apple Vision OCR** | Offline (Mac) | Scanned reports — fast, accurate, very light |
| **EasyOCR** | Offline | Scanned or photographed reports; reads Hindi, Marathi, Bengali, Tamil, Telugu, Kannada |
| **Docling (IBM)** | Offline | Layout-aware tables |
| **Marker (Surya)** | Offline | Difficult layouts |

![Ingest screen](images/01-ingest.png)

### 3.1.1 Local engines — one-click install and tuning

Every local engine can be installed from the **Parsing engine** panel. Each card shows the download size and how much memory it needs while reading a report. **Install essentials** gets the light engines (pdfplumber, PyMuPDF, Apple Vision OCR); **Install all local engines** adds EasyOCR, Docling and Marker. Progress is shown live and you can keep using the app or cancel.

![Install local engines](images/17-engines-install.png)

Measured on an Apple-silicon Mac with 8 GB RAM, reading a real 9-page lab report (51 tests) as the original digital PDF and as a scanned (image-only) copy:

| Engine | Disk (packages + models) | Peak memory | Digital PDF | Scanned copy | Tests found in the scan |
|---|---|---|---|---|---|
| **Auto** (text layer + Apple Vision) | — | 0.1 GB / 0.9 GB | 0.5 s | 12 s | 50 of 51 |
| pdfplumber | ≈ 35 MB | 0.1 GB | 0.5 s | no text | — |
| PyMuPDF | ≈ 110 MB | 0.3 GB | 0.5 s | no text | — |
| Apple Vision OCR | ≈ 60 MB | 0.9 GB | 11 s (OCRs every page) | 12 s | 50 of 51 |
| EasyOCR | ≈ 1.0 GB (incl. PyTorch) | 1.4 GB | 83 s (OCRs every page) | 91 s | 47 of 51 |
| Docling | ≈ 1.6 GB (incl. PyTorch) | 1.7 GB | 24 s | 44 s | 50 of 51 |
| Marker (fast mode) | ≈ 1.0 GB (incl. PyTorch) | 1.7 GB | 9 s | 22 s | 51 of 51 |

Docling and Marker figures include RADHA's gap filling (on by default). For digital PDFs the text readers are exact, instant and use the least memory, which is why **Auto** is recommended: it only uses OCR for pages that have no text.

PyTorch is shared, so installing everything takes about 2.2 GB, not the sum. On 8 GB Macs, **low-memory mode** is switched on automatically.

**Tune** on any installed engine opens its settings, with a **Test on a report…** button that shows how many tests were recognised and the text the engine read:

| Setting | Engines | What it does |
|---|---|---|
| Pages to read | all | Skip cover letters or graphs (e.g. `1-3,5`) |
| Processor | EasyOCR, Docling, Marker | Automatic, Apple GPU (Metal) or CPU only |
| Low-memory mode, CPU threads | EasyOCR, Docling, Marker | Smaller batches for 8 GB machines |
| Text-layer reader, OCR for scanned pages, scanned-page threshold | Auto | Which readers Auto uses, and when a page counts as scanned |
| Line tolerance, column gap | pdfplumber, PyMuPDF | Keep a test name and its value on one line; split columns |
| Recognizer (Vision + Live Text), level, languages, DPI, language correction | Apple Vision | Live Text catches lone digits such as a "0" result; correction off keeps HbA1c, SGPT, TSH exact |
| Languages, DPI, image enhancement, rotation, detection thresholds, magnification | EasyOCR | Faint, small, sideways or photographed reports |
| OCR mode and engine, table mode, cell matching, image scale | Docling | Table accuracy versus speed |
| Mode (fast / text only / balanced / accurate), force OCR | Marker | Speed versus the large Surya vision model |
| Fill gaps with RADHA's line reader | Docling, Marker | Recovers tests and patient details they miss |

Every OCR result is also cleaned automatically: `O` read for zero (`O to 40`), `HL`/`pL` for µL, `mg/dI`, full-width `＜`, accented letters (`Ürea`) and dates such as `Oct 14,2026`.

| Installing | Tune and test |
|---|---|
| ![Installing](images/18-engines-installing.png) | ![Tune](images/19-engine-tune.png) |

### 3.2 Verify values (human in the loop)

Nothing is analysed until you approve it.
- **Each row:** the test, the value **as printed**, the unit, the reference range, and the **normalised** value in one standard unit. For example, mmol/L becomes mg/dL and lakhs/cumm becomes 10³/µL.
- **Checking against the PDF:** the original report text is shown on the right for comparison.
- **Patient:** the report is matched to an existing patient by lab ID or name, or a new profile is created. Date of birth, height and weight are read when they are printed.
- **Editing:** fix any value, unit or range, add tests, or untick a row to leave it out.

![Verify screen](images/02-verify.png)

### 3.3 Summary dashboard

The dashboard shows:
- the patient profile;
- the total number of tests, with counts of **Normal / Low / High / Critical** results;
- a distribution chart and out-of-range counts by panel;
- the top findings and flagged calculators.

![Dashboard](images/03-dashboard.png)

### 3.4 Lab results

Every biomarker is listed, grouped by panel, with the result, unit, reference range, a **position bar** and a colour-coded status. The **Out of range** filter shows only abnormal results.

| All results | Out of range only |
|---|---|
| ![Lab results](images/04-labs.png) | ![Abnormal only](images/04b-labs-abnormal.png) |

### 3.5 Medical calculators

- **83 executable calculators**, written from the original publications and unit-tested against worked examples. Among them: eGFR (CKD-EPI 2021, 2009, cystatin C), MDRD, Cockcroft-Gault, KFRE, FIB-4, APRI, NAFLD fibrosis score, MELD / MELD-Na / MELD 3.0, Child-Pugh, ALBI, HOMA-IR, QUICKI, TyG, Sampson and Friedewald LDL, ASCVD, NLR, thalassaemia indices, corrected calcium and sodium, anion gap, BMI and BSA.
- **Results:** calculators whose inputs are all in the report run automatically.
- **Needs your input:** values a lab report doesn't contain, such as blood pressure or INR, can be typed in once.
- **Not available:** lists exactly what is missing for each remaining calculator.

| Results | Needs your input |
|---|---|
| ![Calculators](images/05-calculators.png) | ![Calculator inputs](images/06-calculators-input.png) |

**Calculator details and library.** **ⓘ Calculator details** opens the details of a calculator: description, inputs, formula, interpretation and references. The **Calculator library** lets you search all 1,931 calculators.

| Calculator details | Library |
|---|---|
| ![Calculator details](images/07-calculator-details.png) | ![Calculator library](images/08-library.png) |

### 3.6 Clinical analysis and questions for your doctor

Deterministic rules turn the verified values into findings. Each finding comes with **evidence** from your report, a severity label (*Discuss promptly / Discuss soon / Keep an eye on*) and suggested next steps.

![Clinical analysis](images/09-analysis.png)

**Questions to ask your doctor** is a numbered list, grouped by topic. It covers:
- every finding;
- every other out-of-range result;
- borderline values close to a limit;
- flagged calculators;
- changes since your last report;
- common tests the report did not include.

![Questions for the doctor](images/10-questions.png)

### 3.7 AI narrative summary (optional)

The AI narrative is an optional plain-language summary. You choose who writes it:

| Provider | Key |
|---|---|
| **Pollinations** | Free, no key needed |
| **Ollama** | Runs locally on your computer, no key needed |
| **Sarvam AI** | Your Sarvam key |
| **ChatGPT (OpenAI)** | Your OpenAI key |
| **Google Gemini** | Your Gemini key |
| **Claude (Anthropic)** | Your Anthropic key |
| **Custom** | Any OpenAI-compatible service |

Only de-identified results are sent (never the name or ID). The rule-based findings above remain the source of truth.

![AI narrative](images/11-ai-summary.png)

### 3.8 Multi-year trends

With reports from more than one date, the Trends screen shows:
- a side-by-side table of every test, with the % change from the previous report and an **Improving / Worsening / Stable** label;
- a chart for the selected test against its reference limits.

Reports from the same day are merged into one visit.

![Trends](images/12-trends.png)

### 3.9 Your language

Choose from 13 Indian languages (Hindi, Gujarati, Bangla, Telugu, Tamil, Marathi, Kannada, Malayalam, Punjabi, Odia, Urdu, Assamese, Nepali) and 10 world languages. Pick the translation service next to the language:

| Service | Cost / key |
|---|---|
| **Google Translate** | Free, no key |
| **MyMemory** | Free, no key (daily limit) |
| **Sarvam AI** | Your Sarvam key |
| **Google Cloud Translation** | Your Google Cloud key |
| **LibreTranslate** | Free if self-hosted |
| **Your AI provider** | Uses the AI chosen for the narrative |

Test names, numbers and units stay exactly as printed.

![Gujarati](images/13-translated-gujarati.png)

### 3.10 Patients

Each person gets one profile.
- **Profile details:** identity and contact, lab IDs, height, weight, BMI, blood pressure, smoking, alcohol, conditions, medicines, allergies, family history and notes.
- **Reports:** all of that person's reports, with **Open, Edit, Move to another patient, Delete**.
- **Data tools:** **Results as CSV** (opens in Excel), **Merge** duplicate profiles, and **Backup all data** / **Restore backup** for everything.

The profile also fills gaps in reports (age from date of birth, height and weight for BMI and eGFR) and pre-fills calculator inputs: blood pressure, BP medicine and smoking for ASCVD.

**Clinical record.** Below the medical history, the profile has seven sections taken from an outpatient diabetes case record: diabetes and medical history; smoking, alcohol and tobacco; diabetes complications; hospital admissions and immunisation; and examination findings (vitals and general, feet, skin and systems). You can fill them in by hand, or let RADHA fill them from a document:

1. Ingest the document (for example a typed or scanned case record) like any report.
2. On the Verify screen, **Patient details found in this document** lists each detail with the line it was read from, and the page when the document prints page numbers. Check each value, correct it if needed, and untick anything you don't want saved.
3. Press **Confirm** (or **Save details to patient profile** for a document without lab tests).

Each value filled this way shows a small link with its date, page and file name. Click it to see the document text with that line highlighted. Values you type yourself are marked *entered by hand* and are not replaced by a document unless you tick them on the Verify screen. Documents without lab tests are listed under **Clinical documents** on the profile. The demo includes a synthetic case record to try this.

| Profile | Reports & data tools |
|---|---|
| ![Patient profile](images/14-patients.png) | ![Patient reports](images/14b-patient-reports.png) |

---

## 4. How a report is generated

```mermaid
flowchart TD
    A[PDF lab report] --> B{Parsing engine}
    B -->|Online| B1[Sarvam AI Document AI]
    B -->|Offline| B2[pdfplumber · PyMuPDF · Docling · Marker · EasyOCR]
    B1 --> C[Text / Markdown]
    B2 --> C
    C --> D["Extractor<br/>81 biomarkers · aliases · patient header<br/>value · unit · reference range"]
    D --> E["Unit normalisation<br/>standard units + converted ranges"]
    E --> F["✋ Verify screen<br/>you check, correct and choose the patient"]
    F --> G[(Local database<br/>patients + reports)]
    G --> H["Calculator router<br/>83 calculators · inputs from report + profile"]
    G --> I["Rule engine<br/>findings · evidence · next steps"]
    H --> I
    G --> J["Trends<br/>previous visits"]
    I --> K["Doctor questions<br/>findings · out-of-range · borderline · changes · missing tests"]
    J --> K
    I --> L["Optional AI narrative<br/>(de-identified)"]
    K --> M["Optional translation<br/>23 languages"]
    L --> M
    M --> N["📄 Export PDF<br/>caution note · profile · chart · findings · questions · calculators · labs · trends"]
```

**Step by step**

1. **Parse.** The PDF becomes text, either online or offline.
2. **Extract.** Each line is matched against 81 biomarkers using an alias dictionary that handles spellings such as "Haemoglobin", "SGPT (ALT)" and "25-OH Vitamin D". Values, units and reference ranges are read; labelled decision limits such as "Deficiency < 20" are skipped in favour of the normal range. Patient name, age, sex, date of birth, height, weight, ID and the report date (never the date of birth) are read from the header.
3. **Normalise.** Every value and its reference range is converted to one standard unit, so reports from different labs are comparable.
4. **Verify.** You confirm the values. This is the only point where the data enters the database.
5. **Calculate.** The router runs every calculator whose inputs are present, using report values plus the patient profile.
6. **Analyse.** Fixed rules produce findings with evidence and severity. No AI is involved in this step.
7. **Ask.** The question generator writes the doctor questions, including changes since the previous visit.
8. **Optional.** An AI narrative and a translation are added if you choose.
9. **Export.** A printable A4 PDF is produced, with the caution note at the top and the bottom.

---

## 5. The exported PDF report

Click **Export PDF** (top right). The PDF contains:
- the caution note;
- the patient profile and result chart;
- the clinical analysis with evidence;
- the questions for your doctor;
- the AI narrative, if generated;
- the calculator results;
- all lab results by panel;
- the multi-year comparison.

If a language other than English is selected, the PDF is exported in that language.

| Page 1 | Page 2 | Gujarati |
|---|---|---|
| ![PDF page 1](images/report-page-1.png) | ![PDF page 2](images/report-page-2.png) | ![Gujarati PDF](images/report-gujarati-page-1.png) |

Sample files: [English](sample/RADHA-sample-summary-english.pdf) · [Gujarati](sample/RADHA-sample-summary-gujarati.pdf)

---

## 6. Settings: AI and translation services

- **AI providers:** choose which one writes the narrative. You can save or remove keys, **Load models** to list what a provider offers, and **Test** the connection.
- **Translation:** choose the default translator and enter keys, URLs or an email where a service needs them, with a **Test** button for each.
- **Local parsing engines:** see what is installed, memory and disk use per engine, remove one engine or all of them, or point RADHA at your own Python (advanced).

![Local engines in Settings](images/20-settings-engines.png)

| AI providers | Translation |
|---|---|
| ![AI providers](images/15-settings-ai.png) | ![Translation](images/16-settings-translation.png) |

---

## 7. Privacy and safety

- **Local storage:** patients, reports and settings are stored only on your computer, in `~/Library/Application Support/RADHA/radha-db.json`. **Backup all data** makes a copy.
- **Encrypted keys:** API keys are encrypted with the macOS keychain.
- **What leaves your computer:**
  - Online parsing sends the PDF to Sarvam AI.
  - Translation and the AI narrative send only the results text, never the name or ID.
  - Ollama keeps everything on your computer.
- **Not a diagnosis:** RADHA is decision support for understanding results and preparing for a consultation. It does not diagnose, and machine translation can contain mistakes.

---

## 8. Troubleshooting

| Problem | What to do |
|---|---|
| "RADHA can't be opened" or "is damaged" on first launch | **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/RADHA.app` in Terminal. The Mac build needs an Apple silicon Mac (M1 or later). |
| A value or unit was read wrongly | Correct it on the **Verify** screen; open a saved report with **Edit** from the **Patients** tab |
| A report shows the date of birth as its date | **Patients** → that report → **Fix date** |
| "Local engines unavailable" or "Not installed" | Click **Install** on the engine card (Ingest screen) or **Install essentials** |
| A scanned report gives few tests | Use **Auto** or **Apple Vision OCR**; under **Tune** raise the DPI to 400, or turn on **Enhance image** for faint/photographed pages |
| The Mac slows down while reading | **Tune** → turn on **Low-memory mode**, or use Apple Vision OCR instead of Marker/Docling |
| Translation is slow or fails | The free service may be busy — wait a minute or pick another service next to **Language** |
| A calculator doesn't run | Look in **Needs your input** or **Not available** to see what is missing (often height/weight or blood pressure — add them to the patient profile) |
| Duplicate patients | **Patients** → open one → **Merge into this patient** |
