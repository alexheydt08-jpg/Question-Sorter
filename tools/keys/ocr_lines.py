"""Read a scanned page as lines of text with their positions.

Many schools publish solutions as a photograph of paper. There is no text
layer to search for "Question 24", so the page is rendered and read with
tesseract, which returns each word with a box. Words are grouped back into
lines so the guideline cutter can find headings the same way it does on a
page that has real text.

OCR is slow and imperfect. It is used only to locate headings — the crop
itself is cut from the original page, so nothing a student sees depends on
the recognition being right.
"""
import os, re, subprocess, tempfile, functools
import pymupdf

def _tsv(png, timeout=180):
    out = subprocess.run(['tesseract', png, 'stdout', '--psm', '6', 'tsv'],
                         capture_output=True, text=True, timeout=timeout)
    return out.stdout

def page_lines(page, clip=None, dpi=150):
    """[(text, y_top, x_left)] for a rendered page, top to bottom.

    The left edge matters as much as the top: a paper photocopied onto A3
    prints two columns per sheet, and a question in the right-hand column
    starts level with a different question on the left."""
    pix = page.get_pixmap(dpi=dpi, clip=clip)
    box = clip or page.rect
    scale = box.height / pix.height
    x0, y0 = box.x0, box.y0
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, 'p.png')
        pix.save(png)
        try: tsv = _tsv(png)
        except Exception: return []
    lines = {}
    for row in tsv.splitlines()[1:]:
        f = row.split('\t')
        if len(f) < 12: continue
        try: conf = float(f[10])
        except ValueError: continue
        word = f[11].strip()
        if not word or conf < 30: continue
        key = (f[1], f[2], f[3], f[4])            # page/block/par/line
        # level, page, block, par, line, word_num, left, top, width, height, conf, text
        left, top = int(f[6]), int(f[7])
        lines.setdefault(key, []).append((left, top, word))
    out = []
    for words in lines.values():
        words.sort()
        text = " ".join(w for _, _, w in words)
        y = y0 + min(t for _, t, _ in words) * scale
        x = x0 + min(l for l, _, _ in words) * scale
        out.append((text, y, x))
    out.sort(key=lambda t: t[1])
    return out

def doc_lines(doc, pages=None, cache=None):
    """OCR the given pages once and remember the result."""
    result = {}
    for pno in (pages if pages is not None else range(len(doc))):
        if cache is not None and pno in cache:
            result[pno] = cache[pno]; continue
        lines = page_lines(doc[pno])
        result[pno] = lines
        if cache is not None: cache[pno] = lines
    return result
