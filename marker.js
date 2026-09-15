/* ==========================================================================
   AI marker. Saving a marked question as a flashcard is handed to cards.js.

   There is no server: this calls the Anthropic API straight from the browser
   with a key you paste in, kept in this browser's localStorage. No key is ever
   committed or built into the published page — each person brings their own,
   so nobody can spend anyone else's credit.
   ========================================================================== */
"use strict";

const MAX_TOKENS = 4000;
const MAX_FILE_MB = 28;
const UNSET = "Not set";

/* ---------- providers ----------------------------------------------------
   Two APIs, one marking prompt. Everything that differs between them lives
   here so the rest of the file never asks which one is in use.

   The keys are stored under separate names deliberately: switching provider
   must not throw away the other key, and Anthropic keeps its original name so
   nobody has to paste a saved key again.

   Whether pictures can be sent is a property of the MODEL, not the provider:
   DeepSeek's chat and reasoner models read text only, while deepseek-flash
   takes images. Each model entry carries its own flag, and the marker asks the
   selected model rather than the provider — see visionNow() below.
   -------------------------------------------------------------------------- */
const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    keyStorage: "hsc-marker-key",
    hint: "sk-ant-…",
    console: "https://console.anthropic.com/settings/keys",
    docs: true,                       // reads PDFs as well as images
    models: [
      ["claude-opus-5", "Opus 5", true],
      ["claude-sonnet-5", "Sonnet 5", true],
      ["claude-haiku-4-5-20251001", "Haiku 4.5", true]
    ],
    url: "https://api.anthropic.com/v1/messages",
    headers: key => ({
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    }),
    body: (model, system, content) => ({
      model, max_tokens: MAX_TOKENS, system,
      messages: [{ role: "user", content }]
    }),
    read: data => ({
      text: (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim(),
      cut: data.stop_reason === "max_tokens"
    })
  },
  deepseek: {
    label: "DeepSeek",
    keyStorage: "hsc-marker-key-deepseek",
    hint: "sk-…",
    console: "https://platform.deepseek.com/api_keys",
    docs: false,                      // images yes, PDFs no
    models: [
      ["deepseek-flash", "DeepSeek Flash — reads images", true],
      ["deepseek-v4-pro", "DeepSeek V4 Pro — strongest, text only", false],
      ["deepseek-chat", "DeepSeek Chat — text only", false],
      ["deepseek-reasoner", "DeepSeek Reasoner — text only", false]
    ],
    url: "https://api.deepseek.com/chat/completions",
    headers: key => ({
      "content-type": "application/json",
      "authorization": `Bearer ${key}`
    }),
    body: (model, system, content) => ({
      model, max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: system },
                 { role: "user", content }]
    }),
    /* DeepSeek's vision models take OpenAI-shaped blocks: an image is an
       image_url holding a data URL, not Anthropic's {source:{...}}. PDFs have
       no equivalent — JPEG, PNG, GIF and WebP only — so a PDF is dropped and
       counted rather than sent in a shape the API would reject. */
    convert: blocks => {
      const out = []; let dropped = 0;
      for (const b of blocks){
        if (b.type === "text") out.push({ type: "text", text: b.text });
        else if (b.type === "image" && b.source?.data)
          out.push({ type: "image_url",
                     image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        else dropped++;
      }
      return { content: out, dropped };
    },
    read: data => {
      const c = (data.choices || [])[0] || {};
      return { text: (c.message?.content || "").trim(),
               cut: c.finish_reason === "length" };
    }
  }
};

const article = w => /^[AEIOU]/i.test(w) ? "An" : "A";
const PROVIDER_STORAGE = "hsc-marker-provider";
const readProvider = () => {
  try { const v = localStorage.getItem(PROVIDER_STORAGE); if (PROVIDERS[v]) return v; } catch {}
  return "anthropic";
};
let provider = readProvider();
const P = () => PROVIDERS[provider];

/* Can the model currently selected see pictures? Read from the model list, so
   picking deepseek-flash turns attachments back on without touching anything
   else. Falls back to the provider's first model before the UI has painted. */
function visionNow(){
  const want = (typeof document !== "undefined" && $("#model")?.value) || "";
  const row = P().models.find(m => m[0] === want) || P().models[0];
  return !!row[2];
}

/* Modules as named in the NESA Stage 6 syllabuses. Adding a subject means
   adding an entry here and a button to the subject group in the header. */
const MODULES = {
  Physics: [
    "Module 1: Kinematics",
    "Module 2: Dynamics",
    "Module 3: Waves and Thermodynamics",
    "Module 4: Electricity and Magnetism",
    "Module 5: Advanced Mechanics",
    "Module 6: Electromagnetism",
    "Module 7: The Nature of Light",
    "Module 8: From the Universe to the Atom"
  ],
  Chemistry: [
    "Module 1: Properties and Structure of Matter",
    "Module 2: Introduction to Quantitative Chemistry",
    "Module 3: Reactive Chemistry",
    "Module 4: Drivers of Reactions",
    "Module 5: Equilibrium and Acid Reactions",
    "Module 6: Acid/base Reactions",
    "Module 7: Organic Chemistry",
    "Module 8: Applying Chemical Ideas"
  ],
  Economics: [
    "Topic 1: The Global Economy",
    "Topic 2: Australia's Place in the Global Economy",
    "Topic 3: Economic Issues",
    "Topic 4: Economic Policies and Management"
  ]
};

const SUBJECT_CONVENTIONS = {
  Physics:
    "correct use of formulas, correct units carried through the working, correct " +
    "significant figures, clear identification of physical quantities and variables, " +
    "logical step-by-step working for calculations, and correct application of physics " +
    "concepts (forces, energy, motion, electricity, waves, modern physics) relevant to " +
    "the syllabus dot point being tested",
  Chemistry:
    "correct chemical equations (balanced, with states of matter where relevant), " +
    "correct IUPAC naming and formulas, correct significant figures and units, clear " +
    "identification of the relevant chemical concepts (equilibrium, acids and bases, " +
    "redox, organic chemistry, energy), and the terminology NESA expects"
};

function systemPrompt(subject, hasGuidelines){
  const all = Object.keys(SUBJECT_CONVENTIONS);
  const others = all.filter(s => s !== subject);
  const conventions = all.map(s => `- ${s}: ${SUBJECT_CONVENTIONS[s]}.`).join("\n");

  const criteriaStep = hasGuidelines
    ? `2. Break the supplied marking guidelines into individual mark-worthy points, and mark against those points exactly as written. Do not substitute your own criteria where the guidelines are explicit, and do not relax a criterion because the student came close to it.`
    : `2. No official marking guidelines were supplied. Construct a marking breakdown yourself from standard NESA conventions for this subject and question type — for example, one mark per correct linked idea or step in a 3-mark "explain" question, or marks for formula, substitution and answer-with-units in a calculation. Set the criteria at the standard a real HSC marking guideline would demand, not at a standard the answer in front of you happens to meet. State the breakdown you used so the student can see what you marked against.`;

  return `You are an experienced HSC (NSW Higher School Certificate) marker. You currently mark these subjects: ${all.join(", ")}.

The subject for this specific task is: ${subject}

Note: this marker is being actively developed and more HSC subjects will be added in future (e.g. Biology, Mathematics). For now, mark only according to the conventions of ${subject} — do not blend in conventions from ${others.join(", ") || "other subjects"} or any other subject.

You mark strictly and fairly according to official NESA HSC marking conventions for ${subject}, awarding marks incrementally for specific criteria met rather than on overall impression, the way real HSC markers do. This includes subject-specific expectations such as:

${conventions}

The material may arrive in several forms. A single attached file may contain both the question and the student's response — in that case, work out which part is the printed question and which is the student's own writing, and mark only the student's writing. A whole exam paper may be attached for context, with the specific question identified separately. Handwriting may be untidy; be generous in *deciphering* what the student wrote, and only treat something as absent if you genuinely cannot find it on the page. Being generous about legibility is not the same as being generous about marks — decipher charitably, then mark strictly on what the words actually say.

Your job for every response:
1. Identify how many marks the question is worth, from the question itself or from the marking guidelines. If the mark value is genuinely not stated anywhere, infer it from the depth the question demands and say so in your feedback.
${criteriaStep}
3. Assess the student's answer against each point of that breakdown, applying the strictness rules below.
4. Award partial marks only where the answer genuinely satisfies part of the criteria.
5. Give a total mark out of the maximum.
6. Give clear, constructive written feedback: what was correct, what was missing or wrong, and specifically what would have earned the remaining marks. Write it the way a real HSC marker's comment reads — direct, specific, tied to the criteria, not generic praise or criticism.

Mark strictly. Real HSC markers do not give the benefit of the doubt, and a mark that flatters the student now costs them in the actual exam. Apply these rules:

- Award a mark only when the answer explicitly states the required idea. Do not award marks for understanding you infer the student probably has but did not write down. If it is not on the page, it did not earn the mark.
- Vague, hand-waving, or imprecise wording does not earn a mark that calls for a specific concept or term. NESA expects correct technical terminology, and an approximate phrase in place of the right term is not worth the mark.
- Honour the question's verb. "Explain" requires cause and effect, not just a description. "Analyse", "assess" and "evaluate" require a judgement supported by reasoning. "Justify" requires the reasoning to be made explicit. An answer that only describes when the question said explain has not met the criterion, however accurate the description is.
- In calculations, penalise missing or incorrect units, incorrect significant figures, and absent working. A correct final number with no working does not earn the full allocation where the marks are for method.
- Where the answer is internally contradictory, or a correct statement sits beside an incorrect one that undermines it, do not award the mark. Do not let a correct fragment rescue a confused response.
- Do not award marks for restating the question, for generic preamble, or for content that is true but irrelevant to what was asked.
- Where the answer sits genuinely on the boundary between two marks, award the lower one.

Being strict is not being harsh in tone. Keep the written feedback fair, specific and encouraging about what the student can fix — the strictness belongs in the marks, not in how you speak to them.

Respond with a single valid JSON object and nothing else. No preamble, no markdown fences. Every numeric field must be a number, not a string.

{
  "subject": "string",
  "max_marks": number,
  "marking_breakdown": [
    { "criterion": "what earns this mark", "marks_available": number }
  ],
  "marks_awarded": [
    { "criterion": "matches a criterion above", "marks_given": number, "reason": "why" }
  ],
  "total_mark": number,
  "feedback": "overall constructive feedback in HSC marker style",
  "improvement_tips": ["string"]
}

Keep the feedback and tips concise enough that the whole JSON object fits comfortably in your reply and is never cut off mid-object.

If the guidelines are unclear, incomplete, or contradict the question, say so inside "feedback" rather than guessing silently.

If the answer is blank, illegible, or clearly does not attempt the question, award 0 and explain why in "feedback" rather than guessing at intent.`;
}

/* ---------- state -------------------------------------------------------- */
let mode = "split";
let busy = false;
let controller = null;
let lastResult = null;
let fromSorter = null;   // the sorter record a question was sent from, if any

const SLOTS = ["question","answer","combined","paper","paperanswer","guidelines"];
const files = Object.fromEntries(SLOTS.map(s => [s, []]));

/* ---------- API key ------------------------------------------------------ */
const readKey = (which = provider) => {
  try { return localStorage.getItem(PROVIDERS[which].keyStorage) || ""; } catch { return ""; }
};
const getKey  = () => ($("#key").value || readKey()).trim();

/* The key matters once, at setup. After that it is noise at the top of every
   visit, so a saved key collapses to one line that expands again on click. */
let keyOpen = false;

function paintKey(){
  const p = P();
  const saved = readKey();
  /* The field always shows the current provider's key, never the other's. */
  $("#key").value = saved;
  $("#key").placeholder = p.hint;
  $("#provider").value = provider;
  $("#keyforget").classList.toggle("hidden", !saved);
  /* acquiring a key is covered by the step-by-step below, so this line only
     has to say where the key lives */
  $("#keynote").textContent = saved
    ? `${article(p.label)} ${p.label} key is saved in this browser. It is never committed or built into the published page — add it again on each device you use.`
    : `Marking needs your own ${p.label} API key. It is kept in this browser only, never in the repository or the published page.`;
  const other = Object.entries(PROVIDERS).filter(([k]) => k !== provider && readKey(k));
  $("#keyother").textContent = other.length
    ? `${article(other[0][1].label)} ${other[0][1].label} key is also saved and is kept when you switch.` : "";
  const lbl = $("#keysavedlabel");
  if (lbl) lbl.textContent = `${p.label} key saved in this browser`;
  const collapse = saved && !keyOpen;
  $("#keystrip").classList.toggle("hidden", collapse);
  $("#keyedit").classList.toggle("hidden", !collapse);
  paintModels();
  $("#keytest").textContent = "Test connection";
  $("#keytest").disabled = false;
  $("#testout").textContent = "";
}

/* The model list belongs to the provider; keep whatever was selected if that
   model still exists, otherwise fall back to the provider's first. */
function paintModels(){
  const sel = $("#model"), want = sel.value;
  sel.innerHTML = "";
  for (const [value, label] of P().models){   // third field is the vision flag
    const o = document.createElement("option");
    o.value = value; o.textContent = label;
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === want)) sel.value = want;
}

/* The one question that cannot be answered from a sandbox: will a browser let
   this page call that host at all? One real request settles it, and separates
   "blocked" from "bad key" from "no balance". */
$("#keytest").onclick = async () => {
  const p = P(), key = getKey(), btn = $("#keytest");
  if (!key){ $("#testout").textContent = "Enter a key first, then test it."; return; }
  btn.disabled = true; btn.textContent = "Testing…";
  let res;
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: p.headers(key),
      body: JSON.stringify(p.body($("#model").value || p.models[0][0], "Reply with OK.",
        p.convert ? "Reply with OK." : [{ type: "text", text: "Reply with OK." }]))
    });
  } catch {
    $("#testout").textContent =
      `Could not reach ${p.label}. Either you are offline, or your browser blocked the request because ${new URL(p.url).host} does not allow calls from a web page — in which case this provider cannot be used from this site.`;
    btn.disabled = false; btn.textContent = "Test connection";
    return;
  }
  let detail = "";
  try { detail = (await res.json())?.error?.message || ""; } catch {}
  $("#testout").textContent =
      res.ok              ? `Connected. ${p.label} accepted the key and is ready to mark.`
    : res.status === 401  ? "That key was rejected. Check it is current and has not been revoked."
    : res.status === 402  ? `The key works, but this ${p.label} account has no balance. Top it up before marking.`
    : res.status === 429  ? "The key works, but you are rate limited right now."
    : /credit|balance/i.test(detail) ? `The key works, but this account has no credit. Top it up before marking.`
    : `${p.label} answered ${res.status}. ${detail}`.trim();
  btn.disabled = false; btn.textContent = "Test connection";
};

$("#model").addEventListener("change", paintImageNote);

$("#provider").onchange = () => {
  provider = $("#provider").value;
  try { localStorage.setItem(PROVIDER_STORAGE, provider); } catch {}
  keyOpen = !readKey();
  paintKey();
  paintImageNote();
};

$("#keyedit").onclick = () => { keyOpen = true; paintKey(); $("#key").focus(); };
$("#keysave").onclick = () => {
  const v = $("#key").value.trim();
  const slot = P().keyStorage;
  try { v ? localStorage.setItem(slot, v) : localStorage.removeItem(slot); } catch {}
  keyOpen = false;
  paintKey();
};
$("#keyforget").onclick = () => {
  try { localStorage.removeItem(P().keyStorage); } catch {}
  $("#key").value = "";
  keyOpen = true;
  paintKey();
};
paintKey();
paintImageNote();

/* ---------- mode tabs ---------------------------------------------------- */
$$(".modes button").forEach(b => b.addEventListener("click", () => {
  mode = b.dataset.mode;
  $$(".modes button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $$("[data-pane]").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== mode));
}));

/* ---------- files: dedupe, size guard, drag/drop, paste ------------------ */
const fmtSize = b => b < 1048576 ? Math.max(1, Math.round(b/1024)) + " KB"
                                 : (b/1048576).toFixed(1) + " MB";

function addFiles(slot, list){
  const rejected = [];
  for (const f of list){
    const ok = f.type === "application/pdf" || f.type.startsWith("image/");
    if (!ok){ rejected.push(`${f.name} is not an image or PDF`); continue; }
    if (f.size > MAX_FILE_MB*1048576){ rejected.push(`${f.name} is over ${MAX_FILE_MB} MB`); continue; }
    const dup = files[slot].some(x => x.name===f.name && x.size===f.size && x.lastModified===f.lastModified);
    if (!dup) files[slot].push(f);
  }
  drawFiles(slot);
  if (rejected.length) showError("Some files were not added", rejected.join(". ") + ".");
}

function drawFiles(slot){
  const ul = document.querySelector(`[data-list="${slot}"]`);
  if (!ul) return;
  ul.textContent = "";
  files[slot].forEach((f, i) => {
    const li = document.createElement("li");
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = f.name;
    const sz = document.createElement("span"); sz.className = "sz"; sz.textContent = fmtSize(f.size);
    const rm = document.createElement("button");
    rm.type = "button"; rm.textContent = "×";
    rm.setAttribute("aria-label", `Remove ${f.name}`);
    rm.addEventListener("click", e => { e.preventDefault(); files[slot].splice(i,1); drawFiles(slot); });
    li.append(nm, sz, rm);
    ul.appendChild(li);
  });
}

$$(".drop").forEach(zone => {
  const slot = zone.dataset.slot;
  const input = zone.querySelector("input[type=file]");
  input.addEventListener("change", e => { addFiles(slot, e.target.files); input.value = ""; });
  ["dragenter","dragover"].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); zone.classList.add("over");
  }));
  ["dragleave","drop"].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove("over");
  }));
  zone.addEventListener("drop", e => { if (e.dataTransfer?.files?.length) addFiles(slot, e.dataTransfer.files); });
});

document.addEventListener("paste", e => {
  if (APP.view !== "marker") return;
  const imgs = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith("image/"));
  if (!imgs.length) return;
  const el = document.activeElement;
  const near = el?.closest?.("[data-pane], .field");
  let slot = near?.querySelector?.(".drop")?.dataset.slot;
  if (!slot) slot = mode === "combined" ? "combined" : mode === "paper" ? "paperanswer" : "answer";
  e.preventDefault();
  addFiles(slot, imgs);
});

function fileToBlock(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const data = s.slice(s.indexOf(",") + 1);
      if (!data) return reject(new Error(`${file.name} appears to be empty.`));
      resolve(file.type === "application/pdf"
        ? { type:"document", source:{ type:"base64", media_type:"application/pdf", data } }
        : { type:"image",    source:{ type:"base64", media_type:file.type,        data } });
    };
    r.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    r.readAsDataURL(file);
  });
}

/* ==========================================================================
   HAND-OFF FROM BROWSE
   The sorter already holds the exact question image and the official NESA
   marking guidelines, so sending a question here attaches both — the marker
   then marks against the real criteria rather than inferring its own.
   ========================================================================== */
async function pathToFile(path){
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path}`);
  const blob = await res.blob();
  return new File([blob], path.split("/").pop(), { type: blob.type || "image/webp" });
}

async function sendToMarker(rec){
  setView("marker");
  mode = "split";
  $$(".modes button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mode === "split")));
  $$("[data-pane]").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== "split"));

  if (rec.subject !== APP.subject) setSubject(rec.subject);

  /* clear anything left from a previous question, keep the user's own answer */
  ["question","guidelines"].forEach(s => { files[s].length = 0; drawFiles(s); });

  fromSorter = rec;
  const origin = rec.source === "Trial"
    ? `${rec.year} ${rec.school} trial`
    : `${rec.year} HSC`;
  const label = `${origin} ${rec.subject} · Question ${rec.questionNumber}` +
    (rec.marks ? ` · ${rec.marks} mark${rec.marks===1?"":"s"}` : "");
  const box = $("#fromsorter");
  box.classList.remove("hidden");
  box.innerHTML = `<button class="x" id="fsx" aria-label="Detach this question">×</button>
    <b>From Browse — ${esc(label)}</b>
    <span id="fsstat">Attaching the question and its official marking guidelines…</span>`;
  $("#fsx").onclick = detachSorter;

  $("#mq").value = `${rec.questionText || ""}${rec.marks ? `\n\n(${rec.marks} mark${rec.marks===1?"":"s"})` : ""}`.trim();

  let gl = "";
  if (rec.section === "I" && rec.answer) gl = `Official answer key: the correct option is ${rec.answer}.`;
  if (rec.mgText) gl = (gl ? gl + "\n\n" : "") + rec.mgText;
  $("#g").value = gl;

  /* attach the real images so the marker sees the paper, not just OCR text */
  const stat = $("#fsstat");
  try {
    for (const p of (rec.questionImages || [])) files.question.push(await pathToFile(p));
    for (const p of (rec.mgImages || []))       files.guidelines.push(await pathToFile(p));
    drawFiles("question"); drawFiles("guidelines");
    const hasG = files.guidelines.length || $("#g").value.trim();
    /* the guidelines section is folded away by default; a question that
       brought its own should not hide them */
    if (hasG) $("#gwrap").open = true;
    stat.textContent = hasG
      ? (rec.source === "Trial"
          ? "The question image and the school's marking guidelines are attached below. Type your answer and mark it."
          : "The question image and the official NESA marking guidelines are attached below. Type your answer and mark it.")
      : "The question image is attached. No solutions came with this paper, so the marker will build its own HSC-style breakdown.";
  } catch {
    stat.textContent = "Question text and guidelines are filled in below. The images could not be attached — the text is enough to mark against.";
  }
  $("#ma").focus();
}
/* A whole generated practice test, handed over as a paper.

   The marker works one question at a time, so this fills the "from a whole
   paper" mode: every question image is attached, and the student names the
   question they are answering. Marking a single question is cheaper and more
   accurate — the per-question button in the paper sends that question's own
   guidelines too — so this says as much rather than pretending otherwise. */
async function sendPaperToMarker(paths, label){
  setView("marker");
  mode = "paper";
  $$(".modes button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mode === "paper")));
  $$("[data-pane]").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== "paper"));

  detachSorter();
  ["paper", "paperanswer", "guidelines"].forEach(s => { files[s].length = 0; drawFiles(s); });

  const box = $("#fromsorter");
  box.classList.remove("hidden");
  box.innerHTML = `<button class="x" id="fsx" aria-label="Detach this paper">×</button>
    <b>From the practice test — ${esc(label)}</b>
    <span id="fsstat">Attaching the paper…</span>`;
  $("#fsx").onclick = () => { detachSorter(); files.paper.length = 0; drawFiles("paper"); };

  try {
    for (const p of paths) files.paper.push(await pathToFile(p));
    drawFiles("paper");
    $("#fsstat").textContent =
      `${files.paper.length} question image${files.paper.length === 1 ? "" : "s"} attached. `
      + "Enter the question number you answered and hand in your response. "
      + "Marking one question at a time from the paper's ✎ Mark buttons is cheaper "
      + "and brings that question's real marking guidelines with it.";
  } catch {
    $("#fsstat").textContent = "The paper's images could not be attached. Attach a photo of the question instead.";
  }
}

window.sendPaperToMarker = sendPaperToMarker;
window.sendToMarker = sendToMarker;

function detachSorter(){
  fromSorter = null;
  $("#fromsorter").classList.add("hidden");
  $("#fromsorter").innerHTML = "";
}

/* ---------- message ------------------------------------------------------ */
async function attach(blocks, heading, slot, text, fallback){
  const has = files[slot].length > 0;
  const t = (text || "").trim();
  if (has){
    blocks.push({ type:"text", text:`${heading}\n[Attached below]` });
    for (const f of files[slot]) blocks.push(await fileToBlock(f));
    if (t) blocks.push({ type:"text", text:`Also given as text:\n${t}` });
  } else if (t){
    blocks.push({ type:"text", text:`${heading}\n${t}` });
  } else if (fallback){
    blocks.push({ type:"text", text:`${heading}\n${fallback}` });
  }
}

const hasGuidelines = () => !!($("#g").value.trim() || files.guidelines.length);

async function buildContent(){
  const blocks = [{ type:"text", text:`Subject: ${APP.subject}` }];

  if (mode === "combined"){
    const which = $("#cnote").value.trim();
    blocks.push({ type:"text", text:
      "The file below contains BOTH the question and the student's response. Identify which is the printed question and which is the student's own work, and mark only the student's work." +
      (which ? `\nMark this question specifically: ${which}` : "") });
    for (const f of files.combined) blocks.push(await fileToBlock(f));

  } else if (mode === "paper"){
    blocks.push({ type:"text", text:"EXAM PAPER:\n[Attached below]" });
    for (const f of files.paper) blocks.push(await fileToBlock(f));
    const qn = $("#qn").value.trim(), hint = $("#qhint").value.trim();
    blocks.push({ type:"text", text:
      `QUESTION TO MARK:\n${qn ? `Question ${qn}` : "See the answer below and locate the matching question."}${hint ? `\n${hint}` : ""}` });
    await attach(blocks, "STUDENT'S ANSWER:", "paperanswer", $("#pa").value, "Not provided.");

  } else {
    await attach(blocks, "QUESTION:", "question", $("#mq").value, "Not provided.");
    await attach(blocks, "STUDENT'S ANSWER:", "answer", $("#ma").value, "Not provided.");
  }

  await attach(blocks, "MARKING GUIDELINES:", "guidelines", $("#g").value,
    "None supplied. Build your own HSC-style breakdown and state it.");

  blocks.push({ type:"text", text:"Mark this response according to your instructions. Return the JSON only." });
  return blocks;
}

/* ---------- API ---------------------------------------------------------- */

/* Anthropic takes a list of typed blocks; DeepSeek takes a plain string and
   reads no pictures at all. Flattening drops the attachments and says how many
   went, so the reader is told rather than left wondering why a marked photo
   was ignored. */
function flattenForText(content){
  const parts = [];
  let dropped = 0;
  for (const b of content){
    if (b.type === "text") parts.push(b.text);
    else dropped++;
  }
  return { text: parts.join("\n\n"), dropped };
}

/* Whether the current provider can actually see this question.

   Judged from what was typed, not from the flattened prompt: every attachment
   still contributes a heading like "QUESTION:\n[Attached below]", so measuring
   the text's length reads those placeholders as content and cheerfully marks a
   question the model never saw. */
function markableWith(content){
  if (visionNow()){
    /* A vision model still cannot open a PDF on DeepSeek. Say how many were
       left behind rather than marking as though it had read them. */
    const d = P().convert ? P().convert(content).dropped : 0;
    return { ok: true, dropped: d, pdf: d > 0 };
  }
  const dropped = flattenForText(content).dropped;
  const has = id => !!$(id).value.trim();
  if (mode === "combined")
    return { ok: false, dropped, why: "the question and your answer are both inside the attached file" };
  if (mode === "paper")
    return has("#pa")
      ? { ok: false, dropped, why: "the exam paper itself is an attachment, so the question cannot be read" }
      : { ok: false, dropped, why: "the exam paper and your answer are attachments" };
  if (!has("#mq"))
    return { ok: false, dropped, why: "the question is only attached as a file" };
  if (!has("#ma"))
    return { ok: false, dropped, why: "your answer is only attached as a file" };
  return { ok: true, dropped };
}

async function callApi(key, model, content, signal){
  const p = P();
  let payload = content;
  if (p.convert) payload = visionNow() ? p.convert(content).content
                                       : flattenForText(content).text;

  let res;
  try {
    res = await fetch(p.url, {
      method:"POST", signal,
      headers: p.headers(key),
      body: JSON.stringify(p.body(model, systemPrompt(APP.subject, hasGuidelines()), payload))
    });
  } catch (e){
    if (e.name === "AbortError") throw e;
    /* A browser refusing the request for cross-origin reasons throws exactly
       the same TypeError as being offline. Naming both beats a wrong guess. */
    throw new Error(`Could not reach ${p.label}. Either you are offline, or your browser blocked the request because ${new URL(p.url).host} does not allow calls from a web page. The browser console will say which.`);
  }

  if (!res.ok){
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch {}
    if (res.status === 401) throw new Error("That key was rejected. Check it is current and has not been revoked.");
    if (res.status === 402) throw new Error(`This ${P().label} account has no balance left. Top it up, then mark again.`);
    if (res.status === 403) throw new Error("That key is not permitted to use this model. Try a different model.");
    if (res.status === 429) throw new Error("Rate limit reached. Wait a moment, then mark again.");
    if (res.status === 413) throw new Error("The attachments are too large. Remove a file or use a smaller scan.");
    if (res.status >= 500)  throw new Error(`${P().label} is having trouble right now. Try again shortly.`);
    if (/credit|balance/i.test(detail)) throw new Error(`This account has no credit left. Top it up in the ${P().label} console.`);
    throw new Error(detail || `The API returned ${res.status}.`);
  }

  const data = await res.json();
  const { text, cut } = p.read(data);
  if (!text) throw new Error("The API replied with nothing. Try marking again.");
  if (cut){
    const e = new Error("The reply was cut off before it finished. Try a shorter answer or fewer attachments.");
    e.raw = text; throw e;
  }
  return text;
}

/* ---------- parse: tolerant of fences, prose, string numbers ------------- */
const num = v => {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.-]/g,"")) : Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseResult(raw){
  let s = raw.trim();
  if (s.startsWith("```")){
    s = s.slice(s.indexOf("\n") + 1);
    if (s.trimEnd().endsWith("```")) s = s.trimEnd().slice(0, -3);
    s = s.trim();
  }
  let obj = null;
  try { obj = JSON.parse(s); } catch {}
  if (!obj){
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a !== -1 && b > a){ try { obj = JSON.parse(s.slice(a, b+1)); } catch {} }
  }
  if (!obj || typeof obj !== "object"){
    const truncated = s.includes("{") && !s.trimEnd().endsWith("}");
    const e = new Error(truncated
      ? "The reply was cut off before it finished. Try marking again."
      : "The marker's reply was not in the expected format. Try marking again.");
    e.raw = raw; throw e;
  }
  return normalise(obj);
}

function normalise(o){
  const awarded = Array.isArray(o.marks_awarded) ? o.marks_awarded : [];
  const breakdown = Array.isArray(o.marking_breakdown) ? o.marking_breakdown : [];

  const rows = awarded.map(m => ({
    criterion: String(m?.criterion ?? "").trim() || "Unnamed criterion",
    given: num(m?.marks_given) ?? 0,
    available: num(m?.marks_available),
    reason: String(m?.reason ?? "").trim()
  }));

  rows.forEach(r => {
    if (r.available == null){
      const match = breakdown.find(b => String(b?.criterion ?? "").trim() === r.criterion);
      r.available = num(match?.marks_available) ?? null;
    }
  });

  let max = num(o.max_marks);
  if (max == null || max <= 0){
    const fromBreakdown = breakdown.reduce((t,b) => t + (num(b?.marks_available) ?? 0), 0);
    const fromRows = rows.reduce((t,r) => t + (r.available ?? 1), 0);
    max = fromBreakdown > 0 ? fromBreakdown : (fromRows > 0 ? fromRows : null);
  }

  let total = num(o.total_mark);
  if (total == null) total = rows.reduce((t,r) => t + r.given, 0);
  if (max != null) total = Math.min(Math.max(total, 0), max);

  const tips = Array.isArray(o.improvement_tips)
    ? o.improvement_tips.map(t => String(t).trim()).filter(Boolean)
    : (typeof o.improvement_tips === "string" && o.improvement_tips.trim() ? [o.improvement_tips.trim()] : []);

  return {
    subject: String(o.subject || APP.subject),
    max, total, rows, tips,
    feedback: String(o.feedback ?? "").trim(),
    inferred: !hasGuidelines()
  };
}

/* ---------- render ------------------------------------------------------- */
const out = $("#out");

function showBusy(){
  $("#copy").classList.add("hidden");
  out.innerHTML = `<div class="load"><span class="dot"></span>Reading the response against the criteria…</div>`;
}

/* How many attachments the model could not see. Kept so the finished mark can
   still say so: a caveat that vanishes when the result arrives is no caveat,
   and the reader would take a text-only mark for a mark of the picture. */
let lastDropped = 0, lastPdf = false;

/* A note beside the provider picker, so the limitation is visible before a
   mark is attempted rather than only when one fails. */
function paintImageNote(){
  const el = $("#imgnote");
  if (!el) return;
  const vision = visionNow();
  el.textContent = vision
    ? (P().docs ? "" : "reads images, but not PDFs — attach a photo rather than a PDF")
    : "this model reads text only — pick DeepSeek Flash to have images read";
}

function showError(title, detail, raw){
  $("#copy").classList.add("hidden");
  out.innerHTML =
    `<div class="err"><b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ""}</div>` +
    (raw ? `<div class="raw">${esc(raw)}</div>` : "");
}

function showResult(r){
  lastResult = r;
  const rows = r.rows.map(m => {
    const cls = m.available != null && m.given > 0 && m.given < m.available ? "part"
              : m.given > 0 ? "won" : "";
    const label = m.available != null ? `${m.given}/${m.available}` : String(m.given);
    return `<li>
      <div class="mk ${cls}">${esc(m.given)}</div>
      <div class="txt"><b>${esc(m.criterion)}${m.available != null ? ` <span class="note">(${esc(label)})</span>` : ""}</b>
      ${m.reason ? `<span>${esc(m.reason)}</span>` : ""}</div>
    </li>`;
  }).join("");

  out.innerHTML = `
    <div class="tally">
      <span class="n">${esc(r.total)}</span>
      <span class="of">/ ${r.max != null ? esc(r.max) : "?"}</span>
      <span class="who">${esc(r.subject)}${fromSorter ? `<br>${esc(fromSorter.year)} ${esc(fromSorter.source === "Trial" ? fromSorter.school : "HSC")} · Q${esc(fromSorter.questionNumber)}` : ""}</span>
    </div>
    ${lastDropped ? `<p class="caveat">${lastPdf
        ? `${esc(P().label)} cannot open PDFs, so ${lastDropped} attachment${lastDropped === 1 ? " was" : "s were"} left out. Attach the same page as a photo to have it read.`
        : `The model you picked reads text only, so ${lastDropped} attachment${lastDropped === 1 ? " was" : "s were"} left out — this mark is from the question text and your answer alone. Choose DeepSeek Flash, or Anthropic, to have them read.`}</p>` : ""}
    ${r.inferred ? `<p class="caveat">Marked without official guidelines — the breakdown below was inferred from standard HSC conventions. Send a question from Browse and its real NESA guidelines come with it.</p>` : `<div style="height:14px"></div>`}
    ${rows ? `<p class="sec">Mark by mark</p><ul class="crit">${rows}</ul>` : ""}
    ${r.feedback ? `<p class="sec">Marker's comment</p><div class="comment">${esc(r.feedback)}</div>` : ""}
    ${r.tips.length ? `<p class="sec">To pick up the remaining marks</p><ul class="tips">${r.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <div id="savehost"></div>
  `;
  saveBlock(r);
  $("#copy").classList.remove("hidden");
}

/* ==========================================================================
   SAVING TO FLASHCARDS
   Storage, scheduling and the Bank views live in cards.js; this half only has
   to hand over the question, the correct answer and where they belong.
   ========================================================================== */

/* A question that came from Browse is described by cards.js, so Browse's own
   "Add card" and this one cannot drift apart; what follows is for the files
   the student attached themselves. */
function currentQuestionText(){
  if (mode === "combined")
    return $("#cnote").value.trim() || (files.combined[0]?.name ? `From ${files.combined[0].name}` : "Attached file");
  if (mode === "paper"){
    const qn = $("#qn").value.trim(), h = $("#qhint").value.trim();
    return [qn && `Question ${qn}`, h].filter(Boolean).join(" — ") || "From attached paper";
  }
  return $("#mq").value.trim() || (files.question[0]?.name ? `Attached: ${files.question[0].name}` : "Attached question");
}

/* A card is only worth reviewing if its back is the right answer, so the
   guidelines are preferred over the student's own attempt. Failing those, the
   marker's account of what the remaining marks needed is the closest thing to
   a model answer, and the card says so. */
function backForCard(r){
  const out = fromSorter && window.cardsAPI
    ? { ...cardFromQuestion(fromSorter).back, note: "" }
    : { text: "", images: [], note: "" };

  const typed = $("#g").value.trim();
  if (typed) out.text = (out.text ? out.text + "\n\n" : "") + typed;

  if (out.text || out.images.length || files.guidelines.length){
    out.note = "The marking guidelines go on the back.";
    return out;
  }
  /* nothing official: fall back to the marker's own account */
  const parts = [];
  if (r?.tips?.length) parts.push(r.tips.map(t => "• " + t).join("\n"));
  if (r?.feedback) parts.push(r.feedback);
  out.text = parts.join("\n\n");
  out.note = "No official answer was available, so the back holds the marker's account of what the marks needed. Edit the card to correct it.";
  return out;
}

function frontForCard(){
  if (fromSorter && window.cardsAPI) return cardFromQuestion(fromSorter).front;
  return { text: currentQuestionText(), images: [] };
}

function cardTags(){
  if (fromSorter && window.cardsAPI) return cardFromQuestion(fromSorter).tags;
  return [];
}

/* images the user attached rather than pulled from Browse have to be copied
   into the card store, which cards.js does; hand it the File objects */
async function uploadedImages(slot){
  if (!window.storeUploaded) return [];
  const out = [];
  for (const f of files[slot]) if (f.type.startsWith("image/")) out.push(await window.storeUploaded(f));
  return out;
}

async function saveBlock(r){
  const host = $("#savehost");
  if (!host || !window.renderSavePanel) return;
  const front = frontForCard();
  const back = backForCard(r);
  if (!front.images.length) front.images = await uploadedImages(mode === "combined" ? "combined" : "question");
  if (!back.images.length)  back.images  = await uploadedImages("guidelines");

  window.renderSavePanel(host, {
    subject: r?.subject || APP.subject,
    /* the id Browse would have used, so marking a question you already added
       updates that card rather than making a second one */
    id: fromSorter ? window.cardsAPI?.questionCardId(fromSorter.id) : null,
    front, back,
    notes: r?.feedback || "",
    tags: cardTags(),
    module: fromSorter?.tags?.[0]?.module || "",
    iqs: (fromSorter?.tags || []).map(t => t.iq).filter(Boolean),
    backNote: back.note,
  });
}

/* ---------- actions ------------------------------------------------------ */
$("#copy").addEventListener("click", async () => {
  if (!lastResult) return;
  const r = lastResult;
  const txt = [
    `${r.subject} — ${r.total}/${r.max ?? "?"}`, "",
    ...r.rows.map(m => `[${m.given}${m.available != null ? "/"+m.available : ""}] ${m.criterion}\n    ${m.reason}`),
    "", r.feedback, "",
    ...r.tips.map(t => `- ${t}`)
  ].join("\n").trim();
  try { await navigator.clipboard.writeText(txt); } catch { return; }
  const b = $("#copy"); b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1400);
});

$("#mclear").addEventListener("click", () => {
  ["#mq","#ma","#g","#cnote","#qn","#qhint","#pa"].forEach(s => { const el = $(s); if (el) el.value = ""; });
  SLOTS.forEach(s => { files[s].length = 0; drawFiles(s); });
  lastResult = null;
  detachSorter();
  $("#copy").classList.add("hidden");
  out.innerHTML = `<p class="empty">Cleared. Hand in a new question and answer whenever you're ready.</p>`;
});

function validate(){
  if (!getKey()) return "Add your Anthropic API key at the top of this page first.";
  if (mode === "combined"){
    if (!files.combined.length) return "Attach the file that holds the question and the answer.";
  } else if (mode === "paper"){
    if (!files.paper.length) return "Attach the exam paper.";
    if (!$("#qn").value.trim() && !$("#qhint").value.trim()) return "Say which question to mark.";
    if (!$("#pa").value.trim() && !files.paperanswer.length) return "Add your answer.";
  } else {
    if (!$("#mq").value.trim() && !files.question.length) return "Add the question — typed or as a photo.";
    if (!$("#ma").value.trim() && !files.answer.length) return "Add your answer — typed or as a photo.";
  }
  return null;
}

$("#go").addEventListener("click", async () => {
  const btn = $("#go");
  if (busy){ controller?.abort(); return; }

  const problem = validate();
  if (problem) return showError(problem, "");

  busy = true;
  controller = new AbortController();
  btn.textContent = "Cancel";
  showBusy();

  try {
    const content = await buildContent();
    const can = markableWith(content);
    if (!can.ok){
      throw new Error(`The model you picked reads text only, and ${can.why}. Choose DeepSeek Flash, which reads images, or type the question in as text.`);
    }
    lastDropped = can.dropped; lastPdf = !!can.pdf;
    const raw = await callApi(getKey(), $("#model").value, content, controller.signal);
    showResult(parseResult(raw));
  } catch (err){
    if (err?.name === "AbortError") showError("Marking cancelled", "Nothing was charged for a cancelled request.");
    else showError(err.message || "Something went wrong.", "", err.raw);
  } finally {
    busy = false;
    controller = null;
    btn.textContent = "Mark this response";
  }
});


