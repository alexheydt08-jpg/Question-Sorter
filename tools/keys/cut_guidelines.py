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

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')

def cut(target, report):
    src = target['source']
    try:
        doc = pymupdf.open(src)
    except Exception as e:
        report.append((target['key'], 'cannot open source', 0)); return {}
    sl = cg.slices(doc)
    if not sl:
        report.append((target['key'], 'no marking guidelines found in the source', 0)); return {}
    outdir = os.path.join(ROOT, target['dir'])
    os.makedirs(outdir, exist_ok=True)
    made, missed = {}, []
    for qs, rid in sorted(target['questions'].items(), key=lambda kv: int(kv[0])):
        q = int(qs)
        if q not in sl: missed.append(q); continue
        files = cg.crop(doc, sl[q][0], sl[q][1], os.path.join(outdir, rid))
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
