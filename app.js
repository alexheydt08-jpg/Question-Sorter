/* ==========================================================================
   Shared shell: the subject, the current view, and the small helpers both
   halves of the app use. Loaded before sorter.js and marker.js.
   ========================================================================== */
"use strict";

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

/* Subject is global — the browser, the practice-test maker and the marker all
   follow the same one, so switching it up top switches the whole app. */
const APP = {
  subject: "Chemistry",
  view: "browse",
  onSubject: [],   // listeners, registered by each half
  onView: [],
};

/* Chemistry and Physics are taught as modules 5-8; Economics runs four
   numbered topics instead. The sidebar heading has to follow the subject or it
   announces the wrong thing entirely. */
const TREE_HEAD = {
  Chemistry: "Modules 5–8 · Year 12",
  Physics:   "Modules 5–8 · Year 12",
  Economics: "Topics 1–4 · Year 12",
};

function paintTreeHead(){
  const el = document.getElementById("treehead");
  if (el) el.textContent = TREE_HEAD[APP.subject] || "Year 12";
}

function setSubject(s){
  if (!s || s === APP.subject) return;
  APP.subject = s;
  document.body.classList.toggle("phys", s === "Physics");
  drawSubjects();
  paintTreeHead();
  APP.onSubject.forEach(fn => fn(s));
}

function setView(v){
  APP.view = v;
  $$("#views button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  $$(".view").forEach(el => el.classList.toggle("hidden", el.id !== "view-" + v));
  APP.onView.forEach(fn => fn(v));
  window.scrollTo({ top: 0 });
}

/* Order is the order they are offered in, not the order they were added. A
   subject with no questions yet is left out rather than shown as an empty tab:
   the list is a promise that there is something behind each button. */
const SUBJECTS = ["Chemistry", "Physics", "Economics"];

const subjectCount = s => (window.QDATA || []).filter(r => r.subject === s).length
                        + (window.TDATA || []).filter(r => r.subject === s).length;

function drawSubjects(){
  const host = $("#subjects");
  host.textContent = "";
  for (const s of SUBJECTS){
    const n = subjectCount(s);
    if (!n) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(s === APP.subject));
    b.innerHTML = `${esc(s)}<span class="n">${n}</span>`;
    b.addEventListener("click", () => setSubject(s));
    host.appendChild(b);
  }
}

$$("#views button").forEach(b =>
  b.addEventListener("click", () => setView(b.dataset.view)));

drawSubjects();
paintTreeHead();
document.body.classList.toggle("phys", APP.subject === "Physics");
