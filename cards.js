/* ==========================================================================
   Flashcards: storage, scheduling, and the three Bank views.

   The Bank used to be a flat list of marked answers held as one JSON string in
   localStorage. That store could never hold a photo — a single phone picture
   base64-encoded is most of the 5MB budget — so cards live in IndexedDB
   instead, with uploaded images kept as Blobs.

   Images already in this repository cost nothing to reference: a question sent
   to the marker from Browse carries paths like img/trials/….webp, so the card
   stores the path rather than a copy. Only genuinely uploaded files become
   blobs.
   ========================================================================== */
"use strict";

const DB_NAME = "hsc-cards";
const DB_VER  = 1;
const LEGACY_BANK_KEY = "hsc-marker-bank";
const PREFS_KEY = "hsc-cards-prefs";

const DAY = 86400000;
const MIN = 60000;

/* ---------- IndexedDB, wrapped in promises ------------------------------- */
let _db = null;

function openDB(){
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")){
        const s = db.createObjectStore("cards", { keyPath: "id" });
        s.createIndex("due", "srs.due");
        s.createIndex("subject", "subject");
      }
      if (!db.objectStoreNames.contains("blobs"))
        db.createObjectStore("blobs", { keyPath: "id" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn){
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r && "onsuccess" in r){ r.onsuccess = () => { out = r.result; }; }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const dbAll    = store => tx(store, "readonly",  s => s.getAll());
const dbGet    = (store, id) => tx(store, "readonly",  s => s.get(id));
const dbPut    = (store, v)  => tx(store, "readwrite", s => s.put(v));
const dbDel    = (store, id) => tx(store, "readwrite", s => s.delete(id));
const dbClear  = store => tx(store, "readwrite", s => s.clear());

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- preferences -------------------------------------------------- */
const readPrefs = () => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
};
const writePrefs = p => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} };

let PREFS = Object.assign({ newPerDay: 20, lastExport: 0, hideBackupNote: false,
                           scope: "subject" }, readPrefs());
const savePrefs = () => { writePrefs(PREFS); };

/* ---------- SM-2 ---------------------------------------------------------
   Anki's scheduler descends from SM-2: each card carries an ease factor that
   rises when recall is easy and falls when it is not, and the gap to the next
   review is the last gap multiplied by that ease. Getting it wrong sends the
   card back to short learning steps so it comes round again the same session.
   Kept as pure functions so the intervals can be checked without a browser. */

const LEARN_STEPS = [1 * MIN, 10 * MIN];
const EASE_MIN = 1.3, EASE_MAX = 3.0;
const clampEase = e => Math.max(EASE_MIN, Math.min(EASE_MAX, e));

function newSrs(){
  return { due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0, state: "new", step: 0 };
}

/* rating: 1 again | 2 hard | 3 good | 4 easy */
function schedule(srs, rating, now = Date.now()){
  const s = Object.assign({}, srs);
  s.reps += 1;

  if (rating === 1){
    s.lapses += 1;
    s.ease = clampEase(s.ease - 0.20);
    s.state = "learning";
    s.step = 0;
    s.interval = 0;
    s.due = now + LEARN_STEPS[0];
    return s;
  }

  if (s.state === "new" || s.state === "learning"){
    const next = s.step + 1;
    if (rating === 4 || next >= LEARN_STEPS.length){
      s.state = "review";
      s.step = 0;
      s.interval = rating === 4 ? 4 : 1;          // easy graduates further out
      s.ease = clampEase(s.ease + (rating === 4 ? 0.15 : 0));
      s.due = now + s.interval * DAY;
    } else {
      s.state = "learning";
      s.step = next;
      s.due = now + LEARN_STEPS[next];
    }
    return s;
  }

  // review card
  const base = s.interval || 1;
  if (rating === 2){
    s.ease = clampEase(s.ease - 0.15);
    s.interval = Math.max(1, Math.round(base * 1.2));
  } else if (rating === 3){
    s.interval = base === 1 ? 6 : Math.max(1, Math.round(base * s.ease));
  } else {
    s.ease = clampEase(s.ease + 0.15);
    s.interval = base === 1 ? 6 : Math.max(1, Math.round(base * s.ease * 1.3));
  }
  s.state = "review";
  s.due = now + s.interval * DAY;
  return s;
}

/* what each button will do, so the reviewer can label them honestly */
function previewIntervals(srs, now = Date.now()){
  return [1,2,3,4].map(r => {
    const s = schedule(srs, r, now);
    const ms = s.due - now;
    return ms < 45 * MIN ? Math.round(ms / MIN) + "m"
         : ms < 90 * DAY ? Math.max(1, Math.round(ms / DAY)) + "d"
         : Math.round(ms / (30 * DAY)) + "mo";
  });
}

/* ---------- cards -------------------------------------------------------- */
let CARDS = [];

function blankCard(subject){
  return {
    id: uid(), created: Date.now(), updatedAt: Date.now(),
    subject: subject || APP.subject,
    deck: { module: "", iqs: [] },
    front: { text: "", images: [] },
    back:  { text: "", images: [] },
    notes: "", tags: [], starred: false,
    srs: newSrs(), history: [],
  };
}

/* ---------- a card built from a Browse question -------------------------- *
   Browse and the marker turn the same record into the same card, so the shape
   lives here rather than half in each of them.

   The id is derived from the question's own id rather than being random, and
   that one choice earns four things: Browse can ask "is this already a card?"
   without touching the database, the same question added on two devices merges
   to one card instead of two, deleting and re-adding revives the original row
   rather than stranding its tombstone, and the marker can save into the card
   Browse made. */
const questionCardId = recId => "q-" + recId;

function cardFromQuestion(rec){
  const c = blankCard(rec.subject);
  c.id = questionCardId(rec.id);
  const origin = rec.source === "Trial" ? `${rec.school} trial` : "HSC";
  c.front = {
    text: `${rec.year} ${origin} ${rec.subject} Q${rec.questionNumber} — ${(rec.questionText || "").slice(0, 150)}`.trim(),
    images: (rec.questionImages || []).map(p => ({ kind: "repo", src: p })),
  };
  /* "Correct answer", matching what Browse already prints under a multiple
     choice question — the marker used to say "option", and one of them had to
     win now that both build the card here. */
  c.back = { text: "", images: (rec.mgImages || []).map(p => ({ kind: "repo", src: p })) };
  if (rec.section === "I" && rec.answer) c.back.text = `Correct answer: ${rec.answer}`;
  if (rec.mgText) c.back.text = (c.back.text ? c.back.text + "\n\n" : "") + rec.mgText;

  c.tags = [rec.source === "Trial" ? "Trial" : "HSC",
            rec.year && String(rec.year), rec.school].filter(Boolean);
  const mod = rec.tags?.[0]?.module || "";
  c.deck.module = MODULE_LIST(c.subject).includes(mod) ? mod : "";
  c.deck.iqs = (rec.tags || []).map(t => t.iq).filter(Boolean);
  return c;
}

/* Already in the collection? A tombstone does not count: it is there so a
   deletion reaches the other devices, not to stop the question being added
   again. */
function hasQuestionCard(recId){
  const c = CARDS.find(x => x.id === questionCardId(recId));
  return !!c && !c.deleted;
}

/* One click from Browse. `ownBack` is the text the student wrote for the papers
   that came without solutions — about half of them.

   Re-adding a question that was deleted revives the same row rather than making
   a second one. The tombstone blanked both faces, so they are rebuilt, and the
   fresh updatedAt is what carries the revival to the other devices. Its
   schedule starts over: the old one was about a card that no longer exists. */
async function addQuestionCard(rec, ownBack){
  const fresh = cardFromQuestion(rec);
  if (ownBack != null) fresh.back = { text: String(ownBack).trim(), images: [] };

  const mine = CARDS.find(x => x.id === fresh.id);
  if (mine && !mine.deleted) return mine;

  let c = fresh;
  if (mine){
    c = mine;
    delete c.deleted; delete c.deletedAt;
    c.front = fresh.front; c.back = fresh.back;
    c.tags = fresh.tags; c.deck = fresh.deck;
    c.srs = newSrs();
  }
  await putCard(c);
  drawBank();          // the Bank's badge counts this card now
  return c;
}

/* Browse keeps an "Added ✓" on every question it has a card for, so it has to
   hear about every way the collection can change - not just its own clicks.
   Deliberately not called from drawBank(), which runs on every Bank tab switch
   and would sweep Browse for nothing. */
function fireCardsChanged(){
  for (const fn of (APP.onCards || [])) { try { fn(); } catch {} }
}

const TOMBSTONE_TTL = 60 * DAY;

async function loadCards(){
  CARDS = await dbAll("cards");
  /* a deletion has to linger long enough for every device to see it, but not
     forever; anything this old has certainly propagated */
  const stale = CARDS.filter(c => c.deleted && Date.now() - (c.deletedAt || 0) > TOMBSTONE_TTL);
  for (const c of stale) await dbDel("cards", c.id).catch(() => {});
  if (stale.length) CARDS = CARDS.filter(c => !stale.includes(c));
  CARDS.sort((a, b) => b.created - a.created);
}

/* tombstones stay in the store so deletions can propagate, but nothing that
   draws the collection should ever see them */
const visibleCards = () => CARDS.filter(c => !c.deleted);

/* The collection as the Bank should show it.

   Browse, Practice test and the Marker all follow the subject chosen at the
   top; the Bank did not, so a Chemistry session counted Physics and Economics
   cards as due and mixed them into the queue. Scoping here means every count,
   deck, streak and badge follows, because they all read through this.

   "All subjects" stays available: revising everything at once before a block
   of exams is a real way to use it, and the choice is remembered. */
const scopeAll = () => PREFS.scope === "all";
const deckCards = () => scopeAll() ? visibleCards()
                                   : visibleCards().filter(c => c.subject === APP.subject);
const otherSubjectCount = () => visibleCards().length - deckCards().length;

/* Scoped to one subject the name is already known, so a deck is just its
   module; across subjects it has to say which subject it belongs to. */
const deckKey = c => (scopeAll() ? `${c.subject} · ` : "") + (c.deck.module || "No module");

/* A local edit: stamp the clock and let the sync layer know. */
async function putCard(c){
  c.updatedAt = Date.now();
  await putCardRaw(c);
  try { window.onCardsChanged?.(); } catch {}
  fireCardsChanged();
}

/* A write that is not a local edit — a merge from another device, or the
   legacy migration. The incoming updatedAt is what decides future merges, so
   it must survive untouched, and this must not trigger a push back. */
async function putCardRaw(c){
  await dbPut("cards", c);
  const i = CARDS.findIndex(x => x.id === c.id);
  if (i === -1) CARDS.unshift(c); else CARDS[i] = c;
}

/* Soft delete. A row removed outright cannot propagate: the other device has
   no way to tell "deleted here" from "not created here yet", and would send it
   straight back. The card is emptied and marked instead. */
async function removeCard(c){
  for (const im of [...c.front.images, ...c.back.images])
    if (im.kind === "blob") await dbDel("blobs", im.id).catch(() => {});
  c.deleted = true;
  c.deletedAt = Date.now();
  c.front = { text: "", images: [] };
  c.back = { text: "", images: [] };
  await putCard(c);
}

/* Uploaded photos are shrunk before they are stored.

   A phone camera produces 3-5MB per shot, which is far more detail than a
   picture of an exam question needs — the question crops shipped with this app
   are at most 1400px wide and perfectly legible. Downscaling keeps the local
   store small and, once cards sync to a repo, keeps every image under the 1MB
   boundary below which GitHub returns file content inline. */
const MAX_EDGE = 1600;
const WEBP_QUALITY = 0.85;

function shrinkImage(file){
  return new Promise(resolve => {
    if (!file.type.startsWith("image/") || file.type === "image/gif")
      return resolve(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 400000){        // already small enough
        URL.revokeObjectURL(url);
        return resolve(file);
      }
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(b => {
        URL.revokeObjectURL(url);
        /* keep the original if the re-encode somehow came out larger */
        resolve(b && b.size < file.size ? b : file);
      }, "image/webp", WEBP_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/* store an uploaded File and hand back a reference to it */
async function storeBlob(file){
  const id = uid();
  const blob = await shrinkImage(file);
  await dbPut("blobs", { id, blob });
  return { kind: "blob", id };
}

/* object URLs are revoked when the view is redrawn, so nothing leaks */
let liveUrls = [];
function releaseUrls(){ liveUrls.forEach(URL.revokeObjectURL); liveUrls = []; }

async function imgSrc(ref){
  if (ref.kind === "repo") return ref.src;
  const rec = await dbGet("blobs", ref.id);
  if (!rec) return "";
  const url = URL.createObjectURL(rec.blob);
  liveUrls.push(url);
  return url;
}

async function imagesHTML(refs, cls){
  const out = [];
  for (const r of refs || []){
    const src = await imgSrc(r);
    if (src) out.push(`<img class="${cls}" src="${esc(src)}" alt="">`);
  }
  return out.join("");
}

/* ---------- migration from the old bank ---------------------------------- */
async function migrateLegacy(){
  if (CARDS.length) return 0;
  let old = [];
  try { old = JSON.parse(localStorage.getItem(LEGACY_BANK_KEY) || "[]"); } catch { return 0; }
  if (!Array.isArray(old) || !old.length) return 0;

  for (const e of old.slice().reverse()){
    const c = blankCard(e.subject);
    c.id = "legacy-" + (e.id || uid());
    c.created = e.ts || Date.now();
    c.front.text = e.question || "";
    c.back.text = e.answer || "";
    c.notes = e.feedback || "";              // the marker's comment is kept
    c.deck.module = MODULE_LIST(c.subject).includes(e.module) ? e.module : "";
    if (e.source?.year) c.tags.push(String(e.source.year));
    await putCard(c);
  }
  /* the old key is deliberately left in place as a fallback */
  return old.length;
}

/* ---------- syllabus helpers (Year 12, modules 5-8) ---------------------- */
const MODULE_LIST = subject => Object.keys((typeof SYLLABUS !== "undefined" && SYLLABUS[subject]) || {});
const IQ_LIST = (subject, module) => {
  const topics = ((typeof SYLLABUS !== "undefined" && SYLLABUS[subject]) || {})[module] || [];
  return topics.map(topic => ({ topic, iq: IQ_FOR(subject, module, topic) }));
};
/* topic -> inquiry question, read off the tagged data so the strings match */
let _iqCache = null;
function IQ_FOR(subject, module, topic){
  if (!_iqCache){
    _iqCache = {};
    for (const r of (window.QDATA || []).concat(window.TDATA || []))
      for (const t of (r.tags || []))
        _iqCache[`${r.subject}||${t.module}||${t.topic}`] = t.iq;
  }
  return _iqCache[`${subject}||${module}||${topic}`] || topic;
}

/* ---------- the review queue --------------------------------------------
   Due review cards first, then up to newPerDay cards never seen before, so a
   session always clears the backlog before adding to it. */
function todayKey(d = new Date()){ return d.toISOString().slice(0, 10); }

function studiedToday(){
  const k = todayKey();
  return deckCards().reduce((n, c) =>
    n + (c.history || []).filter(h => todayKey(new Date(h.ts)) === k).length, 0);
}

function newSeenToday(){
  const k = todayKey();
  return deckCards().filter(c => (c.history || []).some(h =>
    h.first && todayKey(new Date(h.ts)) === k)).length;
}

function queueFor(filter){
  const now = Date.now();
  const pool = deckCards().filter(filter || (() => true));
  const due = pool.filter(c => c.srs.state !== "new" && c.srs.due <= now)
                  .sort((a, b) => a.srs.due - b.srs.due);
  const fresh = pool.filter(c => c.srs.state === "new")
                    .slice(0, Math.max(0, PREFS.newPerDay - newSeenToday()));
  return due.concat(fresh);
}

function streak(){
  const days = new Set();
  deckCards().forEach(c => (c.history || []).forEach(h => days.add(todayKey(new Date(h.ts)))));
  let n = 0;
  const d = new Date();
  /* today not yet studied should not break a run that is still alive */
  if (!days.has(todayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(todayKey(d))){ n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------- Bank shell --------------------------------------------------- */
let bankTab = "study";
let studyState = null;     // { queue, i, revealed, filter, label }
let editing = null;        // card being edited in the Add/Edit tab

function setBankTab(t){
  bankTab = t;
  $$("#banktabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === t)));
  drawBank();
}

function drawBank(){
  releaseUrls();
  const host = $("#bankbody");
  if (!host) return;
  /* §40: while a card is up, hide everything that is not the card */
  const panel = host.closest(".panel");
  if (panel) panel.classList.toggle("studying", bankTab === "study" && !!studyState);
  if (bankTab === "study") drawStudy(host);
  else if (bankTab === "cards") drawCardList(host);
  else if (bankTab === "stats") drawStats(host);
  else drawEditor(host);
  drawBackupNote();
  const n = queueFor().length;
  const badge = $("#bankcount");
  if (badge) badge.textContent = String(n);
}

function drawBackupNote(){
  const el = $("#backupnote");
  if (!el) return;
  const stale = !PREFS.lastExport || (Date.now() - PREFS.lastExport) > 30 * DAY;
  const show = visibleCards().length > 0 && stale && !PREFS.hideBackupNote;
  el.classList.toggle("hidden", !show);
  if (show && !el.dataset.wired){
    el.dataset.wired = "1";
    el.querySelector(".x").onclick = () => {
      PREFS.hideBackupNote = true; savePrefs(); drawBackupNote();
    };
  }
}

/* ---------- study -------------------------------------------------------- */
function drawStudy(host){
  const due = queueFor().length;
  const total = deckCards().length;
  const newLeft = Math.max(0, PREFS.newPerDay - newSeenToday());

  if (!studyState){
    const byDeck = {};
    deckCards().forEach(c => {
      const k = deckKey(c);
      byDeck[k] = byDeck[k] || { due: 0, total: 0 };
      byDeck[k].total++;
      if (queueFor(x => x.id === c.id).length) byDeck[k].due++;
    });
    const decks = Object.entries(byDeck).sort((a, b) => b[1].due - a[1].due);

    const others = otherSubjectCount();
    host.innerHTML = `
      <div class="scope">
        <span class="lbl">Studying</span>
        <button class="btn ${scopeAll() ? "" : "on"}" data-scope="subject">${esc(APP.subject)}</button>
        <button class="btn ${scopeAll() ? "on" : ""}" data-scope="all">All subjects</button>
        ${!scopeAll() && others
            ? `<span class="note">${others} card${others === 1 ? "" : "s"} in other subjects</span>` : ""}
      </div>
      <div class="dash">
        <div class="stat"><b>${due}</b><span>due now</span></div>
        <div class="stat"><b>${newLeft}</b><span>new left today</span></div>
        <div class="stat"><b>${studiedToday()}</b><span>reviewed today</span></div>
        <div class="stat"><b>${streak()}</b><span>day streak</span></div>
        <div class="stat"><b>${total}</b><span>cards</span></div>
      </div>
      ${total === 0
        ? `<p class="empty">No ${esc(scopeAll() ? "" : APP.subject + " ")}cards yet. Mark an answer and save it, or add one under <b>Add card</b>.${
              !scopeAll() && others ? ` You have ${others} card${others === 1 ? "" : "s"} in other subjects — switch subject up top, or study all subjects.` : ""}</p>`
        : due === 0
          ? `<p class="empty">Nothing due. ${deckCards().filter(c=>c.srs.state==="new").length
              ? "You have hit today's new-card limit — raise it below or come back tomorrow."
              : "Everything is scheduled ahead; come back later."}</p>`
          : `<button class="go" id="startstudy">Study ${due} card${due===1?"":"s"}</button>`}

      ${decks.length ? `<div class="decks">${decks.map(([k, v]) => `
        <button class="deck" data-deck="${esc(k)}">
          <span class="dn">${esc(k)}</span>
          <span class="dc ${v.due ? "on" : ""}">${v.due}</span>
          <span class="dt">/ ${v.total}</span>
        </button>`).join("")}</div>` : ""}

      <div class="custom">
        <span class="lbl">Custom study</span>
        <button class="btn" data-cs="starred">Starred</button>
        <button class="btn" data-cs="hard">Difficult</button>
        <button class="btn" data-cs="all">All cards, shuffled</button>
        <label class="npd">New cards a day
          <input type="number" id="npd" min="0" max="200" value="${PREFS.newPerDay}">
        </label>
      </div>`;

    host.querySelectorAll("[data-scope]").forEach(b => b.onclick = () => {
      PREFS.scope = b.dataset.scope; savePrefs(); drawBank();
    });
    const start = $("#startstudy");
    if (start) start.onclick = () => beginStudy(null, "All due");
    host.querySelectorAll(".deck").forEach(b => b.onclick = () => {
      const k = b.dataset.deck;
      beginStudy(c => deckKey(c) === k, k);
    });
    host.querySelectorAll("[data-cs]").forEach(b => b.onclick = () => {
      const kind = b.dataset.cs;
      if (kind === "starred") beginStudy(c => c.starred, "Starred", true);
      else if (kind === "hard") beginStudy(c => (c.srs.lapses || 0) >= 2, "Difficult", true);
      else beginStudy(() => true, "All cards", true);
    });
    $("#npd").onchange = e => {
      PREFS.newPerDay = Math.max(0, Math.min(200, +e.target.value || 0));
      savePrefs(); drawBank();
    };
    return;
  }

  drawReviewer(host);
}

/* `ignoreSchedule` powers custom study: take the cards regardless of due date */
function beginStudy(filter, label, ignoreSchedule){
  const pool = ignoreSchedule
    ? shuffleCards(deckCards().filter(filter || (() => true)))
    : queueFor(filter);
  if (!pool.length){ return; }
  studyState = { queue: pool, i: 0, revealed: false, label };
  drawBank();
}

function shuffleCards(a){
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

async function drawReviewer(host){
  const st = studyState;
  if (st.i >= st.queue.length){
    host.innerHTML = `<div class="done">
      <p class="t">Done — ${st.queue.length} card${st.queue.length===1?"":"s"} reviewed.</p>
      <button class="btn" id="backtodash">Back to the dashboard</button></div>`;
    $("#backtodash").onclick = () => { studyState = null; drawBank(); };
    return;
  }
  const c = st.queue[st.i];
  if (st.shownAt == null) st.shownAt = Date.now();
  const prev = previewIntervals(c.srs);
  const frontImgs = await imagesHTML(c.front.images, "cardimg");
  const backImgs  = await imagesHTML(c.back.images, "cardimg");

  host.innerHTML = `
    <div class="reviewer ${st.revealed ? "open" : ""}">
      <div class="rhead">
        <span class="pos">${st.i + 1} / ${st.queue.length} · ${esc(st.label)}</span>
        <button class="star ${c.starred ? "on" : ""}" id="rstar" title="Star this card">${c.starred ? "★" : "☆"}</button>
        <button class="btn" id="rquit">Stop</button>
      </div>

      <div class="face front">
        ${c.front.text ? `<div class="ftext">${esc(c.front.text)}</div>` : ""}
        ${frontImgs}
      </div>

      ${st.revealed ? `
        <div class="face back">
          <p class="sec">Answer</p>
          ${c.back.text ? `<div class="ftext">${esc(c.back.text)}</div>` : ""}
          ${backImgs}
          ${!c.back.text && !backImgs ? `<p class="note">This card has no answer yet — edit it under Cards.</p>` : ""}
          ${c.notes ? `<p class="sec">Notes</p><div class="ftext note">${esc(c.notes)}</div>` : ""}
        </div>
        <div class="rate">
          <button data-r="1"><b>Again</b><span>${prev[0]}</span></button>
          <button data-r="2"><b>Hard</b><span>${prev[1]}</span></button>
          <button data-r="3"><b>Good</b><span>${prev[2]}</span></button>
          <button data-r="4"><b>Easy</b><span>${prev[3]}</span></button>
        </div>
        <p class="hint">Keys 1–4</p>`
      : `<button class="go" id="reveal">Show answer</button><p class="hint">Space</p>`}
    </div>`;

  const rev = $("#reveal");
  if (rev) rev.onclick = () => { st.revealed = true; drawBank(); };
  $("#rquit").onclick = () => { studyState = null; drawBank(); };
  $("#rstar").onclick = async () => { c.starred = !c.starred; await putCard(c); drawBank(); };
  host.querySelectorAll(".rate button").forEach(b =>
    b.onclick = () => rate(+b.dataset.r));
}

async function rate(r){
  const st = studyState;
  if (!st || !st.revealed) return;
  const c = st.queue[st.i];
  const first = (c.history || []).length === 0;
  /* capped so a card left open over lunch does not distort the averages */
  const ms = Math.min(Date.now() - (st.shownAt || Date.now()), 5 * MIN);
  /* recorded before scheduling: rating Again resets the interval to zero, so
     the interval afterwards cannot tell a lapse from a card still in learning,
     and retention computed from it could never drop below 100% */
  const wasReview = c.srs.state === "review";
  c.srs = schedule(c.srs, r);
  c.history = (c.history || []).concat({ ts: Date.now(), rating: r, interval: c.srs.interval, first, ms, wasReview });
  await putCard(c);
  /* Again keeps the card in this session, as Anki does */
  if (r === 1) st.queue.push(c);
  st.i += 1;
  st.revealed = false;
  st.shownAt = null;
  drawBank();
}

document.addEventListener("keydown", e => {
  if (APP.view !== "bank" || bankTab !== "study" || !studyState) return;
  if (e.target.matches("input, textarea, select")) return;
  if (e.code === "Space" && !studyState.revealed){
    e.preventDefault(); studyState.revealed = true; drawBank(); return;
  }
  if (studyState.revealed && ["1","2","3","4"].includes(e.key)){
    e.preventDefault(); rate(+e.key);
  }
});

/* ---------- statistics and the activity heatmap (brief §31, §32) ----------
   Everything here is derived from each card's review history, so no extra
   state is stored beyond the per-answer duration recorded in rate(). */

function reviewsByDay(){
  const out = {};
  deckCards().forEach(c => (c.history || []).forEach(h => {
    const k = todayKey(new Date(h.ts));
    out[k] = (out[k] || 0) + 1;
  }));
  return out;
}

function statsSummary(){
  const cards = deckCards();
  const all = cards.flatMap(c => (c.history || []).map(h => ({ ...h, state: c.srs.state })));
  const today = todayKey();
  const todays = all.filter(h => todayKey(new Date(h.ts)) === today);

  /* retention counts only reviews of cards already past the learning steps:
     getting a brand-new card wrong is not forgetting, it is meeting it for the
     first time. A review is "retained" when it was not rated Again. wasReview
     is recorded before scheduling; entries written before that existed fall
     back to the resulting interval, which understates lapses slightly. */
  const mature = all.filter(h => h.wasReview ?? (h.interval >= 1));
  const retained = mature.filter(h => h.rating > 1).length;

  const timed = all.filter(h => typeof h.ms === "number" && h.ms > 0);
  const tomorrow = Date.now() + DAY;

  return {
    studiedToday: todays.length,
    timeToday: todays.reduce((n, h) => n + (h.ms || 0), 0),
    dueTomorrow: cards.filter(c => c.srs.state !== "new" && c.srs.due <= tomorrow).length,
    total: cards.length,
    reviewsTotal: all.length,
    retention: mature.length ? retained / mature.length : null,
    learned: cards.filter(c => c.srs.state === "review").length,
    lapses: cards.reduce((n, c) => n + (c.srs.lapses || 0), 0),
    avgMs: timed.length ? timed.reduce((n, h) => n + h.ms, 0) / timed.length : null,
    streak: streak(),
    perDay: all.length && Object.keys(reviewsByDay()).length
      ? all.length / Object.keys(reviewsByDay()).length : 0,
  };
}

const fmtDuration = ms => {
  if (!ms) return "0m";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
};

function heatmapHTML(){
  const counts = reviewsByDay();
  const weeks = 26;
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  /* start on the Sunday at or before the first day shown, so columns are weeks */
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());

  const max = Math.max(1, ...Object.values(counts));
  const cells = [];
  const months = [];
  let seenMonth = -1;
  for (let d = new Date(start), col = 0; d <= end; d.setDate(d.getDate() + 1)){
    const k = todayKey(d);
    const n = counts[k] || 0;
    const level = n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.99));
    cells.push(`<i class="hc l${level}" title="${k}: ${n} review${n===1?"":"s"}"></i>`);
    if (d.getDay() === 0){
      col++;
      if (d.getMonth() !== seenMonth){
        seenMonth = d.getMonth();
        months.push(`<span style="grid-column:${col}">${d.toLocaleString(undefined,{month:"short"})}</span>`);
      }
    }
  }
  return `<div class="heat">
    <div class="hmonths">${months.join("")}</div>
    <div class="hgrid">${cells.join("")}</div>
    <div class="hkey"><span>Less</span><i class="hc l0"></i><i class="hc l1"></i><i class="hc l2"></i><i class="hc l3"></i><i class="hc l4"></i><span>More</span></div>
  </div>`;
}

function drawStats(host){
  const s = statsSummary();
  if (!s.total){
    host.innerHTML = `<p class="empty">No cards yet, so there is nothing to measure.</p>`;
    return;
  }
  const pct = v => v == null ? "—" : Math.round(v * 100) + "%";
  host.innerHTML = `
    <div class="dash">
      <div class="stat"><b>${s.studiedToday}</b><span>reviewed today</span></div>
      <div class="stat"><b>${fmtDuration(s.timeToday)}</b><span>studied today</span></div>
      <div class="stat"><b>${s.streak}</b><span>day streak</span></div>
      <div class="stat"><b>${s.dueTomorrow}</b><span>due by tomorrow</span></div>
      <div class="stat"><b>${s.total}</b><span>cards</span></div>
    </div>
    <div class="dash">
      <div class="stat"><b>${pct(s.retention)}</b><span>retention</span></div>
      <div class="stat"><b>${s.learned}</b><span>learned</span></div>
      <div class="stat"><b>${s.lapses}</b><span>forgotten</span></div>
      <div class="stat"><b>${s.avgMs == null ? "—" : fmtDuration(s.avgMs)}</b><span>avg answer</span></div>
      <div class="stat"><b>${s.reviewsTotal}</b><span>reviews all up</span></div>
    </div>
    <p class="note" style="margin:14px 0 6px">
      Retention is the share of reviews of cards you already knew that you did not rate
      <b>Again</b>${s.retention == null ? " — nothing has reached that stage yet" : ""}.
      Averaging ${s.perDay.toFixed(1)} reviews on the days you studied.
    </p>
    <p class="sec" style="margin:20px 0 8px">Activity, last 26 weeks</p>
    ${heatmapHTML()}`;
}

/* ---------- card browser ------------------------------------------------- */
/* `subject: null` means "not chosen yet", so the list opens on whatever subject
   is being studied instead of every card at once, while an explicit "" from
   the picker still means every subject. */
const listState = { q: "", subject: null, module: "", starred: false, sort: "created" };
const listSubject = () =>
  listState.subject === null ? (scopeAll() ? "" : APP.subject) : listState.subject;

function cardMatches(c){
  const want = listSubject();
  if (want && c.subject !== want) return false;
  if (listState.module && c.deck.module !== listState.module) return false;
  if (listState.starred && !c.starred) return false;
  const q = listState.q.trim().toLowerCase();
  if (!q) return true;
  const hay = [c.front.text, c.back.text, c.notes, c.deck.module,
               (c.deck.iqs || []).join(" "), (c.tags || []).join(" ")].join(" ").toLowerCase();
  return q.split(/\s+/).every(w => hay.includes(w));
}

function dueLabel(c){
  if (c.srs.state === "new") return "new";
  const ms = c.srs.due - Date.now();
  if (ms <= 0) return "due";
  return ms < DAY ? Math.max(1, Math.round(ms / (60 * MIN))) + "h"
       : Math.round(ms / DAY) + "d";
}

function drawCardList(host){
  const shown = visibleCards();
  const subs = [...new Set(shown.map(c => c.subject))].sort();
  const mods = [...new Set(shown.filter(c => !listSubject() || c.subject === listSubject())
                               .map(c => c.deck.module).filter(Boolean))].sort();
  const rows = shown.filter(cardMatches);
  rows.sort((a, b) => listState.sort === "due" ? a.srs.due - b.srs.due : b.created - a.created);

  host.innerHTML = `
    <div class="cardbar">
      <input type="search" id="csearch" placeholder="Search questions, answers, notes, tags…" value="${esc(listState.q)}">
      <select id="csub"><option value="">Any subject</option>${subs.map(s =>
        `<option ${s===listSubject()?"selected":""}>${esc(s)}</option>`).join("")}</select>
      <select id="cmod"><option value="">Any module</option>${mods.map(m =>
        `<option ${m===listState.module?"selected":""}>${esc(m)}</option>`).join("")}</select>
      <button class="btn ${listState.starred?"on":""}" id="cstar">★ Starred</button>
      <select id="csort">
        <option value="created" ${listState.sort==="created"?"selected":""}>Newest first</option>
        <option value="due" ${listState.sort==="due"?"selected":""}>Due first</option>
      </select>
    </div>
    <p class="count">${rows.length} of ${shown.length} card${shown.length===1?"":"s"}</p>
    <div class="ctable">${rows.length ? rows.map(c => `
      <div class="crow" data-id="${esc(c.id)}">
        <span class="cstar ${c.starred?"on":""}" data-star="${esc(c.id)}">${c.starred?"★":"☆"}</span>
        <span class="cfront">
          <b>${esc((c.front.text || "(image only)").slice(0, 110))}</b>
          <i>${esc(c.deck.module || "No module")}${c.deck.iqs?.length ? " · " + esc(c.deck.iqs.length + " IQ") : ""}${c.front.images.length||c.back.images.length ? " · 🖼" : ""}</i>
        </span>
        <span class="cdue ${c.srs.state==="new"?"new":(c.srs.due<=Date.now()?"on":"")}">${dueLabel(c)}</span>
        <button class="btn" data-edit="${esc(c.id)}">Edit</button>
      </div>`).join("") : `<p class="empty">No cards match. Widen the search.</p>`}</div>`;

  $("#csearch").oninput = e => { listState.q = e.target.value; drawCardList(host); };
  $("#csub").onchange = e => { listState.subject = e.target.value; listState.module = ""; drawCardList(host); };
  $("#cmod").onchange = e => { listState.module = e.target.value; drawCardList(host); };
  $("#csort").onchange = e => { listState.sort = e.target.value; drawCardList(host); };
  $("#cstar").onclick = () => { listState.starred = !listState.starred; drawCardList(host); };
  host.querySelectorAll("[data-star]").forEach(el => el.onclick = async () => {
    const c = CARDS.find(x => x.id === el.dataset.star);
    c.starred = !c.starred; await putCard(c); drawCardList(host);
  });
  host.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    editing = CARDS.find(x => x.id === b.dataset.edit);
    setBankTab("add");
  });
}

/* ---------- editor (Add card, and Edit from the browser) ----------------- */
let draft = null;

function ensureDraft(){
  if (editing){
    draft = JSON.parse(JSON.stringify(editing));
    editing = null;
  }
  if (!draft) draft = blankCard(APP.subject);
  return draft;
}

async function drawEditor(host){
  const c = ensureDraft();
  const isEdit = visibleCards().some(x => x.id === c.id);
  const mods = MODULE_LIST(c.subject);
  const frontImgs = await imagesHTML(c.front.images, "thumb");
  const backImgs  = await imagesHTML(c.back.images, "thumb");

  host.innerHTML = `
    <div class="editor">
      <div class="erow">
        <label>Subject
          <select id="esub">${SUBJECTS.map(s =>
            `<option ${s===c.subject?"selected":""}>${esc(s)}</option>`).join("")}</select>
        </label>
        <label>Module
          <select id="emod"><option value="">— none —</option>${mods.map(m =>
            `<option ${m===c.deck.module?"selected":""}>${esc(m)}</option>`).join("")}</select>
        </label>
      </div>

      <div class="field">
        <label>Inquiry questions <span class="note">— tick any that apply, across modules</span></label>
        <div class="iqpick" id="eiq">${iqPickerHTML(c)}</div>
      </div>

      <div class="field">
        <label for="efront">Front <span class="note">— the question</span></label>
        <div class="inputbox">
          <textarea id="efront" placeholder="Type the question, or paste a screenshot below.">${esc(c.front.text)}</textarea>
          <label class="drop" data-eslot="front">
            <input type="file" accept="image/*" multiple>
            <span class="clip" aria-hidden="true">▤</span> Attach an image — or drop and paste here
          </label>
        </div>
        <div class="thumbs">${frontImgs}${c.front.images.map((_, i) =>
          `<button class="tx" data-rm="front:${i}" title="Remove image">×</button>`).join("")}</div>
      </div>

      <div class="field">
        <label for="eback">Back <span class="note">— the correct answer</span></label>
        <div class="inputbox">
          <textarea id="eback" placeholder="Type the answer, or paste the worked solution below.">${esc(c.back.text)}</textarea>
          <label class="drop" data-eslot="back">
            <input type="file" accept="image/*" multiple>
            <span class="clip" aria-hidden="true">▤</span> Attach an image — or drop and paste here
          </label>
        </div>
        <div class="thumbs">${backImgs}${c.back.images.map((_, i) =>
          `<button class="tx" data-rm="back:${i}" title="Remove image">×</button>`).join("")}</div>
      </div>

      <details class="optional">
        <summary>Notes and tags <span class="note">— optional</span></summary>
        <div class="field">
          <textarea id="enotes" placeholder="Anything to remind yourself when the answer appears.">${esc(c.notes)}</textarea>
          <input id="etags" type="text" placeholder="Tags, comma separated — e.g. Trial, 2024, James Ruse"
                 value="${esc((c.tags||[]).join(", "))}" style="margin-top:8px">
        </div>
      </details>

      <div class="ebtns">
        <button class="go" id="esave">${isEdit ? "Save changes" : "Add card"}</button>
        ${isEdit ? `<button class="btn danger" id="edel">Delete card</button>` : ""}
        <button class="btn" id="ereset">${isEdit ? "Cancel" : "Clear"}</button>
      </div>
      ${isEdit && c.history?.length ? `<p class="hist">${c.history.length} review${c.history.length===1?"":"s"} ·
        ${c.srs.state === "new" ? "not yet studied" : "next in " + dueLabel(c)} ·
        ease ${c.srs.ease.toFixed(2)} · ${c.srs.lapses || 0} lapse${(c.srs.lapses||0)===1?"":"s"}
        <br><span class="note">Editing keeps this history.</span></p>` : ""}
    </div>`;

  wireEditor(host, c, isEdit);
}

function iqPickerHTML(c){
  const subject = c.subject;
  const mods = MODULE_LIST(subject);
  if (!mods.length) return `<p class="note">No syllabus loaded.</p>`;
  return mods.map(m => `
    <div class="iqmod"><span class="mn">${esc(m)}</span>
      ${IQ_LIST(subject, m).map(({ topic, iq }) => `
        <label class="iqopt"><input type="checkbox" value="${esc(iq)}"
          ${(c.deck.iqs || []).includes(iq) ? "checked" : ""}>
          <span>${esc(topic)}</span></label>`).join("")}
    </div>`).join("");
}

function wireEditor(host, c, isEdit){
  $("#esub").onchange = e => { c.subject = e.target.value; c.deck.module = ""; c.deck.iqs = []; drawBank(); };
  $("#emod").onchange = e => { c.deck.module = e.target.value; };
  $("#efront").oninput = e => { c.front.text = e.target.value; };
  $("#eback").oninput  = e => { c.back.text  = e.target.value; };
  const notes = $("#enotes"); if (notes) notes.oninput = e => { c.notes = e.target.value; };
  const tags = $("#etags");
  if (tags) tags.oninput = e => {
    c.tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
  };
  host.querySelectorAll("#eiq input").forEach(cb => cb.onchange = () => {
    c.deck.iqs = Array.from(host.querySelectorAll("#eiq input:checked")).map(x => x.value);
  });

  host.querySelectorAll("[data-eslot]").forEach(zone => {
    const slot = zone.dataset.eslot;
    const input = zone.querySelector("input[type=file]");
    input.onchange = async e => {
      for (const f of e.target.files) c[slot].images.push(await storeBlob(f));
      input.value = ""; drawBank();
    };
    ["dragenter","dragover"].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); zone.classList.add("over"); }));
    ["dragleave","drop"].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); zone.classList.remove("over"); }));
    zone.addEventListener("drop", async e => {
      for (const f of e.dataTransfer?.files || []) if (f.type.startsWith("image/"))
        c[slot].images.push(await storeBlob(f));
      drawBank();
    });
  });

  host.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
    const [slot, i] = b.dataset.rm.split(":");
    const ref = c[slot].images[+i];
    if (ref?.kind === "blob") await dbDel("blobs", ref.id).catch(() => {});
    c[slot].images.splice(+i, 1);
    drawBank();
  });

  $("#esave").onclick = async () => {
    if (!c.front.text.trim() && !c.front.images.length){
      $("#efront").focus();
      return;
    }
    await putCard(c);
    draft = null;
    if (isEdit){ setBankTab("cards"); }
    else {
      /* stay put so the next card can be typed straight away */
      drawBank();
      const t = $("#efront"); if (t) t.focus();
    }
  };
  $("#ereset").onclick = () => { draft = null; setBankTab(isEdit ? "cards" : "add"); };
  const del = $("#edel");
  if (del) del.onclick = async () => {
    await removeCard(c); draft = null; setBankTab("cards");
  };
}

/* paste a screenshot straight into whichever side was last focused */
document.addEventListener("paste", async e => {
  if (APP.view !== "bank" || bankTab !== "add" || !draft) return;
  const imgs = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith("image/"));
  if (!imgs.length) return;
  e.preventDefault();
  const active = document.activeElement?.id;
  const slot = active === "eback" ? "back" : "front";
  for (const f of imgs) draft[slot].images.push(await storeBlob(f));
  drawBank();
});

/* ---------- export / import ---------------------------------------------
   One file holds cards, review history and the uploaded images, so a laptop
   collection can be carried to a phone. Repo-referenced images are paths and
   need no copying. Import merges on card id and keeps whichever side has the
   later review, so importing never silently discards progress made on the
   device you are importing into. */
const blobToDataURL = b => new Promise(res => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.readAsDataURL(b);
});

async function exportCards(){
  const blobs = await dbAll("blobs");
  const images = {};
  for (const b of blobs) images[b.id] = await blobToDataURL(b.blob);
  const payload = { format: "hsc-cards", version: 2, exported: Date.now(),
                    cards: CARDS, images };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `hsc-flashcards-${todayKey()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  PREFS.lastExport = Date.now(); PREFS.hideBackupNote = false; savePrefs();
  drawBank();
}

/* One rule for combining someone else's copy of the collection with this one,
   used by both file import and repo sync.

   The old version compared only the timestamp of the last review, so an edit
   that changed a card's text, tags or module without reviewing it never
   travelled. Cards now carry updatedAt and that decides, with the history
   check kept as a fallback for version-1 export files that predate it. */
function newerThan(inc, mine){
  if (inc.updatedAt || mine.updatedAt)
    return (inc.updatedAt || 0) > (mine.updatedAt || 0);
  const last = c => (c.history || []).length ? c.history[c.history.length - 1].ts : 0;
  return last(inc) > last(mine);
}

async function mergeIncoming(incoming){
  let added = 0, updated = 0, unchanged = 0;
  for (const inc of incoming || []){
    const mine = CARDS.find(c => c.id === inc.id);
    if (!mine){
      /* tombstones are added too: a card deleted elsewhere must stay deleted
         here rather than being recreated on the next sync */
      await putCardRaw(inc);
      added++;
    } else if (newerThan(inc, mine)){
      await putCardRaw(inc);
      updated++;
    } else {
      unchanged++;
    }
  }
  return { added, updated, unchanged };
}

async function importCards(file){
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { return { error: "That file is not valid JSON." }; }
  if (data.format !== "hsc-cards" || !Array.isArray(data.cards))
    return { error: "That does not look like a flashcard export from this app." };

  for (const [id, dataUrl] of Object.entries(data.images || {})){
    if (await dbGet("blobs", id)) continue;
    const blob = await (await fetch(dataUrl)).blob();
    await dbPut("blobs", { id, blob });
  }
  const r = await mergeIncoming(data.cards);
  await loadCards();
  drawBank();
  fireCardsChanged();   // a restore writes through putCardRaw, which does not
  return { ...r, total: data.cards.length };
}

/* ---------- importing pictures and PDFs as cards -------------------------
   A JSON file restores a whole collection. Anything else — a screenshot, a
   photo, a scanned paper — is raw material, so it becomes new cards instead.
   pdf.js is vendored under vendor/ and loaded only when a PDF actually
   arrives, so the usual path pays nothing for it. */

let pdfLib = null;
async function loadPdfLib(){
  if (pdfLib) return pdfLib;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "vendor/pdf.min.js";
    s.onload = res;
    s.onerror = () => rej(new Error("could not load the PDF reader"));
    document.head.appendChild(s);
  });
  pdfLib = window.pdfjsLib;
  pdfLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  return pdfLib;
}

/* every page of a PDF, rendered to an image the same size as an upload */
async function pdfToImages(file, onProgress){
  const lib = await loadPdfLib();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++){
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, MAX_EDGE / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const cv = document.createElement("canvas");
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext("2d");
    /* PDF pages have no background of their own; without this the text lands
       on transparency and disappears against a dark backdrop */
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(await new Promise(r => cv.toBlob(r, "image/webp", WEBP_QUALITY)));
    onProgress?.(i, doc.numPages);
  }
  return out;
}

const isImage = f => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
const isPdf   = f => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/* one page per card, or pages paired as front and back */
function askImportMode(n){
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "modal";
    const pairs = Math.floor(n / 2);
    el.innerHTML = `<div class="modalbox">
      <p class="t">${n} page${n === 1 ? "" : "s"} ready</p>
      <p class="d">How should they become flashcards?</p>
      <div class="mbtns">
        <button class="go" data-m="each">${n} card${n === 1 ? "" : "s"} — one per page</button>
        <button class="btn" data-m="pair"${n < 2 ? " disabled" : ""}>${pairs} card${pairs === 1 ? "" : "s"} — page 1 front, page 2 back, and so on</button>
      </div>
      <p class="note">Pick the second when the pages run question, answer, question, answer —
        a paper followed by its solutions. Either way the cards are yours to edit afterwards.</p>
      <button class="btn mcancel" data-m="cancel">Cancel</button>
    </div>`;
    el.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
      el.remove();
      resolve(b.dataset.m);
    });
    el.onclick = e => { if (e.target === el){ el.remove(); resolve("cancel"); } };
    document.body.appendChild(el);
  });
}

async function importMedia(files, say){
  const pages = [];
  for (const f of files){
    if (isPdf(f)){
      say(`Reading ${f.name}…`);
      pages.push(...await pdfToImages(f, (i, n) => say(`Reading ${f.name} — page ${i} of ${n}…`)));
    } else if (isImage(f)){
      pages.push(await shrinkImage(f));
    }
  }
  if (!pages.length) return { error: "Nothing readable in those files." };

  const mode = await askImportMode(pages.length);
  if (mode === "cancel") return { cancelled: true };

  say("Saving…");
  const made = [];
  if (mode === "pair"){
    for (let i = 0; i + 1 < pages.length; i += 2){
      const c = blankCard(APP.subject);
      c.tags = ["Imported"];
      c.front.images = [await storeBlobDirect(pages[i])];
      c.back.images  = [await storeBlobDirect(pages[i + 1])];
      await putCard(c);
      made.push(c);
    }
  } else {
    for (const pg of pages){
      const c = blankCard(APP.subject);
      c.tags = ["Imported"];
      c.front.images = [await storeBlobDirect(pg)];
      await putCard(c);
      made.push(c);
    }
  }
  await loadCards();
  return { cards: made.length, pages: pages.length, mode };
}

/* pages are already shrunk, so they skip the resize storeBlob would redo */
async function storeBlobDirect(blob){
  const id = uid();
  await dbPut("blobs", { id, blob });
  return { kind: "blob", id };
}

/* ---------- the save panel the marker shows after a mark ------------------ */
/* payload: { subject, front:{text,images}, back:{text,images}, notes, tags, iqs, module, id } */
function renderSavePanel(host, payload){
  const c = blankCard(payload.subject);
  /* A question is one card wherever it is saved from. Given the id Browse
     would use, marking a question you had already added updates that card
     instead of making a second one — so the panel says so, because this
     replaces a back the student may have written themselves. */
  if (payload.id) c.id = payload.id;
  const updating = payload.id ? hasQuestionCard(String(payload.id).replace(/^q-/, "")) : false;
  c.front = payload.front;
  c.back = payload.back;
  c.notes = payload.notes || "";
  c.tags = payload.tags || [];
  c.deck.module = payload.module && MODULE_LIST(c.subject).includes(payload.module) ? payload.module : "";
  c.deck.iqs = payload.iqs || [];

  const mods = MODULE_LIST(c.subject);
  host.innerHTML = `
    <div class="savecard">
      <p class="t">${updating ? "Update the flashcard for this question" : "Add this to your flashcards"}</p>
      <p class="d">${updating
        ? "You already have a card for this question. Saving replaces both its sides with what is here."
        : (payload.backNote || "The question goes on the front, the correct answer on the back.")}</p>
      <div class="erow">
        <label>Module
          <select id="svmod"><option value="">— none —</option>${mods.map(m =>
            `<option ${m===c.deck.module?"selected":""}>${esc(m)}</option>`).join("")}</select>
        </label>
      </div>
      <div class="iqpick" id="sviq">${iqPickerHTML(c)}</div>
      <div class="ebtns">
        <button class="btn primary" id="svsave">${updating ? "Update flashcard" : "Add flashcard"}</button>
      </div>
    </div>`;

  $("#svmod").onchange = e => { c.deck.module = e.target.value; };
  host.querySelectorAll("#sviq input").forEach(cb => cb.onchange = () => {
    c.deck.iqs = Array.from(host.querySelectorAll("#sviq input:checked")).map(x => x.value);
  });
  $("#svsave").onclick = async () => {
    await putCard(c);
    host.innerHTML = `<div class="savecard saved">
      <p class="t">${updating ? "Flashcard updated" : "Added to your flashcards"}</p>
      <p class="d" style="margin:0">It is scheduled to come round under <b>Bank → Study</b>.</p></div>`;
    drawBank();
  };
}

/* ---------- boot --------------------------------------------------------- */
async function initCards(){
  try {
    await loadCards();
    const n = await migrateLegacy();
    if (n) await loadCards();
    if (n) {
      const note = $("#migrated");
      if (note){
        note.textContent = `${n} saved answer${n===1?"":"s"} from your old bank ${n===1?"has":"have"} been turned into flashcards.`;
        note.classList.remove("hidden");
      }
    }
  } catch (err){
    const host = $("#bankbody");
    if (host) host.innerHTML = `<p class="empty">Flashcards need browser storage, which this browser has blocked
      (private mode can do this). Everything else in the app still works.</p>`;
    return;
  }

  $$("#banktabs button").forEach(b => b.onclick = () => { if (b.dataset.tab !== "add") draft = null; setBankTab(b.dataset.tab); });
  $("#cexport").onclick = exportCards;
  $("#cimport").onchange = async e => {
    const chosen = Array.from(e.target.files || []);
    e.target.value = "";
    if (!chosen.length) return;
    const msg = $("#importmsg");
    const say = t => { msg.textContent = t; msg.classList.remove("hidden"); };

    const json = chosen.filter(f => /\.json$/i.test(f.name) || f.type === "application/json");
    const media = chosen.filter(f => !json.includes(f));
    try {
      /* a JSON file is a collection to restore; anything else is material to
         turn into new cards */
      if (json.length){
        const r = await importCards(json[0]);
        say(r.error ? r.error
          : `Restored: ${r.added} new, ${r.updated} updated, out of ${r.total} cards.`);
        if (media.length) return;
      }
      if (media.length){
        const r = await importMedia(media, say);
        if (r.cancelled) return msg.classList.add("hidden");
        say(r.error ? r.error
          : `Added ${r.cards} card${r.cards === 1 ? "" : "s"} from ${r.pages} page${r.pages === 1 ? "" : "s"}.`
            + (r.mode === "each" ? " Each has a blank back — fill it in under Cards." : ""));
        setBankTab("cards");
      }
    } catch (err){
      say("Import failed: " + (err?.message || "unreadable file."));
    }
    drawBank();
  };
  drawBank();
  /* Browse painted its "Add card" buttons before this file had even been
     parsed, let alone opened the database, so every one of them currently reads
     "Add card". Now that the collection is loaded, tell it the truth. */
  fireCardsChanged();
}

/* The counts, decks and due badge are all scoped to the chosen subject, so the
   Bank has to be redrawn when the subject changes as well as when it is
   opened - otherwise switching subject leaves the previous one's numbers up. */
APP.onView.push(v => { if (v === "bank") drawBank(); else releaseUrls(); });
APP.onSubject.push(() => { if (!studyState) drawBank(); });

/* the surface sync.js works through, so the two files stay decoupled */
window.cardsAPI = {
  mergeIncoming,
  putCardRaw,
  allCards: () => CARDS,                 // tombstones included: deletions must travel
  reload: async () => { await loadCards(); drawBank(); fireCardsChanged(); },
  redraw: () => drawBank(),
  /* Browse's "Add card" works entirely through these, so it never reaches for
     CARDS, putCard or drawBank directly — and their absence is also how it
     detects that this file has not booted, or that storage is blocked. */
  questionCardId,
  hasQuestionCard,
  addQuestionCard,
  hasBlob: async id => !!(await dbGet("blobs", id)),
  getBlob: async id => (await dbGet("blobs", id))?.blob || null,
  putBlob: (id, blob) => dbPut("blobs", { id, blob }),
};

window.renderSavePanel = renderSavePanel;
/* marker.js hands over File objects the user attached; they become blobs here */
window.storeUploaded = storeBlob;
window.cardsReady = initCards();
