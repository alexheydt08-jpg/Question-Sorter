/* ==========================================================================
   Browse and the practice-test maker.
   Ported from the original standalone sorter; behaviour is unchanged apart
   from following the shared subject and gaining the hand-off to the marker.
   ========================================================================== */
"use strict";

/* NESA HSC papers plus school trial papers, in one list. Trials carry a
   `school` and a tagging `confidence`; anything the classifier could not place
   confidently is left untagged and collected under UNSORTED so it stays
   browsable by school/year/search without polluting the syllabus tree. */
const UNSORTED = "Unsorted — needs a topic";
const HSC = (window.QDATA || []).map(r => ({ ...r, source: "HSC", school: null }));
const TRIALS = (window.TDATA || []);
const DATA = HSC.concat(TRIALS);

const SCHOOLS = [...new Set(TRIALS.map(r => r.school))].sort();

/* subject -> module -> inquiry question -> topic (built from tagged questions;
   only the NESA set defines the canonical tree, trials slot into it) */
const TAX = {};
DATA.forEach(r => (r.tags || []).forEach(t => {
  TAX[r.subject] = TAX[r.subject] || {};
  TAX[r.subject][t.module] = TAX[r.subject][t.module] || {};
  TAX[r.subject][t.module][t.iq] = t.topic;
}));
/* every subject that has trials gets the catch-all bucket */
for (const r of TRIALS) {
  if (!(r.tags || []).length) {
    TAX[r.subject] = TAX[r.subject] || {};
    TAX[r.subject][UNSORTED] = TAX[r.subject][UNSORTED] || {};
    TAX[r.subject][UNSORTED][UNSORTED] = "Not yet sorted";
  }
}
const MODORDER = m => {
  if (m === UNSORTED) return 99;
  /* Chemistry and Physics number modules, Economics numbers topics. Matching
     only "Module" left all four Economics topics on the same fallback score,
     so the tree came out 2, 4, 1, 3. */
  const hit = m.match(/(?:Module|Topic) (\d)/);
  return hit ? parseInt(hit[1]) : 98;
};

/* inquiry questions in the order the syllabus teaches them, not the order the
   first tagged question happened to introduce them (see syllabus.js) */
function orderedIQs(module){
  const iqs = (TAX[APP.subject] || {})[module] || {};
  return Object.keys(iqs).sort((a, b) =>
    topicOrder(APP.subject, module, iqs[a]) - topicOrder(APP.subject, module, iqs[b]));
}

DATA.forEach(r => {
  r._hay = ((r.questionText || "") + " " + (r.school || "") + " " + (r.source || "") + " " +
    (r.tags || []).map(t => `${t.module} ${t.topic} ${t.iq}`).join(" ")).toLowerCase();
});

const state = { module:null, iq:null, q:"", years:new Set(), section:"", marks:"",
                source:"", school:"", openMods:new Set() };

function baseFilter(r, ignoreTree){
  if (r.subject !== APP.subject) return false;
  if (state.source && r.source !== state.source) return false;
  if (state.school && r.school !== state.school) return false;
  if (state.years.size && !state.years.has(r.year)) return false;
  if (state.section && r.section !== state.section) return false;
  if (state.marks){
    if (state.marks === "8+"){ if (r.marks < 8) return false; }
    else if (r.marks !== +state.marks) return false;
  }
  if (state.q && !state.q.toLowerCase().split(/\s+/).every(w => r._hay.includes(w))) return false;
  if (!ignoreTree){
    const tags = r.tags || [];
    if (state.module === UNSORTED) return tags.length === 0;
    if (state.iq && !tags.some(t => t.iq === state.iq)) return false;
    if (!state.iq && state.module && !tags.some(t => t.module === state.module)) return false;
  }
  return true;
}

/* ---------- filters ------------------------------------------------------ */
function renderYears(){
  const ys = [...new Set(DATA.filter(r => r.subject === APP.subject).map(r => r.year))].sort((a,b) => b-a);
  $("#years").innerHTML = ys.map(y =>
    `<button class="chip ${state.years.has(y) ? "on" : ""}" data-y="${y}">${y}</button>`).join(" ");
  $("#years").querySelectorAll(".chip").forEach(c => c.onclick = () => {
    const y = +c.dataset.y;
    state.years.has(y) ? state.years.delete(y) : state.years.add(y);
    renderAll();
  });
}

function renderSchools(){
  const avail = [...new Set(TRIALS.filter(r => r.subject === APP.subject).map(r => r.school))].sort();
  const sel = $("#school");
  /* a school only means anything for trials, and only for a subject that has
     them — otherwise clear it rather than silently filtering to nothing */
  const usable = state.source !== "HSC" && avail.length > 0;
  if (!usable) state.school = "";
  else if (!avail.includes(state.school)) state.school = "";
  sel.innerHTML = `<option value="">Any school</option>` +
    avail.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = state.school;
  sel.disabled = !usable;

  /* if this subject has no trials at all, don't leave the user on an empty
     "trials only" view */
  const src = $("#source");
  const hasTrials = avail.length > 0;
  src.options[2].disabled = !hasTrials;
  if (!hasTrials && state.source === "Trial") {
    state.source = "";
    src.value = "";
  }
}

/* ---------- browse tree -------------------------------------------------- */
function renderTree(){
  const mods = Object.keys(TAX[APP.subject] || {}).sort((a,b) => MODORDER(a)-MODORDER(b));
  const allN = DATA.filter(r => baseFilter(r, true)).length;

  let html = `<button class="allbtn ${!state.module && !state.iq ? "on" : ""}" id="allb">All questions<span class="cnt">${allN}</span></button>`;
  html += mods.map(m => {
    const iqs = TAX[APP.subject][m];
    const mN = m === UNSORTED
      ? DATA.filter(r => baseFilter(r, true) && !(r.tags || []).length).length
      : DATA.filter(r => baseFilter(r, true) && (r.tags || []).some(t => t.module === m)).length;
    const open = state.openMods.has(m) || state.module === m;
    const rows = orderedIQs(m).map(iq => {
      const n = m === UNSORTED
        ? DATA.filter(r => baseFilter(r, true) && !(r.tags || []).length).length
        : DATA.filter(r => baseFilter(r, true) && (r.tags || []).some(t => t.iq === iq)).length;
      return `<button class="iq ${state.iq === iq ? "on" : ""}" data-m="${esc(m)}" data-iq="${esc(iq)}">
        <span class="t"><b>${esc(iqs[iq])}</b><i>${esc(iq)}</i></span><span class="cnt">${n}</span></button>`;
    }).join("");
    return `<div class="mod ${open ? "open" : ""}" data-m="${esc(m)}">
      <button class="${state.module === m && !state.iq ? "on" : ""}"><span class="name">${esc(m)}</span><span class="cnt">${mN}</span></button>
      <div class="iqs">${rows}</div></div>`;
  }).join("");
  $("#treelist").innerHTML = html;

  $("#allb").onclick = () => { state.module = null; state.iq = null; renderAll(); };
  $("#treelist").querySelectorAll(".mod > button").forEach(b => b.onclick = () => {
    const m = b.parentElement.dataset.m;
    if (state.module === m && !state.iq){ state.module = null; state.openMods.delete(m); }
    else { state.module = m; state.iq = null; state.openMods.add(m); }
    renderAll();
  });
  $("#treelist").querySelectorAll(".iq").forEach(b => b.onclick = () => {
    state.module = b.dataset.m;
    state.iq = state.iq === b.dataset.iq ? null : b.dataset.iq;
    state.openMods.add(b.dataset.m);
    renderAll();
    if (window.innerWidth <= 900){ $("#tree").classList.remove("open"); window.scrollTo({ top:0 }); }
  });
}

/* ---------- question cards ----------------------------------------------- */
function card(r){
  const isTrial = r.source === "Trial";
  const origin = isTrial ? `${r.year} ${r.school} trial` : `${r.year} HSC`;
  const tagbtns = (r.tags || []).map(t =>
    `<span class="tag" data-m="${esc(t.module)}" data-iq="${esc(t.iq)}" title="${esc(t.iq)}">${esc(t.module.replace("Module","Mod").split(":")[0])} · ${esc(t.topic)}</span>`).join("");
  const qimgs = (r.questionImages || []).map(p =>
    `<img loading="lazy" src="${esc(p)}" alt="Question ${r.questionNumber}, ${r.year} HSC ${esc(r.subject)}">`).join("");

  let mg = "";
  if (r.section === "I" && r.answer) mg = `<div class="mcans">Correct answer: <b>${esc(r.answer)}</b></div>`;
  mg += (r.mgImages || []).map(p =>
    `<img loading="lazy" src="${esc(p)}" alt="Marking guidelines for question ${r.questionNumber}">`).join("");
  const parts = r.parts && r.parts.length > 1
    ? `<div class="parts">Parts: ${r.parts.map(p => `${p.part ? "("+p.part+")" : ""} ${p.marks} mk`).join(" · ")}</div>` : "";

  return `<article class="qcard" data-id="${esc(r.id)}">
    <div class="qhead">
      <span class="qtitle">${esc(origin)} · Q${r.questionNumber}</span>
      ${r.marks ? `<span class="marksq">${r.marks} mark${r.marks === 1 ? "" : "s"}</span>` : ""}
      <span class="badge">Section ${r.section} — ${r.section === "I" ? "multiple choice" : "extended response"}</span>
      <span class="badge${isTrial ? " trial" : ""}">${isTrial ? "Trial paper" : "NESA HSC"}</span>
      ${isTrial && (r.confidence === "med" || r.confidence === "low") ? `<span class="badge auto" title="Topic assigned automatically from the question text and the syllabus — likely right, but check it">auto-tagged</span>` : ""}
    </div>
    <div class="tagline">${tagbtns}</div>
    <div class="qimgs">${qimgs}</div>
    <div class="qfoot">
      ${(r.mgImages || []).length || r.answer ? `<button class="reveal" aria-expanded="false">Show marking guidelines &amp; sample answer</button>` : `<span class="reveal none">No solutions with this paper</span>`}
      <button class="markit" title="Send this question and its official guidelines to the marker">✎ Mark my answer</button>
    </div>
    <div class="mg"><div class="mghdr">${isTrial ? "Marking guidelines from the school's solutions" : "Official NESA marking guidelines"}</div>${mg || "<p class=\"note\" style=\"margin:0\">No solutions were published with this paper.</p>"}${parts}</div>
  </article>`;
}

let shown = 0, matched = [];

function renderResults(reset){
  if (reset !== false){
    matched = DATA.filter(r => baseFilter(r))
      .sort((a,b) => b.year - a.year || a.questionNumber - b.questionNumber);
    shown = 0;
    $("#results").innerHTML = "";
  }
  const chunk = matched.slice(shown, shown + 25);
  shown += chunk.length;
  $("#results").insertAdjacentHTML("beforeend", chunk.map(card).join(""));
  if (!matched.length){
    $("#results").innerHTML = `<div class="empty" style="padding:40px 10px;text-align:center">No questions match. Try clearing a filter or broadening the search.</div>`;
  }
  bindCards();
  renderCrumb();
}

function renderCrumb(){
  let path = `<b>${esc(APP.subject)}</b>`;
  if (state.source) path += ` · ${state.source === "HSC" ? "HSC exams" : "trial papers"}`;
  if (state.school) path += ` · <b>${esc(state.school)}</b>`;
  if (state.module) path += ` → <b>${esc(state.module)}</b>`;
  if (state.iq){
    const topic = (TAX[APP.subject][state.module] || {})[state.iq] || "";
    path += ` → <b>${esc(topic)}</b> — <i>“${esc(state.iq)}”</i>`;
  }
  $("#crumb").innerHTML = `${path}<span class="count">· ${matched.length} question${matched.length === 1 ? "" : "s"}</span>`;
}

function bindCards(){
  $("#results").querySelectorAll(".qcard").forEach(c => {
    if (c._bound) return;
    c._bound = true;

    const btn = c.querySelector("button.reveal");
    if (btn) btn.onclick = () => {
      const open = c.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Hide marking guidelines & sample answer"
                             : "Show marking guidelines & sample answer";
    };

    c.querySelector(".markit").onclick = () => {
      const rec = DATA.find(r => r.id === c.dataset.id);
      if (rec) sendToMarker(rec);
    };

    c.querySelectorAll(".tag").forEach(t => t.onclick = () => {
      state.module = t.dataset.m; state.iq = t.dataset.iq;
      state.openMods.add(t.dataset.m);
      renderAll(); window.scrollTo({ top:0 });
    });
  });
}

window.addEventListener("scroll", () => {
  if (APP.view === "browse" && shown < matched.length &&
      window.innerHeight + window.scrollY > document.body.offsetHeight - 900){
    renderResults(false);
  }
});

$("#q").addEventListener("input", e => { state.q = e.target.value.trim(); renderTree(); renderResults(); });
$("#source").onchange = e => { state.source = e.target.value; renderSchools(); renderAll(); };
$("#school").onchange = e => { state.school = e.target.value; renderAll(); };
$("#section").onchange = e => { state.section = e.target.value; renderAll(); };
$("#marks").onchange = e => { state.marks = e.target.value; renderAll(); };
$("#clear").onclick = () => {
  state.q = ""; state.years = new Set(); state.section = ""; state.marks = "";
  state.source = ""; state.school = ""; state.module = null; state.iq = null;
  $("#q").value = ""; $("#section").value = ""; $("#marks").value = "";
  $("#source").value = ""; $("#school").value = "";
  renderSchools(); renderAll();
};
$("#navtoggle").onclick = () => {
  const open = $("#tree").classList.toggle("open");
  $("#navtoggle").setAttribute("aria-expanded", String(open));
};

function renderAll(){ renderYears(); renderTree(); renderResults(); }
renderSchools();

/* ==========================================================================
   PRACTICE TEST
   ========================================================================== */
const PT = { checked:new Set() };
const rint = n => Math.floor(Math.random()*n);
function shuffle(a){ a = a.slice(); for (let i=a.length-1;i>0;i--){ const j=rint(i+1); [a[i],a[j]]=[a[j],a[i]]; } return a; }

function ptPools(){
  const pool = DATA.filter(r => r.subject === APP.subject && r.tags.some(t => PT.checked.has(t.iq)));
  return {
    mc: pool.filter(r => r.section === "I"),
    short: pool.filter(r => r.section === "II" && r.marks <= 4),
    ext: pool.filter(r => r.section === "II" && r.marks >= 5)
  };
}

function ptTime(marks){
  const m = Math.max(5, Math.round(marks*1.8/5)*5);
  return m >= 60 ? Math.floor(m/60)+" hr "+(m%60 ? m%60+" min" : "") : m+" min";
}

function ptUpdateMeta(){
  const p = ptPools();
  const want = [ +$("#ptmc").value||0, +$("#ptshort").value||0, +$("#ptext").value||0 ];
  const av = [ p.mc.length, p.short.reduce((s,r)=>s+r.marks,0), p.ext.reduce((s,r)=>s+r.marks,0) ];
  [["avmc",0],["avshort",1],["avext",2]].forEach(([id,i]) => {
    const e = $("#"+id);
    e.textContent = av[i] + " marks available";
    e.classList.toggle("short", want[i] > av[i]);
  });
  const tot = want[0]+want[1]+want[2];
  $("#pttotal").innerHTML = `<b>${tot} marks</b> · recommended working time ≈ ${ptTime(tot)}` +
    (PT.checked.size ? "" : ` — <span style="color:var(--pen)">select at least one topic</span>`);
  $("#ptgen").disabled = !PT.checked.size || !tot;
}

function ptRenderTree(){
  $("#ptsubj").textContent = APP.subject;
  /* the catch-all bucket is deliberately absent here: a practice test is built
     by topic, and untagged questions match no topic, so offering it would only
     ever yield an empty paper. They stay reachable from Browse. */
  const mods = Object.keys(TAX[APP.subject] || {})
    .filter(m => m !== UNSORTED)
    .sort((a,b) => MODORDER(a)-MODORDER(b));
  $("#pttree").innerHTML = mods.map(m => {
    const iqs = TAX[APP.subject][m];
    const rows = orderedIQs(m).map(iq =>
      `<label class="pt-iq"><input type="checkbox" data-iq="${esc(iq)}" data-m="${esc(m)}" ${PT.checked.has(iq)?"checked":""}>
       <span><b>${esc(iqs[iq])}</b> — <i>${esc(iq)}</i></span></label>`).join("");
    const all = Object.keys(iqs).every(iq => PT.checked.has(iq));
    return `<div class="pt-mod"><label><input type="checkbox" class="modcb" data-m="${esc(m)}" ${all?"checked":""}> ${esc(m)}</label>${rows}</div>`;
  }).join("");

  $("#pttree").querySelectorAll(".modcb").forEach(cb => cb.onchange = () => {
    Object.keys(TAX[APP.subject][cb.dataset.m]).forEach(iq =>
      cb.checked ? PT.checked.add(iq) : PT.checked.delete(iq));
    ptRenderTree(); ptUpdateMeta();
  });
  $("#pttree").querySelectorAll(".pt-iq input").forEach(cb => cb.onchange = () => {
    cb.checked ? PT.checked.add(cb.dataset.iq) : PT.checked.delete(cb.dataset.iq);
    ptRenderTree(); ptUpdateMeta();
  });
}

/* greedy marks-budget fill, best of 120 attempts */
function allocate(cands, target){
  let best = [], bestSum = 0;
  for (let t = 0; t < 120 && bestSum < target; t++){
    let rem = target, out = [];
    for (const r of shuffle(cands)){
      if (r.marks <= rem){ out.push(r); rem -= r.marks; }
      if (!rem) break;
    }
    const sum = target - rem;
    if (sum > bestSum){ best = out; bestSum = sum; }
  }
  return best;
}

function ptGenerate(){
  const p = ptPools();
  const mcN = Math.min(+$("#ptmc").value||0, p.mc.length);
  const mc = shuffle(p.mc).slice(0, mcN);
  const short = allocate(p.short, +$("#ptshort").value||0);
  const ext = allocate(p.ext, +$("#ptext").value||0);
  const sii = short.concat(ext).sort((a,b) => a.marks - b.marks || b.year - a.year);
  const total = mc.length + sii.reduce((s,r) => s+r.marks, 0);
  if (!total){
    $("#pttotal").innerHTML = `<span style="color:var(--pen)">No questions matched — select more topics or increase the marks.</span>`;
    return;
  }

  const byMod = {};
  PT.checked.forEach(iq => {
    for (const m of Object.keys(TAX[APP.subject]))
      if (TAX[APP.subject][m][iq]) (byMod[m] = byMod[m] || []).push(TAX[APP.subject][m][iq]);
  });
  const topicsHtml = Object.keys(byMod).sort((a,b) => MODORDER(a)-MODORDER(b)).map(m => {
    const allT = Object.values(TAX[APP.subject][m]);
    const whole = byMod[m].length === allT.length;
    return `<h4>${esc(m)}</h4><ul>` + (whole ? "<li>Entire module</li>"
      : byMod[m].map(t => `<li>${esc(t)}</li>`).join("")) + "</ul>";
  }).join("");

  const today = new Date().toLocaleDateString("en-AU", { day:"numeric", month:"long", year:"numeric" });
  let n = 0;
  /* where a question actually came from. The paper mixes NESA questions with
     school trials, so this cannot be hardcoded to "HSC" — a James Ruse trial
     question was being printed as though NESA had set it. */
  const origin = r => r.source === "Trial"
    ? `${r.year} ${esc(r.school)} trial`
    : `${r.year} HSC`;

  const qhtml = r => {
    n++;
    const imgs = (r.questionImages || []).map(p => `<img src="${esc(p)}" alt="">`).join("");
    return `<div class="ptq" data-qid="${esc(r.id)}">
      <div class="qlbl">Question ${n} <span style="font-weight:400">(${r.marks} mark${r.marks===1?"":"s"})</span>
        <button class="ptmark" data-mark="${esc(r.id)}" title="Send this question to the marker">✎ Mark</button></div>
      <div class="src">Source: ${origin(r)} ${esc(r.subject)} · Q${r.questionNumber}</div>${imgs}</div>`;
  };
  const mcHtml = mc.map(qhtml).join("");
  const siiHtml = sii.map(qhtml).join("");

  let an = 0;
  const ahtml = r => {
    an++;
    const mg = (r.mgImages || []).map(p => `<img src="${esc(p)}" alt="">`).join("");
    /* NESA multiple choice carries a correct-option letter; a trial paper's
       does not, and its solution is an image like any other question */
    const body = (r.section === "I" && r.answer)
      ? `<div class="pt-mcans">Answer: <b>${esc(r.answer)}</b></div>`
      : (mg || `<p class="note" style="margin:0">No solutions were published with this paper.</p>`);
    const what = r.source === "Trial"
      ? "the school's solutions"
      : "official NESA marking guidelines";
    return `<div class="ptq"><div class="qlbl">Question ${an}</div>
      <div class="src">${origin(r)} ${esc(r.subject)} · Q${r.questionNumber} — ${what}</div>${body}</div>`;
  };
  const ansHtml = mc.concat(sii).map(ahtml).join("");

  $("#printview").innerHTML = `
    <div class="pt-toolbar">
      <button class="save" onclick="window.print()">⬇ Save as PDF</button>
      <button class="save" id="ptsend">✎ Send this test to the marker</button>
      <button class="back" id="ptback">← Back to the app</button>
      <span class="tip">In the print dialog choose “Save as PDF” as the destination.</span>
    </div>
    <div class="pt-doc">
      <div class="pt-title pt-titlepage">
        <div class="crest">Practice examination · generated ${today}</div>
        <h1>${esc(APP.subject)}</h1>
        <h2>Practice Test</h2>
        <div class="pt-meta">
          <div><b>Total marks:</b> ${total}</div>
          <div><b>Questions:</b> ${mc.length} multiple choice · ${sii.length} extended response</div>
          <div><b>Recommended time:</b> ${ptTime(total)} (plus 5 minutes reading time)</div>
        </div>
        <div class="pt-topics"><h4 style="text-align:center">Topics included</h4>${topicsHtml}</div>
      </div>
      ${mc.length ? `<div class="pt-sechdr">Section I — Multiple choice</div>
        <p class="pt-secsub">${mc.length} marks · Attempt Questions 1–${mc.length} · Allow about ${ptTime(mc.length)} for this section</p>${mcHtml}` : ""}
      ${sii.length ? `<div class="pt-sechdr">Section ${mc.length?"II":"I"} — Extended response</div>
        <p class="pt-secsub">${sii.reduce((s,r)=>s+r.marks,0)} marks · Show all relevant working in questions involving calculations</p>${siiHtml}` : ""}
      <div class="pt-ans-start"></div>
      <div class="pt-sechdr">Answer sheet — marking guidelines &amp; sample answers</div>
      <p class="pt-secsub">Marking guidelines and sample answers for every question in this test — NESA's for HSC questions, the school's own for trial questions. Mark yourself honestly, or send a question to the marker.</p>
      ${ansHtml}
    </div>`;

  document.body.classList.add("pt-mode");
  window.scrollTo({ top:0 });
  $("#ptback").onclick = exitPaper;

  /* Per question: the accurate, cheap route — one question and its own
     guidelines go to the marker. */
  $("#printview").querySelectorAll("[data-mark]").forEach(b => b.onclick = () => {
    const rec = DATA.find(r => r.id === b.dataset.mark);
    if (!rec) return;
    exitPaper();
    sendToMarker(rec);
  });

  /* Whole paper: attaches every question image at once, for working through
     the test question by question against the paper itself. */
  $("#ptsend").onclick = () => {
    const paper = mc.concat(sii);
    const paths = paper.flatMap(r => r.questionImages || []);
    exitPaper();
    sendPaperToMarker(paths, `${APP.subject} practice test · ${paper.length} questions · ${total} marks`);
  };
}

function exitPaper(){
  document.body.classList.remove("pt-mode");
  $("#printview").innerHTML = "";
}

["ptmc","ptshort","ptext"].forEach(id => $("#"+id).addEventListener("input", ptUpdateMeta));
$("#ptgen").onclick = ptGenerate;

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.body.classList.contains("pt-mode")) exitPaper();
});

/* ---------- react to the shared shell ------------------------------------ */
APP.onSubject.push(() => {
  state.module = null; state.iq = null; state.openMods = new Set();
  renderSchools();
  /* topics belong to one subject, so drop picks that no longer exist */
  [...PT.checked].forEach(iq => {
    const ok = Object.keys(TAX[APP.subject] || {}).some(m => TAX[APP.subject][m][iq]);
    if (!ok) PT.checked.delete(iq);
  });
  renderAll();
  ptRenderTree(); ptUpdateMeta();
});

APP.onView.push(v => {
  if (v === "ptest"){
    /* seed from whatever is selected in Browse, the first time only */
    if (!PT.checked.size){
      if (state.iq) PT.checked.add(state.iq);
      else if (state.module) Object.keys(TAX[APP.subject][state.module] || {}).forEach(iq => PT.checked.add(iq));
    }
    ptRenderTree(); ptUpdateMeta();
  }
});

renderAll();
ptRenderTree();
ptUpdateMeta();
