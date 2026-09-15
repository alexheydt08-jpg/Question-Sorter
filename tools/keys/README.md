# Reading answer keys out of a paper's solutions

Offline tools, not part of the site. They take the PDF or DOCX a school or
exam company published its solutions in and pull out the multiple-choice
answer key, which `tools/apply-mc-answers.js` then writes into the corpus.

    python3 -m pip install pymupdf python-docx

- `mcfind.py <file> [n]` — the usual case: a key printed as text. Handles a
  two-column Question/Answer table, several such pairs side by side, a grid
  with the numbers along the top, a list, and a key split across two pages.
- `ovals.py <file> [n]` — a key published by filling in the correct oval on
  the blank answer sheet, where there is no text to read.
- `provenance.py` — checks that a document really is the paper you think it
  is, by looking for the paper's own question text inside it.

Both finders return `{question number: answer}` and refuse to guess. What
they are guarding against, in both cases learned the hard way:

- A question paper prints its options as "A." "B." "C." "D." under each
  question, so a loose scan reads twenty questions as twenty A's. A key
  whose letters are nearly all the same is thrown away, and a page that
  offers every option against every question is recognised as a blank
  student answer sheet and skipped.
- A mapping grid is also a numbered table, so a key that does not cover
  every question is thrown away rather than half-trusted.
- A paper that accepts two options for a question it judged flawed writes
  "B and C", "C or D", "C/D" or "BC", or fills in two ovals. That is kept in
  the paper's own wording, never flattened to the first letter.

Scanned papers have no text layer and their bordered tables defeat OCR;
those keys were read by eye and are recorded in the commit that added them.
