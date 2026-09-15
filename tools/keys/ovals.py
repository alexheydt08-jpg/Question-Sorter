"""Read an answer key off a marked-up multiple-choice answer sheet.

Some schools publish the key by taking the blank student answer sheet and
filling in the correct oval. There is no text to read — the answer is a
coloured shape — so pair each filled oval with the option letter printed
beside it and the question number at the start of its row.

A row with two filled ovals means the paper accepted either option; that is
kept rather than resolved to one letter."""
import re, sys, os
import pymupdf

def _is_marked(d):
    """A filled shape that is not the black printing or a white background."""
    f = d.get('fill')
    if not f or d.get('type') not in ('f', 'fs'): return False
    r = d['rect']
    if not (3 <= r.width <= 40 and 3 <= r.height <= 30): return False
    if max(f) > 0.93 and min(f) > 0.93: return False        # white
    if max(f) < 0.25: return False                           # black text/rule
    return True

def key_of_page(page, upto=20, tol=6.0):
    words = page.get_text('words')
    letters = [w for w in words if re.fullmatch(r'[A-D]', w[4])]
    numbers = [w for w in words if re.fullmatch(r'\d{1,2}\.?', w[4])
               and 1 <= int(w[4].rstrip('.')) <= upto]
    marks = [d['rect'] for d in page.get_drawings() if _is_marked(d)]
    if not marks or not letters: return {}
    hits = {}
    for m in marks:
        my = (m.y0 + m.y1) / 2
        near = [w for w in letters if abs((w[1] + w[3]) / 2 - my) <= tol and w[2] <= m.x0 + 4]
        if not near: continue
        lab = max(near, key=lambda w: w[2])                  # the letter just left of it
        if m.x0 - lab[2] > 28: continue                      # too far to be its label
        # A sheet is often laid out in two columns, so the same row carries
        # question 1 and question 11. Take the number nearest to the left of
        # this option, not the first one on the line.
        row = [w for w in numbers if abs((w[1] + w[3]) / 2 - my) <= tol and w[2] <= lab[0]]
        if not row: continue
        q = int(max(row, key=lambda w: w[2])[4].rstrip('.'))
        hits.setdefault(q, []).append(lab[4])
    out = {}
    for q, ls in hits.items():
        ls = sorted(set(ls))
        if len(ls) == 1: out[q] = ls[0]
        elif len(ls) == 2: out[q] = f'{ls[0]} or {ls[1]}'
    return out

def find(path, upto=20):
    doc = pymupdf.open(path)
    best, why = {}, None
    for pno, page in enumerate(doc):
        k = key_of_page(page, upto)
        if len(k) > len(best): best, why = k, f'ovals p{pno+1}'
        if len(k) >= upto: return k, f'ovals p{pno+1}'
    return best, why

if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import mcfind
    k, why = find(sys.argv[1], 20)
    print(f"{'OK ' if mcfind.plausible(k,20) else '   '} {len(k):2d}/20 {why or '-':12s} " +
          "".join(k.get(i,'?')[0] if k.get(i) else '?' for i in range(1,21)) +
          ("  multi:" + str({n:v for n,v in k.items() if len(v)>1}) if any(len(v)>1 for v in k.values()) else ""))
