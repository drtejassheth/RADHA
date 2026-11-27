# RADHA share file format (`.radha`), version 1

A `.radha` file carries one patient's profile, clinical record and reports from RADHA to a doctor's
application (MOHAN, or RADHA itself), and back again after the doctor's changes. The contents are encrypted;
the person who made the file reads a **share code** to the doctor, who types it to open the file.

Design goals: one file, no server, safe to send over WhatsApp, email or AirDrop, readable with standard
cryptography in any language, lossless (a doctor's app can edit it and send it back), and versioned.

## 1. The file

A UTF-8 JSON object (the *envelope*). Only the envelope is in clear; it holds nothing that identifies the patient.

```json
{
  "format": "radha-share",
  "version": 1,
  "shareId": "6f1c…-uuid",
  "createdAt": "2026-11-27T10:15:00.000Z",
  "createdBy": { "app": "RADHA", "version": "0.2.8", "role": "patient" },
  "contents": { "reports": 2, "documents": 1 },
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "dkLen": 32, "salt": "<base64, 16 bytes>" },
  "cipher": { "name": "AES-256-GCM", "iv": "<base64, 12 bytes>", "tagLength": 16, "aad": "radha-share/1" },
  "compression": "gzip",
  "ciphertext": "<base64 of encrypted bytes followed by the 16-byte GCM tag>"
}
```

| Field | Meaning |
| --- | --- |
| `format`, `version` | Always `"radha-share"` and `1` for this specification. Readers must reject other values. |
| `shareId` | Random UUID of this file. A file sent back after changes keeps `basedOn` (inside the payload) pointing to it. |
| `createdBy.role` | `"patient"` (made in RADHA) or `"doctor"` (made by the doctor's app). |
| `contents` | Counts only, so a reader can show "2 reports, 1 document" before the code is typed. |

### Share code

12 characters from the Crockford base-32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (60 bits of
randomness), shown in groups of four: `K7Q2-9MXR-4TBW`. Before use, a reader **normalises** what was typed:
remove spaces and dashes, upper-case, then map `O→0`, `I→1`, `L→1`. The normalised 12 characters (ASCII) are
the password.

### Decryption

1. `key = scrypt(password = normalised code, salt = kdf.salt, N, r, p, dkLen = 32)`
2. `plaintext = AES-256-GCM-decrypt(key, iv = cipher.iv, aad = ASCII "radha-share/1", data = ciphertext without its last 16 bytes, tag = last 16 bytes)`
3. If `compression` is `"gzip"`, gunzip the plaintext.
4. Parse the result as UTF-8 JSON: the *payload*.

A wrong code fails the GCM tag check; tell the user "wrong code or damaged file". Writers use a fresh random
salt, IV and code for every file.

## 2. The payload

```json
{
  "format": "radha-share-payload",
  "version": 1,
  "exportedAt": "2026-11-27T10:15:00.000Z",
  "from": { "app": "RADHA", "version": "0.2.8", "role": "patient" },
  "basedOn": null,
  "patient": { … },
  "reports": [ … ],
  "documents": [ … ],
  "dictionary": { "biomarkers": { … }, "recordFields": { … } },
  "revisions": [ … ]
}
```

### `patient`

The RADHA patient profile, as stored by RADHA:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | RADHA's id for this patient. Keep it, so a file sent back can be matched. |
| `name`, `sex` (`"M"`, `"F"` or `""`), `dob` (`YYYY-MM-DD` or `""`) | | |
| `bloodGroup`, `phone`, `email`, `address`, `labIds` (string array) | | Optional contact details. |
| `heightCm`, `weightKg`, `sbp`, `dbp` | number or null | Latest measurements. `measuredOn` is their date. |
| `smoking` (`never`/`former`/`current`), `alcohol` (`none`/`occasional`/`regular`), `bpTreated` (bool) | | |
| `conditions` | object of booleans | `diabetes`, `hypertension`, `ckd`, `liver`, `heart`, `thyroid`. |
| `otherConditions`, `medications`, `allergies`, `familyHistory`, `notes` | string | Free text. |
| `record` | object | Clinical record: history, lifestyle, complications, admissions, immunisation and examination. Keys and their labels and types are listed in `dictionary.recordFields`. Values are strings, numbers, `"yes"`/`"no"` or `"present"`/`"absent"`. |
| `sources` | object | For each profile field that was read from a document: `{ kind: "report" | "document" | "manual", id, fileName, date, printed, page }`. `printed` is the line it was read from. |

### `reports[]`

One per verified lab report.

| Field | Notes |
| --- | --- |
| `id`, `date` (`YYYY-MM-DD`), `source` (`{ fileName, engine }`) | |
| `patientAsPrinted` | Name, age, sex, lab ID as printed on that report. |
| `rows[]` | One per test: `key` (canonical biomarker, see `dictionary.biomarkers`), `name`, `panel`, `rawName` (as printed), `rawValue`, `rawUnit`, `rawLow`, `rawHigh` (as printed), `value`, `unit`, `low`, `high` (standard units), `status` (`low`/`normal`/`high`/`unknown`), `critical` (bool), `rangeSource` (`report`/`default`), `include` (bool: confirmed for analysis). |
| `calculators[]` | Results that ran: `id`, `name`, `value`, `unit`, `band`, `interpretation`, `reference`. |
| `analysis` | `headline`, `summary`, `observations[]` (`title`, `severity` urgent/attention/watch/info, `detail`, `evidence[]`, `nextSteps[]`), `questions[]` (`topic`, `text`). |
| `rawText` | Text of the original report, if the sender chose to include it. |
| `doctorNotes` | Optional: notes added by the doctor (a doctor's app may add this). |

### `documents[]`

Clinical documents without lab tests (for example a case record): `id`, `fileName`, `date`, `rawText`.

### `dictionary`

Makes the file self-describing: `biomarkers[key] = { name, unit, panel }` for every key used, and
`recordFields[key] = { label, section, type, options }` for the clinical record.

### `revisions[]`

A change log that each app appends to when it edits and re-shares the file:
`{ at, by: { app, version, role, name }, summary, changes: [{ path, from, to }] }`. `path` is a JSON pointer
into the payload, for example `/patient/record/waistCm` or `/reports/0/rows/3/value`.

## 3. Sending changes back

A doctor's app that edits the data writes a new file in the same format with `from.role = "doctor"`,
`basedOn = <shareId of the file it opened>`, the edited payload and a new `revisions[]` entry, encrypted with a
new code. RADHA's **Import shared file** shows the changes against what it has and lets the patient accept them.

## 4. Compatibility

Readers ignore fields they do not know. Writers never change the meaning of an existing field within version 1;
anything incompatible gets `version: 2`.
