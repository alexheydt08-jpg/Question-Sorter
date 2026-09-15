/* Shared helpers for the offline corpus tools.

   data.js and trials.js are each one line: a global assignment whose value is
   a JSON array. Parsing and re-serialising that array is byte-identical for
   untouched records, so a tool run shows up in the diff as exactly the fields
   it changed and nothing else. Keep it that way — the site has no build step
   and these files are read straight off the branch. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = [
  { file: "data.js",   global: "QDATA" },   // NESA HSC papers
  { file: "trials.js", global: "TDATA" },   // school and commercial trials
];

function load() {
  return FILES.map(f => {
    const src = fs.readFileSync(path.join(ROOT, f.file), "utf8");
    const prefix = `window.${f.global}=`;
    if (!src.startsWith(prefix)) throw new Error(`${f.file} does not start with ${prefix}`);
    return { ...f, records: JSON.parse(src.slice(prefix.length).replace(/;\s*$/, "")) };
  });
}

function save(set) {
  fs.writeFileSync(path.join(ROOT, set.file),
                   `window.${set.global}=${JSON.stringify(set.records)};\n`);
}

/* A question counts as solved if a student would see something on the back of
   it: guideline crops, guideline text, or — for multiple choice — the answer
   key. Anything else is a question we cannot mark. */
const hasGuidelines = r => (r.mgImages || []).length > 0 || (r.mgText || "").trim() !== "";
const hasAnswer     = r => r.answer != null && String(r.answer).trim() !== "";
const isSolved      = r => hasGuidelines(r) || hasAnswer(r);

/* Papers are keyed the way a student names one: subject, who set it, which year. */
const paperKey = r => `${r.subject}|${r.source === "Trial" ? r.school : "NESA"}|${r.year}`;

module.exports = { ROOT, load, save, hasGuidelines, hasAnswer, isSolved, paperKey };
