#!/usr/bin/env python3
"""Cut written marking guidelines out of a paper's solutions, one per question.

    python3 tools/keys/cut_guidelines.py targets.json out.json

targets.json lists what to cut:

    [{"key": "Economics|NESA|2023",
      "source": "/abs/path/to/2023-hsc-economics-mg.pdf",
      "questions": {"21": "eco-2023-q21", "22": "eco-2023-q22"},
      "dir": "img"}]

Writes the crops under that directory and prints a report. out.json maps
each record id to its crops, ready for tools/apply-guidelines.js.

A paper is skipped rather than half-cut when its guidelines cannot be found
or its headings do not cover the questions asked for: a crop taken from the
wrong place is worse than a question that still says no solutions.
"""
import os, sys, json
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crop_guidelines as cg
import ocr_lines

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')

WORKDIR = os.environ.get('GUIDELINE_WORKDIR', '/tmp/guideline-pdfs')
OCR = os.environ.get('GUIDELINE_OCR', '1') != '0'

def is_two_up(doc):
    """A paper photocopied onto A3: landscape sheets, two columns each."""
    pages = [doc[i].rect for i in range(min(6, len(doc)))]
    wide = sum(1 for r in pages if r.width > r.height * 1.15)
    return wide > len(pages) / 2

def column_slices(doc, wanted):
    """Slice a two-up scan by column. Returns (slices, slots) or (None, None)."""
    pages = range(len(doc))
    slots = cg.slots_of(doc, pages)
    scanned = sum(len(doc[i].get_text().strip()) for i in pages) < 2000
    reader = (lambda page, rect: ocr_lines.page_lines(page, rect)) if scanned else None
    lines = cg.slot_lines(doc, slots, reader)
    sl = cg.slices_by_column(doc, wanted, slots, lines)
    return (sl, slots) if sl else (None, None)

def best_source(sources, wanted):
    """The file whose guidelines cover the most of the questions we need.

    A .docx is laid out first, since it has no pages of its own to crop."""
    os.makedirs(WORKDIR, exist_ok=True)
    best = (None, None, -1, None)
    for src in sources:
        path = cg.as_pdf(src, WORKDIR)
        if not path: continue
        try: doc = pymupdf.open(path)
        except Exception: continue
        # A two-up scan is never cut by band, however many headings banding
        # appears to find: every horizontal strip of such a page spans two
        # questions, so a confident-looking band is a wrong crop.
        if path.lower().endswith('.pdf') and is_two_up(doc): continue
        sl = cg.slices(doc, wanted)
        hit = sum(1 for q in wanted if q in sl)
        if hit > best[2]: best = (doc, sl, hit, src)
    # A two-up scan has to be cut by column, not by band: two questions share
    # every horizontal strip of the page.
    for src in sources:
        path = cg.as_pdf(src, WORKDIR)
        if not path or not path.lower().endswith('.pdf'): continue
        try: doc = pymupdf.open(path)
        except Exception: continue
        if not is_two_up(doc): continue
        sl, slots = column_slices(doc, wanted)
        if not sl: continue
        hit = sum(1 for q in wanted if q in sl)
        if hit > best[2]:
            best = (doc, sl, hit, src + ' [two columns per page]')
            best_source.slots = slots
    if best[2] > 0 or not OCR: return best
    # Nothing in any text layer: the solutions are a photograph of paper, so
    # read the pages to find out where each question's guidelines start.
    for src in sources:
        path = cg.as_pdf(src, WORKDIR)
        if not path or not path.lower().endswith('.pdf'): continue
        try: doc = pymupdf.open(path)
        except Exception: continue
        if is_two_up(doc): continue          # banding is wrong for these
        # Judging the whole file by its total text misses the common case: a
        # paper whose exam is typed and whose solutions are scanned in at the
        # back. Read each page the way that page needs, and only pay for OCR
        # on the pages that have nothing to read.
        lines = {}
        for pno, page in enumerate(doc):
            own = page.get_text().strip()
            if len(own) >= 150:
                lines[pno] = [(t, y) for t, y, *_ in cg.page_rows(page)]
            else:
                lines[pno] = ocr_lines.page_lines(page)
        sl = cg.slices_ocr(doc, wanted, lines)
        hit = sum(1 for q in wanted if q in sl)
        if hit > best[2]:
            best = (doc, sl, hit, src + ' [read by OCR]')
            best_source.lines = lines
    return best

def cut(target, report):
    sources = target.get('sources') or [target['source']]
    wanted = [int(q) for q in target['questions']]
    doc, sl, hit, used = best_source(sources, wanted)
    if doc is None:
        report.append((target['key'], 'cannot open any source', 0)); return {}
    target['ocr_used'] = bool(used and ('[read by OCR]' in str(used) or 'two columns' in str(used)))
    target['columns'] = bool(used and 'two columns' in str(used))
    if not sl or hit == 0:
        report.append((target['key'], 'no marking guidelines found in its files', 0)); return {}
    outdir = os.path.join(ROOT, target['dir'])
    os.makedirs(outdir, exist_ok=True)
    made, missed = {}, []
    for qs, rid in sorted(target['questions'].items(), key=lambda kv: int(kv[0])):
        q = int(qs)
        if q not in sl: missed.append(q); continue
        # Only cut what actually reads like guidelines. A heading can be found
        # on a page of the exam paper, and cropping there would put the
        # question itself on the back of the card instead of its answer.
        if target.get('columns'):
            pass                      # the rising run already proved the order
        elif target.get('ocr_used'):
            lines = getattr(best_source, 'lines', {})
            (sp, sy), (ep, ey) = sl[q]
            seen = " ".join(l[0] for pno in range(sp, ep + 1)
                            for l in lines.get(pno, [])
                            if (pno > sp or l[1] >= sy - 8) and (pno < ep or l[1] <= ey + 8))
            if not cg.reads_like_guidelines(seen): missed.append(q); continue
        elif not cg.reads_like_guidelines(cg.region_text(doc, sl[q][0], sl[q][1])):
            missed.append(q); continue
        files = (cg.crop_columns(doc, best_source.slots, sl[q][0], sl[q][1], os.path.join(outdir, rid))
                 if target.get('columns')
                 else cg.crop(doc, sl[q][0], sl[q][1], os.path.join(outdir, rid)))
        if not files: missed.append(q); continue
        made[rid] = [os.path.relpath(f, ROOT).replace(os.sep, '/') for f in files]
    note = f'{len(made)}/{len(target["questions"])} questions'
    if missed: note += f' (no heading for Q{",".join(str(m) for m in missed)})'
    report.append((target['key'], note, sum(len(v) for v in made.values())))
    return made

if __name__ == '__main__':
    targets = json.load(open(sys.argv[1]))
    out, report = {}, []
    for t in targets:
        out.update(cut(t, report))
    json.dump(out, open(sys.argv[2], 'w'), indent=1)
    for key, note, n in report:
        print(f'  {key:34s} {note:52s} {n} crops')
    total = sum(os.path.getsize(os.path.join(ROOT, f)) for v in out.values() for f in v)
    print(f'\n{len(out)} questions, {sum(len(v) for v in out.values())} crops, {total/1048576:.1f} MB')
