#!/usr/bin/env python3
"""RADHA local PDF parsing sidecar.

Turns a lab-report PDF into plain text / Markdown that the RADHA biomarker
extractor understands. Every engine is optional; whichever libraries are
installed are used.

    python parse_report.py --check
    python parse_report.py --engine auto|pdfplumber|pymupdf|applevision|easyocr|docling|marker \
        --file report.pdf [--options '{"pages": "1-3", ...}']
    python parse_report.py --warmup easyocr|docling|marker|applevision [--options ...]

--options is a JSON object with the tuning settings from the app (all optional):
    common:      pages ("1-3,5"), device (auto|cpu|mps), threads (int), lowMemory (bool)
    text layer:  lineTolerance (pt), columnGap (x word height)
    auto:        textEngine, ocrEngine, minChars (per page)
    OCR engines: languages ([...]), dpi, enhance (bool), minConfidence (0-1)
    applevision: level (accurate|fast), languageCorrection (bool)
    easyocr:     rotate (bool), textThreshold, lowText, magRatio
    docling:     ocr (auto|force|off), ocrEngine (auto|ocrmac|easyocr|rapidocr), tableMode (accurate|fast),
                 cellMatching (bool), imagesScale
    marker:      forceOcr (bool), stripExistingOcr (bool)

Writes a single JSON object to stdout: {engine, format, text, pages, warnings}
or {error}.
"""
import argparse
import importlib.util
import json
import os
import re
import statistics
import sys
import unicodedata

DEFAULT_MIN_CHARS = 60  # a page with less text than this is treated as scanned -> OCR
IS_MAC = sys.platform == "darwin"


def has(mod):
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


def engines_available():
    return {
        "pdfplumber": has("pdfplumber"),
        "pymupdf": has("fitz"),
        "applevision": IS_MAC and has("ocrmac") and (has("pypdfium2") or has("fitz")),
        "easyocr": has("easyocr") and (has("pypdfium2") or has("fitz")),
        "docling": has("docling"),
        "marker": has("marker"),
    }


def versions():
    out = {}
    try:
        from importlib.metadata import version
    except ImportError:
        return out
    for dist in ("pdfplumber", "pymupdf", "ocrmac", "easyocr", "docling", "marker-pdf", "torch"):
        try:
            out[dist] = version(dist)
        except Exception:
            pass
    return out


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- options

def page_list(spec, count):
    """'1-3,5' (1-based) -> sorted 0-based indices within the document. Empty/'all' -> every page."""
    if not spec or str(spec).strip().lower() in ("all", "*"):
        return list(range(count))
    pages = set()
    for part in str(spec).replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            a = int(a) if a else 1
            b = int(b) if b else count
            pages.update(range(max(a, 1) - 1, min(b, count)))
        else:
            n = int(part)
            if 1 <= n <= count:
                pages.add(n - 1)
    return sorted(pages) or list(range(count))


def page_count(path):
    if has("pypdfium2"):
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(path)
        try:
            return len(pdf)
        finally:
            pdf.close()
    if has("fitz"):
        import fitz
        with fitz.open(path) as doc:
            return doc.page_count
    if has("pdfplumber"):
        import pdfplumber
        with pdfplumber.open(path) as pdf:
            return len(pdf.pages)
    return None


def torch_device(opts):
    dev = (opts.get("device") or "auto").lower()
    if dev in ("cpu", "mps", "cuda"):
        return dev
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def apply_threads(opts):
    n = opts.get("threads")
    if n:
        os.environ["OMP_NUM_THREADS"] = str(int(n))
        try:
            import torch
            torch.set_num_threads(int(n))
        except Exception:
            pass


# ---------------------------------------------------------------- layout

NUMERIC_GLYPH = re.compile(r"[\d.,\-–<>≤≥]")


def words_to_lines(words, y_tol=3.0, gap=1.2, join=0.0):
    """Group (x0, y0, x1, y1, text) boxes into reading-order lines.

    The line tolerance adapts to the text size (half the median word height) so
    the same code works for PDF points and OCR pixels. Large horizontal gaps become
    a double space so table columns stay separable for the downstream extractor.
    """
    words = [w for w in words if str(w[4]).strip()]
    if not words:
        return ""
    heights = [max(w[3] - w[1], 1) for w in words]
    tol = max(float(y_tol), statistics.median(heights) * 0.5)
    words = sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    lines = []
    for w in words:
        yc = (w[1] + w[3]) / 2
        if lines and abs(lines[-1]["y"] - yc) <= tol:
            ln = lines[-1]
            ln["words"].append(w)
            ln["y"] += (yc - ln["y"]) / len(ln["words"])  # running mean keeps slanted scans together
        else:
            lines.append({"y": yc, "words": [w]})
    out = []
    for ln in lines:
        ws = sorted(ln["words"], key=lambda w: w[0])
        parts = [str(ws[0][4]).strip()]
        for prev, cur in zip(ws, ws[1:]):
            height = max(min(prev[3] - prev[1], cur[3] - cur[1]), 1)
            space = cur[0] - prev[2]
            a, b = str(prev[4]).strip(), str(cur[4]).strip()
            glue = join and space < height * join and a and b and NUMERIC_GLYPH.match(a[-1]) and NUMERIC_GLYPH.match(b[0])
            sep = "" if glue else "  " if space > height * float(gap) else " "
            parts.append(sep + str(cur[4]).strip())
        out.append("".join(parts))
    return "\n".join(out)


def render_pages(path, indices, dpi=300):
    """Yield (index, PIL.Image) for the requested pages (pypdfium2 preferred, PyMuPDF fallback)."""
    scale = float(dpi) / 72.0
    if has("pypdfium2"):
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(path)
        try:
            for i in indices:
                yield i, pdf[i].render(scale=scale).to_pil().convert("RGB")
        finally:
            pdf.close()
    else:
        import fitz
        from PIL import Image
        with fitz.open(path) as doc:
            for i in indices:
                pix = doc[i].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                yield i, Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def enhance_image(img):
    """Grayscale + auto-contrast + light sharpening: helps faint, coloured or photographed reports."""
    from PIL import ImageFilter, ImageOps
    g = ImageOps.autocontrast(ImageOps.grayscale(img), cutoff=1)
    return g.filter(ImageFilter.UnsharpMask(radius=1.5, percent=120, threshold=3)).convert("RGB")


_LATIN_CACHE = {}


def _plain_latin(ch):
    """Ü -> U, İ -> I (Latin letters only; Indic vowel signs and µ are left alone)."""
    r = _LATIN_CACHE.get(ch)
    if r is None:
        r = ch
        if ord(ch) > 127 and "LATIN" in unicodedata.name(ch, ""):
            base = unicodedata.normalize("NFKD", ch)[0]
            if base.isascii():
                r = base
        _LATIN_CACHE[ch] = r
    return r


OCR_FIXES = [
    (re.compile(r"(?<![A-Za-z])[Oo](?=\s*(?:-|–|to)\s*\d)"), "0"),             # "O to 40" -> "0 to 40"
    (re.compile(r"(?<=\d)[Oo](?=[\d.]|\b)|(?<=\d\.)[Oo]|(?<![A-Za-z])[Oo](?=\.\d)"), "0"),  # 1O.5, 0.O5, O.75
    (re.compile(r"(10\s*\^?\s*[369]\s*/\s*)[HhpuU]L\b"), "\\1µL"),          # x 10^3 / HL -> µL
    (re.compile(r"(?<![A-Za-z])[HhpUu]IU\s*/\s*m[lL]\b"), "µIU/mL"),
    (re.compile(r"\b[mn]g\s*/\s*d[Il1i]\b"), lambda m: m.group(0)[:-1] + "l"),  # mg/dI -> mg/dl
    (re.compile(r"\b[OU0]\s*[I1l/]\s*L\b"), "U/L"),                          # OIL, UIL -> U/L
    (re.compile(r"\b([A-Z][a-z]{2,8}\.? \d{1,2}),(\d{4})\b"), "\\1, \\2"),       # Oct 14,2026 -> Oct 14, 2026
    (re.compile(r"(?m)^[_|]+(?=\w)"), ""),                                      # stray rule marks before a word
    # A slash read as l / I / 1 inside units: gldL, milllcumm, mgldl, Icumm
    (re.compile(r"\b(g|mg|µg|ug|ng|pg|mmol|µmol|umol|mEq|U|IU|mIU|µIU|mill|lakhs|cells)[lI1|](dL|dl|L|mL|ml|cumm|µL|uL|hr)\b"), "\\1/\\2"),
    (re.compile(r"(?<![A-Za-z])[I|l](cumm|µL|uL|hpf)\b"), "/\\1"),
    (re.compile(r"\bAge\s*[lI1|]\s*(Sex|Gender)\b"), "Age/\\1"),
    (re.compile(r"\b(Dr|DR|Mr|MR|Mrs|MRS|Ms|MS)[:;,](?=\s)"), "\\1."),                    # "DR: ARJUN" -> "DR. ARJUN"
    (re.compile(r"\b10\s*[4\^]\s*([369])\s*/?\s*(?:ML|mL|µL|uL|pL|HL)\b"), "10^\\1/µL"),  # "x 1043 ML" -> 10^3/µL
    # Header labels whose colon was not read: "Patient Name Mr. X" -> "Patient Name: Mr. X"
    (re.compile(r"(?m)(^|\s{2,})((?i:patient(?:'s)? name|name|age/sex|age/gender|uhid|patient id|lab no\.?|ref\.? by|referred by|"
                r"sample collected|collected on|reported on|reported|report date|registered on))\s+(?=[A-Z0-9])"), "\\1\\2: "),
]
_RANGE_TAIL = re.compile(r"(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$")
_NUM = re.compile(r"(?<![\w/:.])\d+(?:\.\d+)?(?![\w/:])")


def fix_lost_dashes(line):
    """'MCV  77.1  fL  83 101' -> '... 83 - 101' when OCR dropped the range dash (value + two limits)."""
    m = _RANGE_TAIL.search(line)
    if m and len(_NUM.findall(line)) >= 3 and float(m.group(1)) < float(m.group(2)):
        return line[:m.start()] + f"{m.group(1)} - {m.group(2)}"
    return line


def clean_ocr_text(text):
    """Fix the usual OCR slips in lab reports without touching non-Latin scripts."""
    text = "".join(chr(ord(c) - 0xFEE0) if 0xFF01 <= ord(c) <= 0xFF5E else _plain_latin(c) for c in text)
    for rx, rep in OCR_FIXES:
        text = rx.sub(rep, text)
    return "\n".join(fix_lost_dashes(l) for l in text.split("\n"))


# ---------------------------------------------------------------- text-layer engines

def text_pages_pdfplumber(path, indices, opts):
    import pdfplumber
    out = {}
    with pdfplumber.open(path) as pdf:
        for i in indices:
            words = pdf.pages[i].extract_words(keep_blank_chars=False, use_text_flow=False)
            boxes = [(w["x0"], w["top"], w["x1"], w["bottom"], w["text"]) for w in words]
            out[i] = words_to_lines(boxes, opts.get("lineTolerance", 3.0), opts.get("columnGap", 1.2))
    return out


def text_pages_pymupdf(path, indices, opts):
    import fitz
    out = {}
    with fitz.open(path) as doc:
        for i in indices:
            boxes = [(w[0], w[1], w[2], w[3], w[4]) for w in doc[i].get_text("words")]
            out[i] = words_to_lines(boxes, opts.get("lineTolerance", 3.0), opts.get("columnGap", 1.2))
    return out


TEXT_LAYER = {"pdfplumber": text_pages_pdfplumber, "pymupdf": text_pages_pymupdf}


def join_pages(pages):
    return "\n\n".join(pages[i] for i in sorted(pages))


def parse_text_layer(name):
    def run(path, opts):
        indices = page_list(opts.get("pages"), page_count(path))
        pages = TEXT_LAYER[name](path, indices, opts)
        return {"format": "text", "text": join_pages(pages), "pages": len(indices)}
    return run


# ---------------------------------------------------------------- OCR engines (page by page)

VISION_LANGS = {"en": "en-US", "hi": "hi-IN", "fr": "fr-FR", "de": "de-DE", "es": "es-ES", "pt": "pt-BR", "it": "it-IT",
                "zh": "zh-Hans", "ja": "ja-JP", "ko": "ko-KR", "ru": "ru-RU", "ar": "ar-SA", "uk": "uk-UA", "vi": "vi-VT", "th": "th-TH"}


class AppleVisionOCR:
    """macOS Vision framework (pyobjc, installed with ocrmac): fast, accurate, light, nothing to download."""

    def __init__(self, opts):
        import Vision  # noqa: F401  (pyobjc-framework-Vision)
        self.Vision = Vision
        langs = opts.get("languages") or ["en"]
        supported = vision_languages()
        wanted = [VISION_LANGS.get(l) or next((x for x in supported if x.split("-")[0] == l), l) for l in langs]
        if "en-US" not in wanted:
            wanted.append("en-US")
        self.langs = [l for l in wanted if l in supported] or ["en-US"]
        self.skipped = [l for l in wanted if l not in supported]
        self.fast = opts.get("level") == "fast"
        # Vision reads whole lines reliably but skips lone characters (a "0" result, "%", an "H" flag);
        # LiveText (macOS 13+) catches those. "both" (default) fills Vision's gaps with LiveText tokens.
        fw = opts.get("framework") or "both"
        self.framework = "vision" if self.fast else fw
        self.correct = bool(opts.get("languageCorrection", False))
        self.min_conf = float(opts.get("minConfidence", 0.0) or 0.0)

    def boxes(self, img):
        if self.framework in ("livetext", "both"):
            try:
                live = self.livetext_boxes(img)
            except Exception as e:  # older macOS: fall back to Vision
                log(f"LiveText unavailable ({e}); using Vision only.")
                self.framework = "vision"
            else:
                if self.framework == "livetext":
                    return live
                base = self.vision_boxes(img)
                return base + [t for t in live if not covered(t, base)]
        return self.vision_boxes(img)

    def livetext_boxes(self, img):
        from ocrmac import ocrmac
        w, h = img.size
        out = []
        for text, conf, (x, y, bw, bh) in ocrmac.OCR(img, framework="livetext", language_preference=self.langs, unit="token").recognize():
            if conf < self.min_conf:
                continue
            out.append((x * w, (1 - y - bh) * h, (x + bw) * w, (1 - y) * h, str(text)))
        return out

    def vision_boxes(self, img):
        import objc
        from ocrmac.ocrmac import pil2buf
        V = self.Vision
        w, h = img.size
        out = []
        with objc.autorelease_pool():
            req = V.VNRecognizeTextRequest.alloc().init()
            req.setRecognitionLevel_(1 if self.fast else 0)
            req.setUsesLanguageCorrection_(self.correct)
            req.setRecognitionLanguages_(self.langs)
            handler = V.VNImageRequestHandler.alloc().initWithData_options_(pil2buf(img), None)
            handler.performRequests_error_([req], None)
            for r in req.results() or []:
                cand = r.topCandidates_(1)
                if not cand:
                    continue
                c = cand[0]
                if c.confidence() < self.min_conf:
                    continue
                bb = r.boundingBox()  # normalised, bottom-left origin
                x0, x1 = bb.origin.x * w, (bb.origin.x + bb.size.width) * w
                y0, y1 = (1 - bb.origin.y - bb.size.height) * h, (1 - bb.origin.y) * h
                out.append((x0, y0, x1, y1, str(c.string())))
        return out


def covered(tok, boxes):
    """True when the centre of `tok` lies inside one of `boxes` (slightly padded)."""
    cx, cy = (tok[0] + tok[2]) / 2, (tok[1] + tok[3]) / 2
    for b in boxes:
        pad = (b[3] - b[1]) * 0.25
        if b[0] - pad <= cx <= b[2] + pad and b[1] - pad <= cy <= b[3] + pad:
            return True
    return False


def vision_languages():
    try:
        import Vision
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(0)
        langs = req.supportedRecognitionLanguagesAndReturnError_(None)
        langs = langs[0] if isinstance(langs, tuple) else langs
        return [str(l) for l in (langs or [])]
    except Exception:
        return []


class EasyOCREngine:
    def __init__(self, opts):
        import easyocr
        apply_threads(opts)
        langs = [l for l in (opts.get("languages") or ["en"]) if l]
        if "en" not in langs:
            langs.append("en")
        dev = torch_device(opts)
        gpu = dev if dev in ("mps", "cuda") else False
        self.reader = easyocr.Reader(langs, gpu=gpu, verbose=False,
                                     model_storage_directory=os.environ.get("EASYOCR_MODULE_PATH") and os.path.join(os.environ["EASYOCR_MODULE_PATH"], "model"))
        self.min_conf = float(opts.get("minConfidence", 0.2) or 0.0)
        self.kw = {
            "text_threshold": float(opts.get("textThreshold", 0.7)),
            "low_text": float(opts.get("lowText", 0.4)),
            "mag_ratio": float(opts.get("magRatio", 1.0)),
            "batch_size": 1 if opts.get("lowMemory") else 4,
        }
        if opts.get("rotate"):
            self.kw["rotation_info"] = [90, 180, 270]

    def boxes(self, img):
        import numpy as np
        out = []
        for pts, text, conf in self.reader.readtext(np.array(img), detail=1, paragraph=False, **self.kw):
            if conf < self.min_conf:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            out.append((min(xs), min(ys), max(xs), max(ys), text))
        return out


PAGE_OCR = {"applevision": AppleVisionOCR, "easyocr": EasyOCREngine}


def ocr_pages(name, path, indices, opts):
    engine = PAGE_OCR[name](opts)
    dpi = int(opts.get("dpi") or 300)
    out = {}
    for i, img in render_pages(path, indices, dpi):
        log(f"OCR page {i + 1} with {name}…")
        if opts.get("enhance", name == "easyocr"):
            img = enhance_image(img)
        # LiveText returns digits as separate touching glyphs: glue boxes that touch.
        join = 0.2 if getattr(engine, "framework", "") in ("livetext", "both") else 0.0
        out[i] = clean_ocr_text(words_to_lines(engine.boxes(img), 3.0, opts.get("columnGap", 1.2), join))
    return out


def parse_page_ocr(name):
    def run(path, opts):
        indices = page_list(opts.get("pages"), page_count(path))
        pages = ocr_pages(name, path, indices, opts)
        return {"format": "text", "text": join_pages(pages), "pages": len(indices)}
    return run


# ---------------------------------------------------------------- Docling

def docling_converter(opts):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel import pipeline_options as po
    from docling.document_converter import DocumentConverter, PdfFormatOption
    try:
        from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    except ImportError:
        AcceleratorDevice, AcceleratorOptions = po.AcceleratorDevice, po.AcceleratorOptions

    p = po.PdfPipelineOptions()
    mode = (opts.get("ocr") or "auto").lower()
    p.do_ocr = mode != "off"
    if p.do_ocr:
        force = mode == "force"
        langs = opts.get("languages") or ["en"]
        engine = (opts.get("ocrEngine") or "auto").lower()
        if engine == "auto":
            engine = "ocrmac" if IS_MAC and has("ocrmac") else "easyocr" if has("easyocr") else "rapidocr" if has("rapidocr") or has("rapidocr_onnxruntime") else "default"
        if engine == "ocrmac" and hasattr(po, "OcrMacOptions"):
            p.ocr_options = po.OcrMacOptions(force_full_page_ocr=force, lang=[VISION_LANGS.get(l, l) for l in langs])
        elif engine == "easyocr" and hasattr(po, "EasyOcrOptions"):
            p.ocr_options = po.EasyOcrOptions(force_full_page_ocr=force, lang=langs)
        elif engine == "rapidocr" and hasattr(po, "RapidOcrOptions"):
            p.ocr_options = po.RapidOcrOptions(force_full_page_ocr=force)
        else:
            p.ocr_options.force_full_page_ocr = force
    p.do_table_structure = True
    p.table_structure_options.mode = po.TableFormerMode.FAST if opts.get("tableMode") == "fast" else po.TableFormerMode.ACCURATE
    p.table_structure_options.do_cell_matching = bool(opts.get("cellMatching", True))
    p.images_scale = float(opts.get("imagesScale") or 2.0)
    p.generate_page_images = False
    p.generate_picture_images = False
    for attr in ("do_picture_classification", "do_picture_description", "do_formula_enrichment", "do_code_enrichment"):
        if hasattr(p, attr):
            setattr(p, attr, False)
    dev = (opts.get("device") or "auto").lower()
    p.accelerator_options = AcceleratorOptions(
        num_threads=int(opts.get("threads") or 4),
        device={"cpu": AcceleratorDevice.CPU, "mps": AcceleratorDevice.MPS}.get(dev, AcceleratorDevice.AUTO),
    )
    if opts.get("lowMemory"):
        try:
            from docling.datamodel.settings import settings
            settings.perf.page_batch_size = 1
        except Exception:
            pass
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=p)})


def line_reader_text(path, opts, indices=None):
    """RADHA's own line reader: text layer for digital pages, the lightest installed OCR for scanned ones."""
    avail = engines_available()
    count = page_count(path)
    indices = indices if indices is not None else page_list(opts.get("pages"), count)
    text_engine = next((n for n in ("pdfplumber", "pymupdf") if avail[n]), None)
    pages = TEXT_LAYER[text_engine](path, indices, opts) if text_engine else {}
    min_chars = int(opts.get("minChars") or DEFAULT_MIN_CHARS)
    scanned = [i for i in indices if len(pages.get(i, "").replace(" ", "")) < min_chars]
    ocr = next((n for n in ("applevision", "easyocr") if avail[n]), None)
    if scanned and ocr:
        pages.update(ocr_pages(ocr, path, scanned, dict(opts, **(opts.get("engines") or {}).get(ocr, {}))))
    return join_pages(pages)


def fill_gaps(res, path, opts):
    """Docling / Marker sometimes read a borderless results table as prose, or split label and value.
    Appending RADHA's line reading lets the extractor pick up whatever they missed (their own
    table values come first, so they win when both are present)."""
    if not opts.get("fillGaps", True):
        return res
    try:
        extra = line_reader_text(path, opts)
    except Exception as e:  # never fail the main engine because of the helper
        log(f"line reader skipped: {e}")
        return res
    if extra.strip():
        # Patient details are read from the top of the text; Docling/Marker often scatter the header
        # block, so RADHA's reading of the first lines goes in front.
        header = "\n".join(extra.strip().split("\n")[:15])
        res["text"] = header + "\n\n" + res["text"] + "\n\n<!-- RADHA line reader -->\n\n" + extra
    return res


def parse_docling(path, opts):
    conv = docling_converter(opts)
    indices = page_list(opts.get("pages"), page_count(path) or 9999)
    kwargs = {}
    if opts.get("pages"):
        kwargs["page_range"] = (indices[0] + 1, indices[-1] + 1)
    result = conv.convert(path, **kwargs)
    md = result.document.export_to_markdown()
    try:
        pages = len(result.document.pages)
    except Exception:
        pages = None
    return fill_gaps({"format": "markdown", "text": md, "pages": pages}, path, opts)


# ---------------------------------------------------------------- Marker

def marker_converter(opts):
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    mode = (opts.get("mode") or "fast").lower()
    config = {
        "output_format": "markdown",
        "disable_image_extraction": True,
        "disable_tqdm": False,
        "force_ocr": bool(opts.get("forceOcr", False)),
        "strip_existing_ocr": bool(opts.get("stripExistingOcr", False)),
    }
    if mode != "auto":
        config["mode"] = mode  # fast (Indra ONNX, CPU friendly) | no_ocr | balanced | accurate (Surya VLM)
    if opts.get("lowMemory"):
        config.update({"ocr_error_batch_size": 1, "layout_batch_size": 1, "detection_batch_size": 1, "recognition_batch_size": 2})
    if opts.get("_pages0"):
        config["page_range"] = opts["_pages0"]
    try:
        from marker.config.parser import ConfigParser
        cp = ConfigParser(config)
        return PdfConverter(config=cp.generate_config_dict(), artifact_dict=create_model_dict(),
                            processor_list=cp.get_processors(), renderer=cp.get_renderer())
    except Exception:
        return PdfConverter(config=config, artifact_dict=create_model_dict())


def parse_marker(path, opts):
    from marker.output import text_from_rendered
    if opts.get("pages"):
        opts = dict(opts, _pages0=page_list(opts["pages"], page_count(path) or 9999))
    rendered = marker_converter(opts)(path)
    text, _, _ = text_from_rendered(rendered)
    return fill_gaps({"format": "markdown", "text": text, "pages": None}, path, opts)


ENGINES = {
    "pdfplumber": parse_text_layer("pdfplumber"),
    "pymupdf": parse_text_layer("pymupdf"),
    "applevision": parse_page_ocr("applevision"),
    "easyocr": parse_page_ocr("easyocr"),
    "docling": parse_docling,
    "marker": parse_marker,
}
OCR_ORDER = ("applevision", "docling", "easyocr", "marker")


# ---------------------------------------------------------------- auto

def parse_auto(path, avail, opts):
    """Text layer first; OCR only the pages that have no usable text (scanned or mixed PDFs)."""
    warnings = []
    count = page_count(path)
    indices = page_list(opts.get("pages"), count)
    text_engine = opts.get("textEngine") if avail.get(opts.get("textEngine") or "") else next((n for n in ("pdfplumber", "pymupdf") if avail[n]), None)
    pages = TEXT_LAYER[text_engine](path, indices, opts) if text_engine else {}
    min_chars = int(opts.get("minChars") or DEFAULT_MIN_CHARS)
    scanned = [i for i in indices if len(pages.get(i, "").replace(" ", "")) < min_chars]
    if not scanned:
        return {"format": "text", "text": join_pages(pages), "pages": len(indices), "engine": text_engine}, warnings

    wanted = opts.get("ocrEngine") or "best"
    ocr = wanted if wanted != "best" and avail.get(wanted) else next((n for n in OCR_ORDER if avail[n]), None)
    if wanted not in ("best", None) and ocr != wanted:
        warnings.append(f"{wanted} is not installed — used {ocr or 'no OCR'} instead.")
    if not ocr:
        if text_engine and len(scanned) < len(indices):
            warnings.append(f"Pages {', '.join(str(i + 1) for i in scanned)} look scanned but no OCR engine is installed.")
            return {"format": "text", "text": join_pages(pages), "pages": len(indices), "engine": text_engine}, warnings
        raise RuntimeError("This PDF looks scanned and no OCR engine is installed. Install one from the Ingest screen.")

    label = f"{len(scanned)} of {len(indices)} page(s)" if len(scanned) < len(indices) else "all pages"
    warnings.append(f"Little text found on {label} (scanned?) — read them with {ocr} OCR.")
    opts = dict(opts, **(opts.get("engines") or {}).get(ocr, {}))
    if ocr in PAGE_OCR:
        pages.update(ocr_pages(ocr, path, scanned, opts))
        name = ocr if len(scanned) == len(indices) else f"{text_engine}+{ocr}"
        return {"format": "text", "text": join_pages(pages), "pages": len(indices), "engine": name}, warnings
    # Docling / Marker work on whole documents: run them on the scanned pages only.
    spec = ",".join(str(i + 1) for i in scanned)
    res = ENGINES[ocr](path, dict(opts, pages=spec, fillGaps=False))
    if len(scanned) < len(indices):
        keep = {i: t for i, t in pages.items() if i not in scanned}
        res["text"] = join_pages(keep) + "\n\n" + res["text"]
        res["engine"] = f"{text_engine}+{ocr}"
    else:
        res["engine"] = ocr
    res["pages"] = len(indices)
    return res, warnings


# ---------------------------------------------------------------- warm-up (model download at install time)

def tiny_pdf():
    """A one-page image PDF with a lab line on it, for downloading/initialising models at install time."""
    import tempfile
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (1240, 400), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 34)
    except Exception:
        font = ImageFont.load_default()
    d.text((60, 80), "Haemoglobin        13.5     g/dL     13.0 - 17.0", fill="black", font=font)
    d.text((60, 160), "Glucose, Fasting   92       mg/dL    70 - 100", fill="black", font=font)
    path = os.path.join(tempfile.mkdtemp(prefix="radha-warmup-"), "warmup.pdf")
    img.save(path, "PDF", resolution=150)
    return path


def warmup(engine, opts):
    """Download and load the engine's models by reading a tiny generated PDF."""
    log(f"Preparing {engine} (first run downloads its models)…")
    path = tiny_pdf()
    o = dict(opts, fillGaps=False)
    if engine == "docling":
        o.setdefault("ocr", "auto")
    if engine == "marker":
        o["forceOcr"] = True
    res = ENGINES[engine](path, o)
    log(f"{engine} ready — test read: {res.get('text', '').strip()[:80]!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--engine", default="auto")
    ap.add_argument("--file")
    ap.add_argument("--options", default="{}")
    ap.add_argument("--warmup")
    args = ap.parse_args()

    try:
        opts = json.loads(args.options or "{}") or {}
    except ValueError:
        opts = {}
    # Marker / Surya read the device from the environment at import time.
    dev = (opts.get("device") or "auto").lower()
    if dev in ("cpu", "mps", "cuda"):
        os.environ["TORCH_DEVICE"] = dev
    if opts.get("threads"):
        os.environ["OMP_NUM_THREADS"] = str(int(opts["threads"]))

    avail = engines_available()
    if args.check:
        info = {"python": sys.version.split()[0], "executable": sys.executable, "engines": avail,
                "versions": versions(), "platform": sys.platform}
        if avail.get("applevision"):
            info["visionLanguages"] = vision_languages()
        print(json.dumps(info))
        return

    real_stdout = sys.stdout
    if args.warmup:
        sys.stdout = sys.stderr
        try:
            warmup(args.warmup, opts)
        finally:
            sys.stdout = real_stdout
        print(json.dumps({"ok": True}))
        return

    if not args.file or not os.path.isfile(args.file):
        print(json.dumps({"error": f"File not found: {args.file}"}))
        return

    # Keep library chatter (progress bars, model downloads) off stdout, which carries the JSON.
    sys.stdout = sys.stderr
    try:
        if args.engine == "auto":
            res, warnings = parse_auto(args.file, avail, opts)
        else:
            if args.engine not in ENGINES:
                raise RuntimeError(f"Unknown engine: {args.engine}")
            if not avail[args.engine]:
                raise RuntimeError(
                    f"Engine '{args.engine}' is not installed for this Python ({sys.executable}). "
                    "Install it from the Ingest screen."
                )
            apply_threads(opts)
            res = ENGINES[args.engine](args.file, opts)
            res["engine"] = args.engine
            warnings = []
            if len((res.get("text") or "").strip()) < 40:
                warnings.append(f"{args.engine} found almost no text — for a scanned report choose an OCR engine or Local — Auto.")
        res["warnings"] = warnings
        out = json.dumps(res)
    except Exception as e:  # report cleanly to the app
        out = json.dumps({"error": f"{type(e).__name__}: {e}"})
    finally:
        sys.stdout = real_stdout
    print(out)


if __name__ == "__main__":
    main()
