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

# Phrases a marking scheme uses and a question paper does not. The band
# descriptors matter as much as the headings: plenty of schools set their
# criteria out with no heading at all, in the words NESA marks to.
GUIDE_WORDS = re.compile(r'criteria|marking guidelines|sample answer|suggested answer|'
                         r'answers (?:could|may|might) include|marking guide|marks awarded|'
                         r'targeted performance bands?|outcomes assessed|'
                         r'sketches in general terms|provides? some relevant information|'
                         r'demonstrates? (?:extensive|thorough|sound|limited|factually)', re.I)
END_WORDS = re.compile(r'mapping grid|syllabus outcomes assessed|^\s*appendix', re.I | re.M)
# Some papers put their own reference code in front of the heading —
# "Q5214 Question 25" — so allow one short token before it.
HEADING = re.compile(r'^(?:[A-Za-z]\d{3,6}\s+)?(?:Question|Q)\s*(\d{1,2})\b(?!\d)', re.I)
# Some papers head a question with the bare number and its part — "21 a.",
# "22 b. (i)" — which is too weak a pattern to trust on its own, so it is
# only accepted for a question number the caller is actually looking for.
BARE = re.compile(r'^(\d{1,2})\s*(?:[a-z]\s*)?[.)]?$|^(\d{1,2})\s*[a-z]?\s*[.)]')
# A line holding nothing but a number is as likely to be the page number as
# the start of a question, so a bare heading is only believed inside the body
# of the page and when guidelines follow it.
MARGIN = 0.07
LOOKAHEAD = 150.0
# A "Q24" loose in a line was tried as a heading and turned out to match the
# running header printed at the top of every page of some papers, which put
# the crop in the wrong place. Headings must stand on their own line.

HERE = os.path.dirname(os.path.abspath(__file__))

PRINT_CSS = """
<meta charset="utf-8">
<style>
 body { font: 12pt/1.45 'DejaVu Sans', Arial, sans-serif; color: #000; margin: 0; }
 table { border-collapse: collapse; width: 100%; margin: 6pt 0 12pt; page-break-inside: auto; }
 td, th { border: 1px solid #444; padding: 4pt 6pt; vertical-align: top; }
 tr { page-break-inside: avoid; }
 p { margin: 4pt 0; }
 img { max-width: 100%; vertical-align: middle; }
 img.lost, img[src=""] { display: none; }
 h1, h2, h3, strong { font-weight: 700; }
</style>
"""

def as_pdf(path, workdir):
    """A .docx has no pages until something lays it out.

    LibreOffice cannot open these files, so the document is converted to
    HTML and printed by the browser that is already installed. The content —
    the criteria tables, sample answers and diagrams — survives; only the
    school's original pagination is lost, which does not matter because the
    crops are cut by heading, not by page."""
    if path.lower().endswith('.pdf'): return path
    stem = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(workdir, stem + '.pdf')
    if os.path.exists(out): return out
    try:
        import mammoth, base64, tempfile as _tf
    except ImportError:
        return None

    def _image(image):
        """Word stores an equation as an OLE object with a metafile preview.

        A browser cannot draw a .wmf, so those previews would come out as
        broken-image icons and the formulae in the guidelines would be lost.
        Convert them with libwmf and hand the browser a PNG."""
        with image.open() as fh:
            raw = fh.read()
        ctype = (image.content_type or '').lower()
        if 'wmf' in ctype or 'emf' in ctype:
            with _tf.TemporaryDirectory() as td:
                src = os.path.join(td, 'e.wmf'); dst = os.path.join(td, 'e.png')
                open(src, 'wb').write(raw)
                subprocess.run(['wmf2gd', '-t', 'png', '-o', dst, src],
                               capture_output=True, timeout=60)
                if os.path.exists(dst) and os.path.getsize(dst) > 0:
                    raw, ctype = open(dst, 'rb').read(), 'image/png'
                else:
                    return {'src': '', 'class': 'lost'}
        return {'src': f'data:{ctype};base64,' + base64.b64encode(raw).decode('ascii')}

    html = os.path.join(workdir, stem + '.html')
    with open(path, 'rb') as fh:
        body = mammoth.convert_to_html(
            fh, convert_image=mammoth.images.img_element(_image)).value
    with open(html, 'w', encoding='utf-8') as fh:
        fh.write(PRINT_CSS + body)
    r = subprocess.run(['node', os.path.join(HERE, 'html_to_pdf.mjs'), html, out],
                       capture_output=True, timeout=600)
    return out if os.path.exists(out) else None

# Not every marking scheme announces itself. Neap's sets the descriptors out
# as dot-leadered bullets that end in the marks they earn — "Gives correct
# answer . . . . . 2" — and names the band each part is pitched at, with no
# "Criteria" heading anywhere in sight.
LEADERS = re.compile(r'(?:\.\s*){3,}\s*\d\b')
BAND = re.compile(r'\bBands?\s+\d\b')
# The leader is sometimes a private-use glyph rather than a run of dots, so
# fall back on the shape itself: a bullet whose line ends in the mark it earns.
EARNS = re.compile(r'^[\s\u2022\u2023\u25cf\u00b7•-]*\S.{4,150}?\D(\d{1,2})\s*$', re.M)

def reads_like_guidelines(text):
    """Marking guidelines say what earns the marks; a question does not."""
    text = text or ''
    return bool(GUIDE_WORDS.search(text) or BAND.search(text)
                or len(LEADERS.findall(text)) >= 2
                or len(EARNS.findall(text)) >= 3)

def page_rows(page, clip=None):
    """Every text line of a page as (text, y, x, y_bottom), in reading order.

    A page can be stored rotated — landscape sheets usually are — and then
    get_text reports bboxes in the unrotated space while page.rect, pixmap
    clips and everything we crop with use the rotated one. Mapping the bbox
    through rotation_matrix puts each line back where a reader sees it. On an
    unrotated page the matrix is the identity, so this changes nothing."""
    m = page.rotation_matrix
    rows = []
    for block in page.get_text('dict')['blocks']:
        if block.get('type') != 0: continue
        for line in block['lines']:
            r = pymupdf.Rect(line['bbox']) * m
            r.normalize()
            if clip is not None and not (clip.x0 - 1 <= (r.x0 + r.x1) / 2 <= clip.x1 + 1
                                         and clip.y0 - 1 <= (r.y0 + r.y1) / 2 <= clip.y1 + 1):
                continue
            rows.append(("".join(sp['text'] for sp in line['spans']).strip(),
                         r.y0, r.x0, r.y1))
    rows.sort(key=lambda t: (t[1], t[2]))
    return rows

def page_blocks(page):
    """Every text block as (text, y), in the page's displayed coordinates."""
    m = page.rotation_matrix
    out = []
    for block in page.get_text('dict')['blocks']:
        if block.get('type') != 0: continue
        r = pymupdf.Rect(block['bbox']) * m
        r.normalize()
        out.append((" ".join("".join(sp['text'] for sp in line['spans'])
                             for line in block['lines']).strip(), r.y0))
    out.sort(key=lambda t: t[1])
    return out

def guideline_pages(doc):
    """The pages that carry marking guidelines rather than the exam paper."""
    scored = [bool(GUIDE_WORDS.search(p.get_text())) for p in doc]
    if not any(scored): return None
    first = scored.index(True)
    last = len(scored) - 1 - scored[::-1].index(True)
    return first, last

def _guidelines_follow(entries, i, page_height, next_page=None):
    """Do marking guidelines start just below this line?

    A heading can be the last thing on a page, with its guidelines overleaf,
    so when nothing useful follows on this page look at the top of the next
    one rather than rejecting the heading."""
    y0 = entries[i][1]
    ahead = " ".join(t for t, y in entries[i + 1:i + 9] if y0 < y <= y0 + LOOKAHEAD)
    if GUIDE_WORDS.search(ahead): return True
    if next_page and y0 > page_height * 0.72:
        return bool(GUIDE_WORDS.search(" ".join(t for t, _ in next_page[:8])))
    return False

def headings(doc, lo, hi, wanted=None):
    """Where each question's guidelines begin: (question, page, y).

    "Question 24" is unambiguous. A bare "24 a." or a "Q24" buried in a
    running header is not — plenty of other things on a page start with a
    number — so those are only read as headings for a question number the
    caller asked for, which is what keeps a marks column or a numbered list
    from being mistaken for the start of a question."""
    want = set(wanted or ())
    out = []
    by_page = {}
    for pno in range(lo, hi + 1):
        by_page[pno] = [(t, y) for t, y, *_ in page_rows(doc[pno])]
    for pno in range(lo, hi + 1):
        page = doc[pno]
        h = page.rect.height
        entries = by_page[pno]
        nxt = by_page.get(pno + 1)
        for i, (text, y) in enumerate(entries):
            n = None
            m = HEADING.match(text)
            if m:
                n = int(m.group(1))
            elif want and len(text) <= 24:
                m = BARE.match(text)
                if m:
                    cand = int(m.group(1) or m.group(2))
                    if (cand in want and h * MARGIN < y < h * (1 - MARGIN)
                            and _guidelines_follow(entries, i, h, nxt)):
                        n = cand
            if n is not None and 1 <= n <= 60:
                out.append((n, pno, y))
    out.sort(key=lambda t: (t[1], t[2]))
    return out

def end_of_guidelines(doc, lo, hi):
    """Where the guidelines stop and the mapping grid or an appendix starts.

    Stop at the top of the block that announces it, not at the matching
    line: a heading like "2020 HSC Economics / Mapping Grid" wraps, and
    cutting at the second line leaves the first hanging off the end of the
    last question's guidelines."""
    for pno in range(lo, hi + 1):
        for text, y in page_blocks(doc[pno]):
            if END_WORDS.search(text):
                return (pno, y)
    return (hi, doc[hi].rect.y1)

def slices(doc, wanted=None):
    """{question number: (start, end)} over the guidelines, in page order.

    A question runs from its own heading to the heading of the next question
    with a higher number, so sub-parts printed as separate headings — NESA
    writes "Question 21 (a)" then "Question 21 (c)" — stay with their
    question instead of cutting it short."""
    pages = guideline_pages(doc)
    if not pages: return {}
    lo, hi = pages
    marks = headings(doc, lo, hi, wanted)
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

def region_text(doc, start, end):
    """The text of the region between two headings, as far as the page knows."""
    (spno, sy), (epno, ey) = start, end
    out = []
    for pno in range(spno, min(epno, len(doc) - 1) + 1):
        page = doc[pno]
        r = page.rect
        top = sy if pno == spno else r.y0
        bot = ey if pno == epno else r.y1
        out.append("\n".join(t for t, y, _, y1 in page_rows(page) if y1 > top and y < bot))
    return "\n".join(out)

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


# ---------------------------------------------------------------------------
# Scanned guidelines
#
# A photographed solutions booklet has no text to search, so the headings are
# found by reading the rendered page with tesseract. Only the positions come
# from the recognised text; every crop is still cut from the original page, so
# a misread word costs nothing a student can see.

def _lines_pages(lines_by_page):
    """The pages whose recognised text reads like marking guidelines."""
    hits = sorted(p for p, lines in lines_by_page.items()
                  if GUIDE_WORDS.search(" ".join(l[0] for l in lines)))
    return (hits[0], hits[-1]) if hits else None

def _lines_headings(lines_by_page, lo, hi, wanted, doc_height=842.0):
    want = set(wanted or ())
    out = []
    for pno in range(lo, hi + 1):
        entries = sorted(((l[0].strip(), l[1]) for l in lines_by_page.get(pno, [])),
                         key=lambda t: t[1])
        nxt = sorted(((l[0].strip(), l[1]) for l in lines_by_page.get(pno + 1, [])),
                     key=lambda t: t[1])
        h = doc_height
        for i, (text, y) in enumerate(entries):
            n = None
            m = HEADING.match(text)
            if m:
                n = int(m.group(1))
            elif want and len(text) <= 24:
                m = BARE.match(text)
                if m:
                    cand = int(m.group(1) or m.group(2))
                    if (cand in want and h * MARGIN < y < h * (1 - MARGIN)
                            and _guidelines_follow(entries, i, h, nxt)):
                        n = cand
            if n is not None and 1 <= n <= 60:
                out.append((n, pno, y))
    out.sort(key=lambda t: (t[1], t[2]))
    return out

def slices_ocr(doc, wanted, lines_by_page):
    """Like slices(), but positioned from recognised text."""
    pages = _lines_pages(lines_by_page)
    if not pages: return {}
    lo, hi = pages
    marks = _lines_headings(lines_by_page, lo, hi, wanted, doc[lo].rect.height)
    if not marks: return {}
    stop = (hi, doc[hi].rect.y1)
    for pno in range(lo, hi + 1):
        for line in lines_by_page.get(pno, []):
            text, y = line[0], line[1]
            if END_WORDS.search(text):
                stop = (pno, max(0, y - 26)); break
        else:
            continue
        break
    marks = [m for m in marks if (m[1], m[2]) < stop]
    if not marks: return {}
    out = {}
    for i, (n, pno, y) in enumerate(marks):
        if n in out: continue
        nxt = next(((p, yy) for (m, p, yy) in marks[i+1:] if m > n), stop)
        out[n] = ((pno, y - 6), nxt)
    return out


# ---------------------------------------------------------------------------
# Two-column scans
#
# A paper photocopied onto A3 puts two portrait columns on one landscape sheet,
# so "Question 22" and "Question 23" print side by side and share a top edge.
# Cutting such a page into horizontal bands takes half of one question and half
# of another. These pages are read as a sequence of columns instead: left then
# right, page after page, which is the order a reader follows.

def slots_of(doc, pages):
    """Reading-order columns: [(page number, clip rect)]."""
    out = []
    for pno in pages:
        r = doc[pno].rect
        if r.width > r.height * 1.15:            # landscape: an A3 two-up scan
            mid = (r.x0 + r.x1) / 2
            out.append((pno, pymupdf.Rect(r.x0, r.y0, mid, r.y1)))
            out.append((pno, pymupdf.Rect(mid, r.y0, r.x1, r.y1)))
        else:
            out.append((pno, r))
    return out

def slot_lines(doc, slots, ocr):
    """Recognised lines per column, so a heading is found in its own column."""
    out = {}
    for i, (pno, rect) in enumerate(slots):
        page = doc[pno]
        if ocr:
            out[i] = [(l[0], l[1]) for l in ocr(page, rect)]
        else:
            out[i] = [(t, y) for t, y, *_ in page_rows(page, rect)]
    return out

def slices_by_column(doc, wanted, slots, lines_by_slot):
    """{question: ((slot, y), (slot, y))} following the columns in order."""
    keep = [i for i, l in lines_by_slot.items()
            if GUIDE_WORDS.search(" ".join(t for t, _ in l))]
    if not keep: return {}
    lo, hi = min(keep), max(keep)
    marks = []
    for i in range(lo, hi + 1):
        rect = slots[i][1]
        h = rect.height
        entries = lines_by_slot.get(i, [])
        for j, (text, y) in enumerate(entries):
            n = None
            m = HEADING.match(text)
            if m: n = int(m.group(1))
            elif wanted and len(text) <= 24:
                m = BARE.match(text)
                if m:
                    cand = int(m.group(1) or m.group(2))
                    if (cand in set(wanted) and rect.y0 + h * MARGIN < y < rect.y1 - h * MARGIN
                            and _guidelines_follow(entries, j, h)):
                        n = cand
            if n is not None and 1 <= n <= 60:
                marks.append((n, i, y))
    if not marks: return {}
    marks.sort(key=lambda t: (t[1], t[2]))
    stop = (hi, slots[hi][1].y1)

    # A question can be headed more than once. These scans staple the paper's
    # errata onto its guidelines — "Question 24(a) Answer should be ..." — and
    # elsewhere a question is mentioned in passing. Neither is that question's
    # guidelines, and picking the first or the longest match gets it wrong both
    # ways round.
    #
    # What separates the real headings from the rest is that guidelines run in
    # question order, front to back. So keep the longest run of headings whose
    # numbers increase through the document and drop everything off it: an
    # erratum for question 24 sitting in front of question 22's guidelines
    # cannot be part of that run, however it is worded.
    best = _rising_run(marks)
    if not best: return {}
    out = {}
    for k, (n, i, y) in enumerate(best):
        nxt = (best[k+1][1], best[k+1][2]) if k + 1 < len(best) else stop
        out[n] = ((i, y - 4), nxt)

    # Some papers bind the exam and its guidelines into one file, so a question
    # is headed twice — once where it is asked, once where it is marked — and
    # both headings sit on the rising run. Cropping the first would put the
    # question on the back of the card instead of its answer, so where a span
    # does not read like guidelines, take a later heading for that same
    # question that does, and if there is none, leave the question uncut.
    for n in list(out):
        if reads_like_guidelines(column_text(lines_by_slot, *out[n])): continue
        alt = None
        for k, (m, i, y) in enumerate(marks):
            if m != n or (i, y - 4) == out[n][0]: continue
            nxt = next(((p, yy) for (q, p, yy) in marks[k+1:] if q > n), stop)
            span = ((i, y - 4), nxt)
            if reads_like_guidelines(column_text(lines_by_slot, *span)):
                alt = span; break
        if alt: out[n] = alt
        else: del out[n]
    return out

def column_text(lines_by_slot, start, end):
    """The text of a span that runs from one column into another."""
    (si, sy), (ei, ey) = start, end
    parts = []
    for i in range(si, ei + 1):
        for t, y in lines_by_slot.get(i, []):
            if (i > si or y >= sy - 8) and (i < ei or y <= ey + 8):
                parts.append(t)
    return " ".join(parts)

def _rising_run(marks):
    """The longest run of headings, in page order, whose numbers increase."""
    if not marks: return []
    best_len = [1] * len(marks)
    prev = [-1] * len(marks)
    for i in range(len(marks)):
        for j in range(i):
            if marks[j][0] < marks[i][0] and best_len[j] + 1 > best_len[i]:
                best_len[i] = best_len[j] + 1
                prev[i] = j
    end = max(range(len(marks)), key=lambda i: best_len[i])
    run = []
    while end != -1:
        run.append(marks[end]); end = prev[end]
    return run[::-1]

def crop_columns(doc, slots, start, end, out_prefix, dpi=150, quality=72, max_width=1000):
    """Render the region between two headings, one image per column it spans."""
    (si, sy), (ei, ey) = start, end
    saved = []
    for i in range(si, min(ei, len(slots) - 1) + 1):
        pno, rect = slots[i]
        top = sy if i == si else rect.y0
        bot = ey if i == ei else rect.y1
        if bot - top < 18: continue
        clip = pymupdf.Rect(rect.x0, max(rect.y0, top), rect.x1, min(rect.y1, bot))
        pix = doc[pno].get_pixmap(dpi=dpi, clip=clip)
        img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
        img = _trim(img)
        if img is None or img.width < 60 or img.height < 40: continue
        if img.width > max_width:
            img = img.resize((max_width, max(1, round(img.height * max_width / img.width))), Image.LANCZOS)
        path = f'{out_prefix}-mg{len(saved)}.webp'
        _save(img, path, quality)
        saved.append(path)
        if len(saved) >= 4: break
    return saved
