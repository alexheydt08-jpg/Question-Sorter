#!/usr/bin/env node
/* Attach marking-guideline crops to the questions they belong to.

     node tools/apply-guidelines.js crops.json            check only
     node tools/apply-guidelines.js crops.json --write     apply

   crops.json maps a record id to the crops cut from that paper's marking
   guidelines, in reading order:

     { "eco-2023-q21": ["img/eco-2023-q21-mg0.webp", "img/eco-2023-q21-mg1.webp"] }

   Browse shows these images and nothing else for a written question, so a
   crop that belongs to the wrong question is worse than no crop at all.
   Nothing is written unless every entry names a real record and every file
   is on disk. Pass --replace for a question that already has crops, which
   is how the NESA Economics questions get their real guidelines in place of
   the mapping-grid slices they were carrying. */
const fs = require("fs");
const path = require("path");
const { ROOT, load, save } = require("./corpus");

const [, , cropsPath, ...flags] = process.argv;
const write = flags.includes("--write");
const replace = flags.includes("--replace");
if (!cropsPath) { console.error("usage: apply-guidelines.js <crops.json> [--write] [--replace]"); process.exit(2); }

const crops = JSON.parse(fs.readFileSync(cropsPath, "utf8"));
const sets = load();
const byId = new Map();
for (const set of sets) for (const r of set.records) byId.set(r.id, { record: r, set });

const problems = [];
const pending = [];
for (const [id, images] of Object.entries(crops)) {
  const hit = byId.get(id);
  if (!hit) { problems.push(`${id}: no question with that id`); continue; }
  if (!Array.isArray(images) || !images.length) { problems.push(`${id}: no images listed`); continue; }
  const missing = images.filter(p => !fs.existsSync(path.join(ROOT, p)));
  if (missing.length) { problems.push(`${id}: ${missing.join(", ")} not on disk`); continue; }
  const had = hit.record.mgImages || [];
  if (had.length && !replace) { problems.push(`${id}: already has ${had.length} crop(s) — pass --replace`); continue; }
  pending.push({ ...hit, images, had });
}

for (const p of problems) console.error(`  ! ${p}`);
if (problems.length) { console.error(`\n${problems.length} problem(s) — nothing written.`); process.exit(1); }

const bytes = pending.reduce((n, p) =>
  n + p.images.reduce((m, f) => m + fs.statSync(path.join(ROOT, f)).size, 0), 0);
const replaced = pending.filter(p => p.had.length).length;
console.log(`${pending.length} questions, ${pending.reduce((n, p) => n + p.images.length, 0)} crops, ` +
            `${(bytes / 1048576).toFixed(1)} MB` + (replaced ? ` (${replaced} replacing existing crops)` : ""));

if (!write) { console.log("\nCheck only. Re-run with --write to apply."); process.exit(0); }

for (const p of pending) p.record.mgImages = p.images;
const changed = new Set(pending.map(p => p.set.file));
for (const set of sets) if (changed.has(set.file)) save(set);
console.log(`\nWrote ${[...changed].join(", ")}.`);
