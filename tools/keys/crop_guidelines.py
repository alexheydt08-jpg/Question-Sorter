"""Cut a paper's written marking guidelines into one crop per question.

Browse shows a question's guidelines as images, so a guidelines document has
to be sliced the way the original cutter sliced one: find where each
question's guidelines start, and take everything down to where the next
question's start.

Two things this gets right that are easy to get wrong:

  - A trial paper often prints the exam and the solutions in one file, so
    "Question 23" appears twice. Only the run of headings inside the
    guidelines — the pages that also talk about criteria, marks and sample
    answers — is used.
  - The last question has no following heading to stop at, so it would
    otherwise swallow whatever comes next, which is how guideline crops
    previously leaked into the last question of every NESA paper. It stops
    at the end of the guidelines, and anything that looks like a mapping
    grid or an appendix ends them.
"""
import os, re, io, subprocess, tempfile
import pymupdf
from PIL import Image

GUIDE_WORDS = re.compile(r'criteria|marking guidelines|sample answer|suggested answer|'
                         r'answers could include|marking guide|marks awarded', re.I)
END_WORDS = re.compile(r'mapping grid|syllabus outcomes assessed|^\s*appendix', re.I | re.M)
HEADING = re.compile(r'^(?:Question|Q)\s*(\d{1,2})\b', re.I)

def as_pdf(path, workdir):
    """LibreOffice renders a .docx so its guidelines can be cropped like any page."""
    if path.lower().endswith('.pdf'): return path
    out = os.path.join(workdir, os.path.splitext(os.path.basename(path))[0] + '.pdf')
    if not os.path.exists(out):
        subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', workdir, path],
                       capture_output=True, timeout=300)
    return out if os.path.exists(out) else None

def guideline_pages(doc):
    """The pages that carry marking guidelines rather than the exam paper."""
    scored = [bool(GUIDE_WORDS.search(p.get_text())) for p in doc]
    if not any(scored): return None
    first = scored.index(True)
    last = len(scored) - 1 - scored[::-1].index(True)
    return first, last

def headings(doc, lo, hi):
    """Where each question's guidelines begin: (question, page, y)."""
    out = []
    for pno in range(lo, hi + 1):
        page = doc[pno]
        for block in page.get_text('dict')['blocks']:
            if block.get('type') != 0: continue
            for line in block['lines']:
                text = "".join(s['text'] for s in line['spans']).strip()
                m = HEADING.match(text)
                if not m: continue
                n = int(m.group(1))
                if 1 <= n <= 60:
                    out.append((n, pno, line['bbox'][1]))
    out.sort(key=lambda t: (t[1], t[2]))
    return out

def end_of_guidelines(doc, lo, hi):
    """Where the guidelines stop and the mapping grid or an appendix starts.

    Stop at the top of the block that announces it, not at the matching
    line: a heading like "2020 HSC Economics / Mapping Grid" wraps, and
    cutting at the second line leaves the first hanging off the end of the
    last question's guidelines."""
    for pno in range(lo, hi + 1):
        page = doc[pno]
        for block in page.get_text('dict')['blocks']:
            if block.get('type') != 0: continue
            text = " ".join("".join(s['text'] for s in line['spans'])
                            for line in block['lines']).strip()
            if END_WORDS.search(text):
                return (pno, block['bbox'][1])
    return (hi, doc[hi].rect.y1)

def slices(doc):
    """{question number: (start, end)} over the guidelines, in page order.

    A question runs from its own heading to the heading of the next question
    with a higher number, so sub-parts printed as separate headings — NESA
    writes "Question 21 (a)" then "Question 21 (c)" — stay with their
    question instead of cutting it short."""
    pages = guideline_pages(doc)
    if not pages: return {}
    lo, hi = pages
    marks = headings(doc, lo, hi)
    if not marks: return {}
    stop = end_of_guidelines(doc, lo, hi)
    marks = [m for m in marks if (m[1], m[2]) < stop]
    if not marks: return {}
    out = {}
    for i, (n, pno, y) in enumerate(marks):
        if n in out: continue                       # keep the first heading for a question
        nxt = next(((p, yy) for (m, p, yy) in marks[i+1:] if m > n), stop)
        out[n] = ((pno, y), nxt)
    return out

def _trim(img, pad=6):
    """Cut a crop down to what is actually printed on it.

    Trimming to the outer bounding box is not enough: a page footer sits at
    the bottom of an otherwise empty half-page, so the box stretches to the
    foot of the page and the crop is mostly white. Find the bands of ink
    instead, and drop a small trailing band that a wide gap separates from
    the rest — that is the running footer, not part of the answer."""
    g = img.convert('L')
    w, h = g.size
    px = g.load()
    ink = bytearray(h)
    step = max(1, w // 400)
    for y in range(h):
        for x in range(0, w, step):
            if px[x, y] < 200:
                ink[y] = 1; break
    bands, start = [], None
    for y in range(h):
        if ink[y] and start is None: start = y
        elif not ink[y] and start is not None: bands.append((start, y)); start = None
    if start is not None: bands.append((start, h))
    if not bands: return None
    # merge bands separated by only a line or two of white
    merged = [list(bands[0])]
    for a, b in bands[1:]:
        if a - merged[-1][1] <= max(6, h * 0.02): merged[-1][1] = b
        else: merged.append([a, b])
    while len(merged) > 1:
        a, b = merged[-1]
        gap = a - merged[-2][1]
        if (b - a) <= h * 0.06 and gap >= h * 0.08: merged.pop()
        else: break
    top, bot = merged[0][0], merged[-1][1]
    # columns too
    box = g.crop((0, top, w, bot)).point(lambda v: 0 if v > 244 else 255).getbbox()
    x0, x1 = (box[0], box[2]) if box else (0, w)
    return img.crop((max(0, x0 - pad), max(0, top - pad),
                     min(w, x1 + pad), min(h, bot + pad)))

def _save(img, path, quality=72):
    """Write a crop in whatever form keeps it small and readable.

    Marking guidelines are mostly black text and ruled tables, which lossy
    WebP handles badly — it is several times larger than lossless and blurs
    the strokes. Take the two-tone lossless path when the crop really is
    line art, and keep more of the range only when there is a photograph or
    a shaded diagram to lose."""
    g = img.convert('L')
    hist = g.histogram()
    total = sum(hist) or 1
    midtone = sum(hist[60:200]) / total
    if midtone < 0.04:
        g.point(lambda v: 255 if v > 176 else 0).save(path, 'WEBP', lossless=True, method=5)
    elif midtone < 0.18:
        g.quantize(colors=16, dither=Image.NONE).convert('RGB').save(
            path, 'WEBP', lossless=True, method=5)
    else:
        img.save(path, 'WEBP', quality=quality, method=5)

def crop(doc, start, end, out_prefix, dpi=130, quality=72, max_width=1000):
    """Render the region between two headings, one image per page it spans."""
    (spno, sy), (epno, ey) = start, end
    saved = []
    for pno in range(spno, min(epno, len(doc) - 1) + 1):
        page = doc[pno]
        r = page.rect
        top = sy - 4 if pno == spno else r.y0
        bot = ey - 2 if pno == epno else r.y1
        if bot - top < 18: continue
        pix = page.get_pixmap(dpi=dpi, clip=pymupdf.Rect(r.x0, top, r.x1, bot))
        img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
        img = _trim(img)
        if img is None or img.width < 60 or img.height < 40: continue
        if img.width > max_width:
            img = img.resize((max_width, max(1, round(img.height * max_width / img.width))), Image.LANCZOS)
        path = f'{out_prefix}-mg{len(saved)}.webp'
        _save(img, path, quality)
        saved.append(path)
        if len(saved) >= 4: break        # a question's guidelines are never longer than this
    return saved
