/* ==========================================================================
   Cross-device sync through a private GitHub repository.

   There is no server here either: the browser talks to api.github.com
   directly, which allows cross-origin requests from any page. Each device
   holds its own fine-grained token, scoped to the contents of one repository
   and nothing else — the same shape as the Anthropic key in marker.js, and
   deliberately not shared between devices.

   A private repo rather than a gist: a "secret" gist is only unlisted, so
   anyone holding the URL can read it, and gists still require a classic token
   whose scope covers every gist on the account.

   Layout inside the repo:
     cards.json            card metadata, scheduling, history and tombstones
     images/<id>.<ext>     one file per uploaded picture, written once
   ========================================================================== */
"use strict";

const SYNC_TOKEN_KEY = "hsc-sync-token";
const SYNC_REPO_KEY  = "hsc-sync-repo";
const SYNC_STATE_KEY = "hsc-sync-state";
const CARDS_PATH = "cards.json";
const API = "https://api.github.com";

const lsGet = k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

const syncToken = () => lsGet(SYNC_TOKEN_KEY).trim();
const syncRepo  = () => lsGet(SYNC_REPO_KEY).trim();
const syncConfigured = () => !!(syncToken() && syncRepo());

let SYNC = Object.assign({ lastSyncedAt: 0, lastError: "", shaCache: {} }, (() => {
  try { return JSON.parse(lsGet(SYNC_STATE_KEY) || "{}"); } catch { return {}; }
})());
const saveSyncState = () => lsSet(SYNC_STATE_KEY, JSON.stringify(SYNC));

let syncing = false;
let suppressPush = false;

/* ---------- GitHub REST ---------------------------------------------------- */
class SyncError extends Error {}

async function ghFetch(path, opts = {}){
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      headers: {
        "Authorization": `Bearer ${syncToken()}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch {
    throw new SyncError("Could not reach GitHub. Check your connection and try again.");
  }
  if (res.status === 401)
    throw new SyncError("GitHub rejected the token. Check it was copied whole and has not expired.");
  if (res.status === 403){
    /* the rate-limit header is only readable if CORS exposes it, so the body
       is the dependable signal for telling a quota out from a permission
       problem — both arrive as 403 */
    const left = res.headers.get("x-ratelimit-remaining");
    let body = "";
    try { body = (await res.clone().json())?.message || ""; } catch {}
    const limited = left === "0" || /rate limit/i.test(body);
    throw new SyncError(limited
      ? "GitHub's hourly request limit is used up. Try again later."
      : "The token does not have permission for this repository. It needs Contents: read and write.");
  }
  /* 404 is deliberately not thrown here: a missing file is normal on a first
     sync, and putFile tells an empty repository apart from a wrong name */
  return res;
}

/* -> { content, sha } | null when the file is not there yet */
async function getFile(path){
  const res = await ghFetch(`/repos/${syncRepo()}/contents/${encodeURI(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError(`GitHub returned ${res.status} reading ${path}.`);
  const j = await res.json();
  if (j.content == null && j.download_url){
    /* over 1MB: content is omitted and has to be fetched raw */
    const raw = await fetch(j.download_url);
    const buf = await raw.arrayBuffer();
    return { bytes: new Uint8Array(buf), sha: j.sha };
  }
  return { content: (j.content || "").replace(/\n/g, ""), sha: j.sha };
}


/* GitHub answers 404 for a private repository a token cannot see, exactly as
   it does for one that is not there — it will not confirm that a private
   repository exists to someone who cannot read it. So "not found" covers three
   different mistakes, and guessing between them wastes the user's time. Ask the
   token who it belongs to and narrow it down. */
async function repoProblem(){
  const [owner, name] = syncRepo().split("/");
  let who = null;
  try {
    const r = await fetch(API + "/user", {
      headers: { "Authorization": `Bearer ${syncToken()}`, "Accept": "application/vnd.github+json" },
    });
    if (r.ok) who = (await r.json()).login;
  } catch {}

  if (!who)
    return "GitHub rejected the token. Check it was pasted whole and has not expired.";

  if (who.toLowerCase() !== (owner || "").toLowerCase())
    return `That token belongs to the GitHub account "${who}", but you asked for a repository under "${owner}". `
      + `Either fix the owner to "${who}/${name || "repository"}", or use a token from the account that owns it.`;

  return `Signed in as "${who}", but "${syncRepo()}" is not visible to this token. Two usual causes: `
    + "the repository does not exist yet — create it, private, with a README; "
    + "or the token cannot reach it. A fine-grained token only reaches repositories picked when it was created, "
    + "so one made before the repository existed will not see it. "
    + "Check github.com/settings/tokens → your token → Repository access, and that Permissions include Contents: read and write.";
}

async function putFile(path, base64, message){
  const send = sha => ghFetch(`/repos/${syncRepo()}/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: base64, ...(sha ? { sha } : {}) }),
  });
  let sha = SYNC.shaCache[path];
  let res = await send(sha);
  if (res.status === 409 || res.status === 422){
    /* stale or missing sha — read the current one and try once more */
    const cur = await getFile(path);
    res = await send(cur ? cur.sha : undefined);
  }
  if (res.status === 404){
    /* A brand new repository with no commits has no default branch, so writing
       a file into it 404s exactly like a wrong name would. */
    const probe = await ghFetch(`/repos/${syncRepo()}`);
    if (probe.ok)
      throw new SyncError("The repository is empty, so there is nothing to write into yet. "
        + "Open it on GitHub, add a README (Add file → Create new file → Commit), then sync again.");
    throw new SyncError(await repoProblem());
  }
  if (!res.ok) throw new SyncError(`GitHub returned ${res.status} writing ${path}.`);
  const j = await res.json();
  SYNC.shaCache[path] = j.content?.sha;
  saveSyncState();
}

async function listImages(){
  const res = await ghFetch(`/repos/${syncRepo()}/contents/images`);
  if (res.status === 404) return new Map();
  if (!res.ok) return new Map();
  const j = await res.json();
  const m = new Map();
  if (Array.isArray(j)) j.forEach(f => m.set(f.name, f.sha));
  return m;
}

/* ---------- base64 <-> blob ------------------------------------------------ */
const EXT = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
const MIME = Object.fromEntries(Object.entries(EXT).map(([k, v]) => [v, k]));

function bytesToBase64(bytes){
  let s = "";
  const chunk = 0x8000;                       // avoid blowing the argument limit
  for (let i = 0; i < bytes.length; i += chunk)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
const base64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const utf8ToBase64 = str => bytesToBase64(new TextEncoder().encode(str));
const base64ToUtf8 = b64 => new TextDecoder().decode(base64ToBytes(b64));

async function blobToBase64(blob){
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/* ---------- pull / push ---------------------------------------------------- */
async function pullAndMerge(){
  const file = await getFile(CARDS_PATH);
  if (!file) return { added: 0, updated: 0, unchanged: 0, fresh: true };
  SYNC.shaCache[CARDS_PATH] = file.sha;

  const json = file.bytes ? new TextDecoder().decode(file.bytes) : base64ToUtf8(file.content);
  let data;
  try { data = JSON.parse(json); }
  catch { throw new SyncError("The sync file in the repository is not readable JSON."); }
  if (!Array.isArray(data.cards)) throw new SyncError("The sync file has an unexpected shape.");

  suppressPush = true;
  let r;
  try {
    r = await window.cardsAPI.mergeIncoming(data.cards);
    /* fetch any picture referenced by a merged card that this device lacks */
    for (const c of data.cards){
      for (const im of [...(c.front?.images || []), ...(c.back?.images || [])]){
        if (im.kind !== "blob") continue;
        if (await window.cardsAPI.hasBlob(im.id)) continue;
        const f = await getFile(`images/${im.id}.${im.ext || "webp"}`);
        if (!f) continue;
        const bytes = f.bytes || base64ToBytes(f.content);
        await window.cardsAPI.putBlob(im.id, new Blob([bytes], { type: MIME[im.ext] || "image/webp" }));
      }
    }
    await window.cardsAPI.reload();
  } finally {
    suppressPush = false;
  }
  return r;
}

async function pushLocal(){
  const cards = window.cardsAPI.allCards();
  const payload = { format: "hsc-cards", version: 2, updated: Date.now(), cards };
  await putFile(CARDS_PATH, utf8ToBase64(JSON.stringify(payload)), "Update flashcards");

  /* images are written once and never rewritten, so only the missing ones go */
  const have = await listImages();
  for (const c of cards){
    for (const im of [...(c.front?.images || []), ...(c.back?.images || [])]){
      if (im.kind !== "blob") continue;
      const blob = await window.cardsAPI.getBlob(im.id);
      if (!blob) continue;
      if (!im.ext){
        im.ext = EXT[blob.type] || "webp";
        await window.cardsAPI.putCardRaw(c);
      }
      const name = `${im.id}.${im.ext}`;
      if (have.has(name)) continue;
      await putFile(`images/${name}`, await blobToBase64(blob), "Add flashcard image");
      have.set(name, true);
    }
  }
}

async function syncNow(){
  if (!syncConfigured() || syncing) return;
  syncing = true;
  paintSync();
  try {
    await pullAndMerge();
    await pushLocal();
    SYNC.lastSyncedAt = Date.now();
    SYNC.lastError = "";
  } catch (err){
    SYNC.lastError = err instanceof SyncError ? err.message
      : "Sync failed: " + (err?.message || "unknown error");
  } finally {
    syncing = false;
    saveSyncState();
    paintSync();
    window.cardsAPI?.redraw?.();
  }
}

/* a burst of edits should produce one sync, not one per keystroke */
let pushTimer = null;
function scheduleAutoPush(){
  if (!syncConfigured() || suppressPush) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, 4000);
}

/* ---------- UI ------------------------------------------------------------- */
function relTime(ts){
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function paintSync(){
  const box = $("#syncbox");
  if (!box) return;
  const on = syncConfigured();
  $("#syncsetup").classList.toggle("hidden", on);
  $("#syncon").classList.toggle("hidden", !on);
  if (on){
    $("#syncrepolabel").textContent = syncRepo();
    $("#syncwhen").textContent = syncing ? "syncing…" : "last synced " + relTime(SYNC.lastSyncedAt);
    $("#syncnow").disabled = syncing;
  }
  const err = $("#syncerr");
  err.textContent = SYNC.lastError || "";
  err.classList.toggle("hidden", !SYNC.lastError);
}

function wireSync(){
  const box = $("#syncbox");
  if (!box) return;

  $("#syncsave").onclick = async () => {
    const t = $("#synctoken").value.trim();
    const r = $("#syncrepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!t || !/^[^/\s]+\/[^/\s]+$/.test(r)){
      SYNC.lastError = "Enter a token and a repository as owner/name.";
      return paintSync();
    }
    lsSet(SYNC_TOKEN_KEY, t);
    lsSet(SYNC_REPO_KEY, r);
    SYNC.lastError = "";
    SYNC.shaCache = {};
    saveSyncState();
    paintSync();
    await syncNow();
  };

  $("#syncnow").onclick = syncNow;

  $("#syncoff").onclick = () => {
    lsSet(SYNC_TOKEN_KEY, "");
    lsSet(SYNC_REPO_KEY, "");
    SYNC.lastSyncedAt = 0; SYNC.lastError = ""; SYNC.shaCache = {};
    saveSyncState();
    $("#synctoken").value = ""; $("#syncrepo").value = "";
    paintSync();
  };

  paintSync();
}

/* ---------- wiring --------------------------------------------------------- */
window.onCardsChanged = scheduleAutoPush;

/* pull when the Bank is opened, so a device picks up other devices' work */
APP.onView.push(v => {
  if (v === "bank" && syncConfigured() && Date.now() - SYNC.lastSyncedAt > 30000) syncNow();
});

(window.cardsReady || Promise.resolve()).then(() => { wireSync(); });
