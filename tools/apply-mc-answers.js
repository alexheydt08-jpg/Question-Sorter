#!/usr/bin/env node
/* Fill in multiple-choice answer keys from a solutions document.

     node tools/apply-mc-answers.js keys.json            check only, writes nothing
     node tools/apply-mc-answers.js keys.json --write     apply to data.js / trials.js

   Multiple choice is stored as a letter in `answer`, never as a crop. The site
   already reads that field everywhere it matters — the reveal in Browse, the
   answer line in a generated practice paper, the back of a flashcard, and the
   answer key handed to the marker — so one letter lights all four up and costs
   nothing against the Pages budget.

   keys.json is a list of papers:

     [ { "subject": "Physics", "setter": "PEM", "year": 2023,
         "answers": { "1": "C", "2": "A", "3": "D" } } ]

   `setter` is the school or company that set the paper, or "NESA" for an HSC
   paper. Question numbers are the paper's own.

   Nothing is written unless every answer in the file passes: a wrong question
   number or an off-by-one run through a paper is far more expensive to find
   later than to reject here. Pass --overwrite to replace answers that are
   already recorded; without it, a question that already has one is an error. */
const fs = require("fs");
const { load, save, hasAnswer, paperKey } = require("./corpus");

const [, , keysPath, ...flags] = process.argv;
const write     = flags.includes("--write");
const overwrite = flags.includes("--overwrite");
if (!keysPath) { console.error("usage: apply-mc-answers.js <keys.json> [--write] [--overwrite]"); process.exit(2); }

const papers = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const sets = load();
const byPaper = new Map();
for (const set of sets)
  for (const r of set.records) {
    if (!byPaper.has(paperKey(r))) byPaper.set(paperKey(r), new Map());
    byPaper.get(paperKey(r)).set(r.questionNumber, { record: r, set });
  }

const problems = [];
const pending = [];          // [{ record, set, letter, was }]

for (const p of papers) {
  const key = `${p.subject}|${p.setter}|${p.year}`;
  const questions = byPaper.get(key);
  if (!questions) { problems.push(`no such paper in the corpus: ${key}`); continue; }

  for (const [num, raw] of Object.entries(p.answers || {})) {
    const where = `${key} Q${num}`;
    const letter = String(raw).trim().toUpperCase();
    if (!/^[A-D]$/.test(letter)) { problems.push(`${where}: "${raw}" is not an option letter`); continue; }

    const hit = questions.get(Number(num));
    if (!hit)                        { problems.push(`${where}: no question with that number`); continue; }
    if (hit.record.section !== "I")  { problems.push(`${where}: is section ${hit.record.section}, not multiple choice`); continue; }
    if (hasAnswer(hit.record) && !overwrite) {
      if (hit.record.answer !== letter)
        problems.push(`${where}: already recorded as ${hit.record.answer}, file says ${letter} — pass --overwrite to replace`);
      continue;                      // same letter already there: nothing to do
    }
    pending.push({ ...hit, letter, was: hit.record.answer });
  }
}

for (const p of problems) console.error(`  ! ${p}`);
if (problems.length) { console.error(`\n${problems.length} problem(s) — nothing written.`); process.exit(1); }

const touched = new Set(pending.map(p => paperKey(p.record)));
console.log(`${pending.length} answers to fill across ${touched.size} paper(s)` +
            (pending.length ? "" : " — nothing to do"));
for (const key of [...touched].sort()) {
  const forPaper = pending.filter(p => paperKey(p.record) === key)
                          .sort((a, b) => a.record.questionNumber - b.record.questionNumber);
  console.log(`  ${key}: ${forPaper.map(p => `Q${p.record.questionNumber}=${p.letter}` + (p.was ? ` (was ${p.was})` : "")).join(" ")}`);
}

if (!write) { console.log("\nCheck only. Re-run with --write to apply."); process.exit(0); }

for (const p of pending) p.record.answer = p.letter;
const changed = new Set(pending.map(p => p.set.file));
for (const set of sets) if (changed.has(set.file)) save(set);
console.log(`\nWrote ${[...changed].join(", ") || "nothing"}.`);
