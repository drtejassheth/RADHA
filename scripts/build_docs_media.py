#!/usr/bin/env python3
"""Turn the captures from scripts/capture-docs.js into the images used by the docs.

    python3 scripts/build_docs_media.py docs/_capture

Writes docs/images/*.png (compressed screenshots + PDF page previews),
docs/images/radha-walkthrough.gif (captioned animated tour) and docs/sample/*.pdf.
Needs Pillow and PyMuPDF (fitz).
"""
import os
import shutil
import sys

import fitz
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")
IMAGES = os.path.join(DOCS, "images")
SAMPLE = os.path.join(DOCS, "sample")
TEAL = (15, 107, 95)

GIF_STEPS = [
    ("01-ingest", "1  Drop your PDF lab reports — online (Sarvam AI) or 100% offline"),
    ("02-verify", "2  Verify every value — units converted automatically"),
    ("03-dashboard", "3  Summary dashboard: normal, low, high at a glance"),
    ("04b-labs-abnormal", "4  Colour-coded results with reference ranges"),
    ("05-calculators", "5  83 medical calculators run automatically"),
    ("09-analysis", "6  Rule-based findings with evidence and next steps"),
    ("10-questions", "7  A complete list of questions for your doctor"),
    ("12-trends", "8  Multi-year trends"),
    ("13-translated-gujarati", "9  13 Indian + 10 world languages"),
    ("report-page-1", "10  One-click PDF summary for your doctor"),
    ("14-patients", "11  Patient profiles, Excel export and backup"),
]


def font(size):
    for f in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def save_png(img, path, width=1400):
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    # 256-colour palette keeps UI text crisp at a fraction of the size.
    img.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
    return img


def pdf_pages(pdf, prefix, pages):
    out = []
    with fitz.open(pdf) as doc:
        for i in pages:
            if i >= doc.page_count:
                break
            pix = doc[i].get_pixmap(dpi=110)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            path = os.path.join(IMAGES, f"{prefix}-{i + 1}.png")
            save_png(img, path, width=900)
            out.append(path)
    return out


def gif_frame(img, caption, size=(1000, 625)):
    bar = 54
    w, h = size
    canvas = Image.new("RGB", (w, h + bar), (245, 246, 248))
    if img.width / img.height > w / h:
        fit = img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)
    else:
        fit = img.resize((round(img.width * h / img.height), h), Image.LANCZOS)
    canvas.paste(fit, ((w - fit.width) // 2, bar + (h - fit.height) // 2))
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, w, bar], fill=TEAL)
    d.text((22, bar // 2), caption, font=font(24), fill="white", anchor="lm")
    return canvas


def main():
    cap = sys.argv[1]
    screens = os.path.join(cap, "screens")
    os.makedirs(IMAGES, exist_ok=True)
    os.makedirs(SAMPLE, exist_ok=True)

    for name in sorted(os.listdir(screens)):
        if name.endswith(".png"):
            save_png(Image.open(os.path.join(screens, name)), os.path.join(IMAGES, name))

    for pdf, dest in (("RADHA-sample-summary.pdf", "RADHA-sample-summary-english.pdf"), ("RADHA-sample-summary-gujarati.pdf", "RADHA-sample-summary-gujarati.pdf")):
        if os.path.exists(os.path.join(cap, pdf)):
            shutil.copy(os.path.join(cap, pdf), os.path.join(SAMPLE, dest))
    pdf_pages(os.path.join(cap, "RADHA-sample-summary.pdf"), "report-page", range(4))
    pdf_pages(os.path.join(cap, "RADHA-sample-summary-gujarati.pdf"), "report-gujarati-page", range(1))

    frames = []
    for name, caption in GIF_STEPS:
        src = os.path.join(screens, name + ".png")
        if not os.path.exists(src):
            src = os.path.join(IMAGES, name + ".png")
        if os.path.exists(src):
            frames.append(gif_frame(Image.open(src).convert("RGB"), caption))
    palette = frames[0].quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    gif = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    out = os.path.join(IMAGES, "radha-walkthrough.gif")
    gif[0].save(out, save_all=True, append_images=gif[1:], duration=[2600] * len(gif), loop=0, optimize=True)

    total = sum(os.path.getsize(os.path.join(IMAGES, f)) for f in os.listdir(IMAGES))
    print(f"{len(frames)} GIF frames -> {os.path.getsize(out) / 1e6:.1f} MB; docs/images total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
