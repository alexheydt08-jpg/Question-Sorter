"""Find a multiple-choice answer key in a solutions document.

Schools print the key in whatever shape their word processor made easy: a
two-column Question/Answer table, a grid with the numbers along one row and
the letters under them, or a plain list. Several of those shapes can appear
split in halves (1-10, then 11-20), so everything found on a page is merged
before the page is judged.

Two traps this guards against, both of which produce a full-looking key:

  - A question paper lists its options as "A." "B." "C." "D." under each
    question, so a loose text scan reads question 1 option A as "1 A" and
    comes back with twenty A's. Free text is therefore only read on a page
    that announces itself as answers, and never on its own.
  - A mapping grid is also a numbered table, so a key whose letters are
    nearly all the same, or which covers only part of the paper, is thrown
    away rather than trusted.
"""
import re, sys, os, json
from collections import Counter
LET = r'[A-Da-d]'
# One answer: a letter, optionally a second one the paper also accepts,
# written as "B and C", "C or D", "C/D" or just "BC".
CELL = LET + r'(?:\s*(?:and|or|AND|OR|/)\s*' + LET + r'|' + LET + r')?'
ANSWER_PAGE = re.compile(r'answer|solution|marking|key', re.I)

def blank_sheet(text):
    """A student answer sheet offers every option against every question —
    "(1) A B C D  (2) A B C D" — which a loose text scan misreads as a key
    saying every answer is A. Recognise the page and skip it."""
    runs = re.findall(r'\bA\b[\s\.\)]*\bB\b[\s\.\)]*\bC\b[\s\.\)]*\bD\b', text)
    return len(runs) >= 8

def _rows(page, tol=3.0):
    words = sorted(page.get_text('words'), key=lambda w: (w[1], w[0]))
    rows, cur, y = [], [], None
    for w in words:
        if y is None or abs(w[1] - y) <= tol: cur.append(w); y = w[1] if y is None else y
        else: rows.append(cur); cur, y = [w], w[1]
    if cur: rows.append(cur)
    return [[w[4] for w in sorted(r, key=lambda w: w[0])] for r in rows]

def _norm(cell):
    """Keep the paper's own wording for a question that accepts two options:
    NESA writes "B and C", a school may write "C or D", and a school filling
    in a grid of single letters may just write "BC"."""
    c = cell.strip().rstrip('.').upper()
    c = re.sub(r'\s*/\s*', ' or ', c)
    c = re.sub(r'\s*\bAND\b\s*', ' and ', c)
    c = re.sub(r'\s*\bOR\b\s*', ' or ', c)
    c = c.strip()
    if re.fullmatch(r'[A-D]{2}', c) and c[0] != c[1]:
        c = f'{c[0]} or {c[1]}'          # a grid cell reading "BC"
    return c

def _cell_key(rows, upto):
    """Rows shaped 'question number, answer', possibly several pairs wide.

    A key is often laid out two columns of pairs side by side —
    Question | Answer | Question | Answer — so walk each row looking for a
    number immediately followed by something that reads as an answer, rather
    than assuming the row holds one pair."""
    k = {}
    for toks in rows:
        for i in range(len(toks) - 1):
            a, b = toks[i].strip(), toks[i + 1].strip()
            if not re.fullmatch(r'\d{1,2}\.?', a): continue
            n, cell = int(a.rstrip('.')), _norm(b)
            if 1 <= n <= upto and re.fullmatch(r'[A-D](?: (?:and|or) [A-D])?', cell):
                k.setdefault(n, cell)
    return k

def _grid_key(rows, upto):
    """A row of numbers with its row of letters underneath."""
    k = {}
    for i in range(len(rows) - 1):
        top, bot = rows[i], rows[i + 1]
        if len(top) == len(bot) >= 4 and all(re.fullmatch(r'\d{1,2}', a) for a in top) \
                                     and all(re.fullmatch(CELL, b) for b in bot):
            for a, b in zip(top, bot):
                if 1 <= int(a) <= upto: k.setdefault(int(a), _norm(b))
    return k

def _ordered_key(rows, upto):
    """An answer table whose question numbers are Word list numbering.

    The numbers are generated when the document is displayed, so the cells
    read as empty and only the order survives. Accept it only when the table
    holds exactly as many answer rows as the paper has questions, so the
    row position can stand in for the number."""
    if not rows: return {}
    head = " ".join(rows[0]).lower()
    if 'answer' not in head: return {}
    body = rows[1:]
    if len(body) != upto: return {}
    k = {}
    for i, r in enumerate(body, start=1):
        cells = [c for c in r if c]
        cand = [c for c in cells if re.fullmatch(CELL, c.strip())]
        if len(cand) != 1: return {}
        k[i] = _norm(cand[0])
    return k

def _text_key(text, upto):
    """A question number followed by its option, keeping a second option when
    the paper accepts one ("12  C or D")."""
    k = {}
    pat = (r'(?<![\w.])(\d{1,2})\s*[\.\):\-]?\s+(' + LET +
           r'(?:\s*(?:and|or|/)\s*' + LET + r')?)(?![\w])')
    for m in re.finditer(pat, text):
        n = int(m.group(1))
        if 1 <= n <= upto: k.setdefault(n, _norm(m.group(2)))
    return k

def plausible(k, upto):
    """A real key covers every question and is not one letter repeated."""
    if len(k) < upto or any(i not in k for i in range(1, upto + 1)): return False
    spread = Counter(v[0] for v in k.values())
    return len(spread) >= 3 and max(spread.values()) <= upto * 0.6

def find(path, upto=20):
    """Best key found, with the page and the method that produced it."""
    import pymupdf
    best, bestwhy = {}, None
    def consider(k, why):
        nonlocal best, bestwhy
        if len(k) > len(best): best, bestwhy = dict(k), why

    if path.lower().endswith('.docx'):
        import docx
        d = docx.Document(path)
        merged = {}
        for ti, t in enumerate(d.tables):
            rows = [[c for c in (c.text.strip() for c in r.cells) if c] for r in t.rows]
            for fn in (_cell_key, _grid_key, _ordered_key):
                k = fn(rows, upto)
                merged.update({n: v for n, v in k.items() if n not in merged})
        consider(merged, 'docx tables')
        if plausible(merged, upto): return merged, 'docx tables'
        txt = "\n".join(p.text for p in d.paragraphs)
        if ANSWER_PAGE.search(txt[:4000]) and not blank_sheet(txt):
            k = _text_key(txt, upto)
            if plausible(k, upto): return k, 'docx text'
            consider(k, 'docx text')
        return best, bestwhy

    doc = pymupdf.open(path)
    # A key is sometimes split over two pages (1-10, then 11-20). Collect the
    # structured finds from every page and try the union at the end; a page
    # that contradicts another is dropped rather than merged.
    across, clash = {}, set()
    for pno, page in enumerate(doc):
        rows = _rows(page)
        merged = {}
        for fn in (_cell_key, _grid_key, _ordered_key):
            merged.update({n: v for n, v in fn(rows, upto).items() if n not in merged})
        try:
            for t in page.find_tables().tables:
                tr = [[c for c in ((c or '').strip() for c in r) if c] for r in t.extract()]
                for fn in (_cell_key, _grid_key, _ordered_key):
                    merged.update({n: v for n, v in fn(tr, upto).items() if n not in merged})
        except Exception: pass
        if plausible(merged, upto): return merged, f'p{pno+1} table/grid'
        consider(merged, f'p{pno+1} table/grid')
        for n, v in merged.items():
            if n in across and across[n] != v: clash.add(n)
            across.setdefault(n, v)
        txt = page.get_text()
        if ANSWER_PAGE.search(txt) and not blank_sheet(txt):
            k = _text_key(txt, upto)
            if plausible(k, upto): return k, f'p{pno+1} text'
            consider(k, f'p{pno+1} text')
    union = {n: v for n, v in across.items() if n not in clash}
    if plausible(union, upto): return union, 'table/grid across pages'
    consider(union, 'table/grid across pages')
    return best, bestwhy

if __name__ == '__main__':
    upto = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    k, how = find(sys.argv[1], upto)
    ok = plausible(k, upto)
    print(f"{'OK ' if ok else '   '} {len(k):2d}/{upto} {how or '-':18s} " +
          "".join(k.get(i, '?')[0] if k.get(i) else '?' for i in range(1, upto + 1)) +
          ("  multi:" + str({n: v for n, v in k.items() if len(v) > 1}) if any(len(v) > 1 for v in k.values()) else ""))
