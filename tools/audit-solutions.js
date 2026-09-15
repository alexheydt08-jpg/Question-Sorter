#!/usr/bin/env node
/* What is still missing a solution, paper by paper.

     node tools/audit-solutions.js            summary to stdout
     node tools/audit-solutions.js --json     the same thing machine-readable

   Papers fall into five buckets, and the bucket is the useful part: a paper
   whose written guidelines all came through but whose multiple choice is
   empty (MC_KEY_ONLY) had a solutions document that we clearly processed, so
   the key is in it somewhere and worth hunting. A paper with nothing at all
   may simply never have published solutions. */
const { load, hasGuidelines, isSolved, paperKey } = require("./corpus");

const records = load().flatMap(s => s.records);
const papers = new Map();
for (const r of records) {
  if (!papers.has(paperKey(r))) papers.set(paperKey(r), []);
  papers.get(paperKey(r)).push(r);
}

const report = [...papers].map(([key, qs]) => {
  qs.sort((a, b) => a.questionNumber - b.questionNumber);
  const [subject, setter, year] = key.split("|");
  const mc = qs.filter(r => r.section === "I");
  const written = qs.filter(r => r.section !== "I");
  const mcMissing = mc.filter(r => !isSolved(r));
  const writtenMissing = written.filter(r => !isSolved(r));
  const missing = [...mcMissing, ...writtenMissing].sort((a, b) => a.questionNumber - b.questionNumber);

  let status;
  if (!missing.length)                                      status = "COMPLETE";
  else if (missing.length === qs.length)                    status = "WHOLE_PAPER_MISSING";
  else if (mcMissing.length === mc.length && !writtenMissing.length) status = "MC_KEY_ONLY";
  else if (!mcMissing.length)                               status = "WRITTEN_GAPS";
  else                                                      status = "MIXED_GAPS";

  return { subject, setter, year: +year, status,
           questions: qs.length,
           mcTotal: mc.length, mcMissing: mcMissing.length,
           writtenTotal: written.length, writtenMissing: writtenMissing.length,
           missingQuestionNumbers: missing.map(r => r.questionNumber),
           missingIds: missing.map(r => r.id) };
}).sort((a, b) => a.subject.localeCompare(b.subject) ||
                  a.setter.localeCompare(b.setter) || a.year - b.year);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

const unsolved = records.filter(r => !isSolved(r));
console.log(`${records.length} questions across ${report.length} papers`);
console.log(`${unsolved.length} unsolved (${(100 * unsolved.length / records.length).toFixed(1)}%) — ` +
            `${unsolved.filter(r => r.section === "I").length} multiple choice, ` +
            `${unsolved.filter(r => r.section !== "I").length} written\n`);

for (const status of ["WHOLE_PAPER_MISSING", "MC_KEY_ONLY", "MIXED_GAPS", "WRITTEN_GAPS", "COMPLETE"]) {
  const group = report.filter(p => p.status === status);
  const qs = group.reduce((n, p) => n + p.missingQuestionNumbers.length, 0);
  console.log(`## ${status} — ${group.length} papers, ${qs} unsolved questions`);
  for (const p of group) {
    const name = `${p.subject} ${p.year} ${p.setter}`.padEnd(38);
    if (status === "COMPLETE") { console.log(`  ${name}`); continue; }
    console.log(`  ${name} missing ${String(p.missingQuestionNumbers.length).padStart(3)}/${String(p.questions).padEnd(3)}` +
                `  MC ${p.mcMissing}/${p.mcTotal}  written ${p.writtenMissing}/${p.writtenTotal}`);
    if (status === "MIXED_GAPS" || status === "WRITTEN_GAPS")
      console.log(`      Q${p.missingQuestionNumbers.join(", ")}`);
  }
  console.log();
}
