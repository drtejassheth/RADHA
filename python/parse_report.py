#!/usr/bin/env python3
"""RADHA local PDF parsing sidecar.

Turns a lab-report PDF into plain text / Markdown that the RADHA biomarker
extractor understands. Every engine is optional; whichever libraries are
installed are used.

    python parse_report.py --check
    python parse_report.py --engine auto|pdfplumber|docling|marker|easyocr|pymupdf --file report.pdf

Writes a single JSON object to stdout: {engine, format, text, pages, warnings}
or {error}.
"""
import argparse
import importlib.util
import json
import os
import sys

MIN_TEXT_CHARS = 200  # below this a page set is treated as scanned -> OCR


def has(mod):
    return importlib.util.find_spec(mod) is not None


def engines_available():
    return {
        "pdfplumber": has("pdfplumber"),
        "docling": has("docling"),
        "marker": has("marker"),
        "easyocr": has("easyocr") and (has("pypdfium2") or has("fitz")),
        "pymupdf": has("fitz"),
    }


def words_to_lines(words, y_tol=4.0):
    """Group (x0, y0, x1, y1, text) boxes into reading-order lines.

    Large horizontal gaps become a double space so table columns stay
    separable for the downstream extractor.
    """
    words = sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    lines = []
    for w in words:
        yc = (w[1] + w[3]) / 2
        if lines and abs(lines[-1]["y"] - yc) <= y_tol:
            lines[-1]["words"].append(w)
        else:
            lines.append({"y": yc, "words": [w]})
    out = []
    for ln in lines:
        ws = sorted(ln["words"], key=lambda w: w[0])
        parts = [ws[0][4]]
        for prev, cur in zip(ws, ws[1:]):
            height = max(prev[3] - prev[1], 1)
            gap = cur[0] - prev[2]
            parts.append(("  " if gap > height * 1.2 else " ") + cur[4])
        out.append("".join(parts))
    return "\n".join(out)


# ---------------------------------------------------------------- engines

def parse_pdfplumber(path):
    import pdfplumber
    pages = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            words = page.extract_words(keep_blank_chars=False, use_text_flow=False)
            boxes = [(w["x0"], w["top"], w["x1"], w["bottom"], w["text"]) for w in words]
            pages.append(words_to_lines(boxes, y_tol=3.0))
        n = len(pdf.pages)
    return {"format": "text", "text": "\n\n".join(pages), "pages": n}


def parse_pymupdf(path):
    import fitz
    pages = []
    with fitz.open(path) as doc:
        for page in doc:
            boxes = [(w[0], w[1], w[2], w[3], w[4]) for w in page.get_text("words")]
            pages.append(words_to_lines(boxes, y_tol=3.0))
        n = doc.page_count
    return {"format": "text", "text": "\n\n".join(pages), "pages": n}


def parse_docling(path):
    from docling.document_converter import DocumentConverter
    result = DocumentConverter().convert(path)
    md = result.document.export_to_markdown()
    pages = None
    try:
        pages = len(result.document.pages)
    except Exception:
        pass
    return {"format": "markdown", "text": md, "pages": pages}


def parse_marker(path):
    # marker-pdf >= 1.0 API (uses Surya for layout + OCR)
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered
    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(path)
    text, _, _ = text_from_rendered(rendered)
    return {"format": "markdown", "text": text, "pages": None}


def render_pages(path, scale=2.5):
    """Yield page images as numpy arrays (pypdfium2 preferred, PyMuPDF fallback)."""
    import numpy as np
    if has("pypdfium2"):
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(path)
        for i in range(len(pdf)):
            yield np.array(pdf[i].render(scale=scale).to_pil().convert("RGB"))
    else:
        import fitz
        with fitz.open(path) as doc:
            for page in doc:
                pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
                img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
                yield img[:, :, :3]


def parse_easyocr(path):
    import easyocr
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    pages = []
    for img in render_pages(path):
        boxes = []
        for (pts, text, conf) in reader.readtext(img, detail=1, paragraph=False):
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            boxes.append((min(xs), min(ys), max(xs), max(ys), text))
        pages.append(words_to_lines(boxes, y_tol=12.0))
    return {"format": "text", "text": "\n\n".join(pages), "pages": len(pages)}


ENGINES = {
    "pdfplumber": parse_pdfplumber,
    "pymupdf": parse_pymupdf,
    "docling": parse_docling,
    "marker": parse_marker,
    "easyocr": parse_easyocr,
}


def parse_auto(path, avail):
    """Fast text layer first; fall back to OCR for scanned PDFs."""
    warnings = []
    for name in ("pdfplumber", "pymupdf"):
        if avail[name]:
            res = ENGINES[name](path)
            if len(res["text"].strip()) >= MIN_TEXT_CHARS:
                res["engine"] = name
                return res, warnings
            warnings.append(f"{name} found little text (scanned PDF?) - trying OCR.")
            break
    for name in ("docling", "marker", "easyocr"):
        if avail[name]:
            res = ENGINES[name](path)
            res["engine"] = name
            return res, warnings
    raise RuntimeError(
        "No usable local parsing engine. Install one with: "
        "pip install -r python/requirements.txt"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--engine", default="auto")
    ap.add_argument("--file")
    args = ap.parse_args()

    avail = engines_available()
    if args.check:
        print(json.dumps({"python": sys.version.split()[0], "executable": sys.executable, "engines": avail}))
        return

    if not args.file or not os.path.isfile(args.file):
        print(json.dumps({"error": f"File not found: {args.file}"}))
        return

    # Keep library chatter (progress bars, model downloads) off stdout, which carries the JSON.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        if args.engine == "auto":
            res, warnings = parse_auto(args.file, avail)
        else:
            if args.engine not in ENGINES:
                raise RuntimeError(f"Unknown engine: {args.engine}")
            if not avail[args.engine]:
                raise RuntimeError(
                    f"Engine '{args.engine}' is not installed for this Python ({sys.executable}). "
                    "See python/requirements.txt."
                )
            res = ENGINES[args.engine](args.file)
            res["engine"] = args.engine
            warnings = []
        res["warnings"] = warnings
        out = json.dumps(res)
    except Exception as e:  # report cleanly to the app
        out = json.dumps({"error": f"{type(e).__name__}: {e}"})
    finally:
        sys.stdout = real_stdout
    print(out)


if __name__ == "__main__":
    main()
