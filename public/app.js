/* InvoiceTotally for Windows — the app window. No build step, plain modern JavaScript. */
"use strict";

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n === null || n === undefined || n === "" || isNaN(n)) ? "—" :
  (Number(n) < 0 ? "-" : "") + "₹" + Math.abs(Number(n)).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : (s || "—"); };
const ago = (t) => { if (!t) return "never"; const s = Date.now() / 1000 - t; if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return new Date(t * 1000).toLocaleDateString(); };
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

// The app window is opened with a key (by the desktop icon); only it can talk to the app on this PC.
function takeKey() {
  const m = /[#&?]k=([\w-]{32,})/.exec(location.hash);
  if (m) {
    try { localStorage.setItem("it_key", m[1]); } catch {}
    history.replaceState(null, "", location.pathname + "#/");
    return m[1];
  }
  try { return localStorage.getItem("it_key") || ""; } catch { return ""; }
}
let KEY = takeKey();
let ME = null; // the account on this PC, its licence and Tally's state (GET /me)

// ---- activity feedback: top loading bar + spinner on the button you clicked -------------
let QUIET_RENDER = false, quietNext = false;
let pending = 0, barTimer = null, lastClick = { el: null, at: 0 };
const busyEls = new Set();
document.addEventListener("click", (e) => {
  const b = e.target.closest("button, a.btn, .opt, tr.click");
  if (b) lastClick = { el: b, at: Date.now() };
}, true);
function loadingStart(quiet) {
  if (!quiet && lastClick.el && Date.now() - lastClick.at < 600 && lastClick.el.isConnected && lastClick.el.matches("button, a.btn")) {
    lastClick.el.classList.add("busy");
    if (lastClick.el.tagName === "BUTTON") lastClick.el.disabled = true;
    busyEls.add(lastClick.el);
  }
  if (pending++ === 0 && !quiet) { clearTimeout(barTimer); barTimer = setTimeout(() => $("#loadbar")?.classList.add("on"), 120); }
}
function loadingEnd() {
  if (--pending > 0) return;
  pending = 0;
  // Wait a moment: an action is usually followed straight away by a page refresh — keep the spinner through it.
  setTimeout(() => {
    if (pending > 0) return;
    clearTimeout(barTimer);
    $("#loadbar")?.classList.remove("on");
    for (const el of busyEls) { el.classList.remove("busy"); if (el.tagName === "BUTTON") el.disabled = false; }
    busyEls.clear();
  }, 80);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), "x-it-key": KEY };
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  loadingStart(opts.quiet ?? QUIET_RENDER);
  try {
    let r;
    try { r = await fetch("/api" + path, { method: opts.method || (body ? "POST" : "GET"), headers, body }); }
    catch { throw new Error("InvoiceTotally has stopped. Close this window and open it again from the desktop icon."); }
    const data = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
    if (r.status === 401 && data?.code === "window") { showNoKey(); throw new Error(data.error); }
    if (r.status === 401 && data?.code === "signin" && !path.startsWith("/signin")) { ME = null; location.hash = "#/signin"; throw new Error("Please sign in"); }
    if (!r.ok) { const e = new Error(data?.error || `Something went wrong (${r.status}) — please try again.`); e.code = data?.code; e.status = r.status; throw e; }
    return data;
  } finally { loadingEnd(); }
}
function showNoKey() {
  app().innerHTML = `<div class="page signin"><div class="brandmark">IT</div><h1>Open InvoiceTotally from its icon</h1>
    <p class="muted">This page was opened in an ordinary browser. For your data's safety, InvoiceTotally only works in its own window —
    double-click <b>InvoiceTotally</b> on the desktop or in the Start menu.</p></div>`;
}
const IMG_CACHE = new Map();
async function loadPageImages(root) {
  for (const img of $$("img[data-pid]", root)) {
    const pid = img.dataset.pid;
    try {
      if (!IMG_CACHE.has(pid)) IMG_CACHE.set(pid, api(`/pages/${pid}`, { quiet: true }).then((r) => "data:image/jpeg;base64," + r.b64));
      img.src = await IMG_CACHE.get(pid);
    } catch { IMG_CACHE.delete(pid); img.alt = "Could not load page image — refresh to try again"; }
  }
}

function toast(msg, err = false) {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), err ? 6000 : 2500);
}
async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); throw e; }
}

// view lifecycle -------------------------------------------------------------
let cleanups = [];
let keymap = {};
function onCleanup(fn) { cleanups.push(fn); }
function every(ms, fn) { const id = setInterval(fn, ms); onCleanup(() => clearInterval(id)); }
document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
  if ($(".modal-bg")) { if (e.key === "Escape") $(".modal-bg").remove(); return; }
  const k = e.key === "Escape" ? "Escape" : (e.altKey ? "Alt+" : "") + e.key.toLowerCase();
  if (typing && k !== "Escape" && k !== "enter") return;
  if (typing && k === "enter" && !keymap.enterInInputs) return;
  if (keymap[k]) { e.preventDefault(); keymap[k](e); }
});

const app = () => $("#app");
let CURRENT = { company: null };

// ---------------------------------------------------------------------------
// top bar: where you are · Tally · your account
// ---------------------------------------------------------------------------
function tallyState(company) {
  const t = ME?.tally || {};
  if (company) {
    if (company.tally_status === "down" || t.status === "down") return ["off", "Tally not running"];
    if (company.tally_status === "ok" && !company.company_open) return ["warn", `“${company.tally_company || company.name}” not open in Tally`];
    if (company.tally_status === "ok") return ["on", "Connected to Tally"];
    return ["warn", "Checking Tally…"];
  }
  return t.status === "ok" ? ["on", "Tally connected"] : t.status === "down" ? ["off", "Tally not running"] : ["warn", "Checking Tally…"];
}
function creditsChip() {
  const l = ME?.licence;
  if (!l) return "";
  if (l.unlimited) return `<a class="pill" href="#/admin" title="Admin: users, limits and credits">★ Admin</a>`;
  const low = l.invoice_credits < 10;
  return `<a class="pill ${low ? "warnpill" : ""}" href="#/account" title="Credits left">${plural(l.invoice_credits, "invoice credit")} · ${plural(l.statement_credits, "statement credit")}</a>`;
}
function topBar(crumbs = [], company = null) {
  const cr = crumbs.map((c, i) => i === crumbs.length - 1
    ? `<span class="here">${esc(c[0])}</span>`
    : `<a href="${c[1]}">${esc(c[0])}</a><span class="sep">›</span>`).join("");
  const st = tallyState(company);
  const right = ME?.signed_in ? `<span class="pill" id="tallyPill" title="${esc(ME?.tally?.detail || "")}"><span class="dot ${st[0]}"></span>${esc(st[1])}</span>
      ${company ? `<button class="btn sm" id="importMasters" title="Read ledgers, groups, units and stock items from Tally (Alt+M)" aria-label="Import masters">⟳<span class="lbl"> Import masters</span> <kbd>Alt+M</kbd></button>` : ""}
      ${creditsChip()}
      <a class="btn sm ghost" href="#/account" title="Your account and this PC's settings" aria-label="Account and settings">⚙</a>` : "";
  return `<header class="top">
    <a class="logo" href="#/"><span class="mark">IT</span>InvoiceTotally</a>
    <nav class="crumbs">${cr ? '<span class="sep">›</span>' + cr : ""}</nav>
    <div class="spacer"></div>${right}
    <button class="btn sm ghost icon" id="themeBtn" title="Switch between light and dark" aria-label="Switch between light and dark"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z" fill="currentColor"/></svg></button>
  </header>${ME?.update ? `<div class="banner info">InvoiceTotally ${esc(ME.update.version)} is available. <a href="${esc(ME.update.url)}" target="_blank" rel="noopener"><u>Download the installer</u></a> and run it — your data is kept.</div>` : ""}${ME?.licence?.stale ? `<div class="banner warn">Your licence hasn't been checked for a while — connect this PC to the internet so it can be confirmed.</div>` : ""}`;
}
function wireTop(company) {
  $("#themeBtn")?.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = cur; try { localStorage.setItem("it_theme", cur); } catch {}
  });
  const pill = $("#tallyPill");
  every(10000, async () => {
    try {
      ME = await api("/me", { quiet: true });
      const c = company ? await api(`/companies/${company.id}`, { quiet: true }) : null;
      const st = tallyState(c);
      if (pill?.isConnected) pill.innerHTML = `<span class="dot ${st[0]}"></span>${esc(st[1])}`;
    } catch {}
  });
  if (company) {
    const go = () => act(() => api(`/companies/${company.id}/import-masters`, { method: "POST" }),
      company.tally_status === "ok" ? "Reading masters from Tally…" : "Queued — runs when TallyPrime is open");
    $("#importMasters")?.addEventListener("click", go);
    keymap["Alt+m"] = go;
  }
}
// Theme: your choice (◐ in the top bar) wins; until then it follows the computer's light / dark setting.
(() => {
  let saved = null;
  try { saved = localStorage.getItem("it_theme"); } catch {}
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  const apply = () => { document.documentElement.dataset.theme = saved || (mq?.matches ? "light" : "dark"); };
  apply();
  mq?.addEventListener?.("change", () => { try { saved = localStorage.getItem("it_theme"); } catch {} apply(); });
})();

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const routes = [
  [/^#\/signin$/, viewSignin],
  [/^#\/?$/, viewCompanies],
  [/^#\/account$/, viewAccount],
  [/^#\/admin$/, viewAdmin],
  [/^#\/admin\/u\/([^/]+)$/, (e) => viewAdminUser(decodeURIComponent(e))],
  [/^#\/c\/(\w+)$/, (cid) => viewCompany(cid, "batches")],
  [/^#\/c\/(\w+)\/(settings|masters|jobs|bank|gstr2b)$/, viewCompany],
  [/^#\/c\/(\w+)\/bank\/upload$/, (cid) => viewBankUpload(cid)],
  [/^#\/s\/(\w+)$/, (sid) => viewStatement(sid)],
  [/^#\/c\/(\w+)\/gstr2b\/upload$/, (cid) => viewGstUpload(cid)],
  [/^#\/g\/(\w+)$/, (rid) => viewGst(rid)],
  [/^#\/c\/(\w+)\/upload$/, viewUpload],
  [/^#\/b\/(\w+)$/, viewBatch],
  [/^#\/b\/(\w+)\/review\/(party|stock|ledger|tax|sync)$/, viewReview],
  [/^#\/i\/(\w+)$/, viewInvoice],
];
// One render at a time: a refresh asked for while rendering runs once more afterwards (no flicker, no stale overwrite).
let routing = false, routeAgain = false, lastHash = null;
async function route() {
  if (/[#&?]k=/.test(location.hash)) KEY = takeKey();
  if (!KEY) { showNoKey(); return; }
  if (routing) { routeAgain = true; return; }
  routing = true;
  try {
    do {
      routeAgain = false;
      QUIET_RENDER = quietNext; quietNext = false;
      const h = location.hash || "#/";
      const navigating = h !== lastHash;
      lastHash = h;
      cleanups.forEach((f) => { try { f(); } catch {} });
      cleanups = []; keymap = {};
      if (!app().children.length) app().innerHTML = `<div class="boot"><span class="spin"></span> Loading…</div>`;
      else if (navigating && !$(".boot", app())) app().classList.add("dim");
      try {
        if (!ME || navigating) ME = await api("/me", { quiet: true });
        if (!ME.signed_in && h !== "#/signin") { location.hash = "#/signin"; continue; }
        const hit = routes.find(([re]) => re.test(h));
        if (!hit) { location.hash = "#/"; break; }
        await hit[1](...hit[0].exec(h).slice(1));
      } catch (e) {
        if (!/sign in|Open InvoiceTotally from/.test(e.message)) {
          app().innerHTML = topBar() + `<div class="page"><div class="alert bad"><b>Couldn't load this page.</b> ${esc(e.message)}</div>
            <p><button class="btn" onclick="route()">↻ Try again</button> <a class="btn ghost" href="#/">Home</a></p></div>`;
        }
      }
      app().classList.remove("dim");
    } while (routeAgain);
  } finally { routing = false; QUIET_RENDER = false; }
}
// Background refresh of the current page (polling): quiet, keeps everything in place.
const refresh = () => { if (!routing) quietNext = true; route(); };
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------------------
// signing in (Google, on the InvoiceTotally service's page)
// ---------------------------------------------------------------------------
async function viewSignin() {
  if (ME?.signed_in) { location.hash = "#/"; return; }
  app().innerHTML = topBar() + `<div class="page signin">
    <div class="brandmark">IT</div>
    <h1>Sign in to InvoiceTotally</h1>
    <p class="muted">Use the Google account the admin added for you. Sign in once on this PC — it stays signed in.</p>
    <button class="btn primary big" id="go">Sign in with Google</button>
    <div id="msg" style="margin-top:16px"></div>
    ${ME?.service ? `<p class="muted small" style="margin-top:28px">Service: ${esc(ME.service)} · <a href="#" id="chgSvc"><u>change</u></a></p>` : ""}
    <form id="svc" class="card" style="margin-top:16px;${ME?.service ? "display:none" : ""}"><b>InvoiceTotally service address</b>
      <p class="muted small" style="margin:4px 0 8px">Ask the admin for it — for example https://vipulshegur.packpilot.in</p>
      <div style="display:flex;gap:8px"><input class="in" name="url" value="${esc(ME?.service || "")}" placeholder="https://…" required><button class="btn">Save</button></div></form>
  </div>`;
  wireTop();
  let polling = false;
  const say = (html) => { $("#msg").innerHTML = html; };
  $("#chgSvc")?.addEventListener("click", (e) => { e.preventDefault(); $("#svc").style.display = ""; });
  $("#svc").onsubmit = async (e) => { e.preventDefault(); await act(() => api("/service", { body: { url: e.target.url.value } }), "Saved"); ME = null; route(); };
  $("#go").onclick = async () => {
    const r = await act(() => api("/signin/start", { body: {} }));
    const w = window.open(r.url, "itsignin", "width=480,height=660");
    say(`<div class="card approve"><span class="spin"></span> <b>Finish signing in in the window that opened…</b>
      <p class="muted small" style="margin:8px 0 0">${w ? "" : "The window didn't open. "}<a href="${esc(r.url)}" target="itsignin"><u>Open the sign-in page</u></a></p></div>`);
    if (polling) return;
    polling = true;
    const until = Date.now() + 10 * 60_000;
    while (polling && Date.now() < until && location.hash === "#/signin") {
      await new Promise((ok) => setTimeout(ok, 2000));
      try {
        const p = await api("/signin/poll", { body: {}, quiet: true });
        if (p.ok) { polling = false; ME = null; toast("Signed in"); location.hash = "#/"; return; }
        if (p.error) { polling = false; say(`<div class="alert bad">${esc(p.error)}</div>`); return; }
      } catch (e) { polling = false; say(`<div class="alert bad">${esc(e.message)}</div>`); return; }
    }
    polling = false;
  };
  onCleanup(() => { polling = false; });
}

// ---------------------------------------------------------------------------
// account (this PC) · admin (users, limits, credits)
// ---------------------------------------------------------------------------
async function viewAccount() {
  const [me, s] = await Promise.all([api("/licence/refresh", { body: {} }).catch(() => ({ licence: ME?.licence })), api("/settings")]);
  ME.licence = me.licence || ME.licence;
  const l = ME.licence || {};
  const tick = (b) => b ? `<span class="good">Yes</span>` : `<span class="bad">No</span>`;
  app().innerHTML = topBar([["Account & settings"]]) + `<div class="page" style="max-width:820px">
    <h1>Your account</h1>
    <div class="card"><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div class="avatar">${esc((l.name || l.email || "?")[0].toUpperCase())}</div>
      <div style="flex:1"><b>${esc(l.name || l.email)}</b><div class="muted">${esc(l.email)}${l.admin ? " · admin" : ""}</div></div>
      <button class="btn" id="signout">Sign out on this PC</button></div>
      <div class="kv" style="margin-top:14px">
        ${l.unlimited ? `<div><span>Credits</span><b>Unlimited (admin)</b></div>` : `
        <div><span>Invoice credits left</span><b class="${l.invoice_credits < 10 ? "warn" : ""}">${(l.invoice_credits ?? 0).toLocaleString("en-IN")}</b></div>
        <div><span>Statement credits left</span><b class="${l.statement_credits < 3 ? "warn" : ""}">${(l.statement_credits ?? 0).toLocaleString("en-IN")}</b></div>`}
        <div><span>Companies</span><b>${ME.companies} of ${l.unlimited ? "unlimited" : l.company_limit}</b></div>
        <div><span>Can post to Tally</span><b>${tick(l.can_post)}</b></div>
        <div><span>AI for reading</span><b>${(l.ai_options || []).map((a) => esc(ME.ai_labels[a] || a)).join(", ") || "—"}</b></div>
        <div><span>Licence checked</span><b>${me.online === false ? `<span class="warn">offline — last ${ago(l.issued_at)}</span>` : ago(l.issued_at)}</b></div>
      </div>
      ${l.unlimited ? "" : `<p class="muted small" style="margin:12px 0 0">One invoice credit is used for each invoice read; one statement credit for each bank statement saved. To buy more, contact the admin.</p>`}</div>
    ${l.admin ? `<div class="card" style="margin-top:12px"><b>Admin</b><p class="muted" style="margin:4px 0 10px">Add the people who may use InvoiceTotally, set their limits and give them credits.</p>
      <a class="btn primary" href="#/admin">Open the admin panel</a></div>` : ""}
    <h2 style="margin-top:26px">This PC</h2>
    <form class="card" id="bk">
      <div class="field"><label>Daily backup folder</label>
        <input class="in" name="backup_dir" value="${esc(s.backup_dir)}" placeholder="${esc(s.data_dir ? s.data_dir + "\\backups" : "")}">
        <div class="muted small" style="margin-top:4px">A copy of everything is saved here once a day (the last 14 days are kept). A Google Drive or OneDrive folder on this PC is ideal — then a copy is also kept online.</div></div>
      <div class="muted small">${s.backup_last ? (s.backup_last.error ? `<span class="bad">Last backup failed: ${esc(s.backup_last.error)}</span>` : `Last backup ${ago(s.backup_last.at)} — ${esc(s.backup_last.file)}`) : "No backup yet (the first one is made a minute after the app starts)."}</div>
      <div style="margin-top:12px;display:flex;gap:8px"><button class="btn primary">Save</button><button type="button" class="btn" id="bknow">Back up now</button></div></form>
    <div class="kv muted small" style="margin-top:14px"><div><span>App version</span><b>${esc(ME.version)}</b></div><div><span>Data folder</span><b class="mono">${esc(s.data_dir)}</b></div>
      <div><span>Tally</span><b>${esc(ME.tally.detail || ME.tally.status)}${ME.tally.companies?.length ? ` — open: ${ME.tally.companies.map(esc).join(", ")}` : ""}</b></div></div>
  </div>`;
  wireTop();
  $("#signout").onclick = async () => { if (!confirm("Sign out on this PC? Work that is waiting stays here for when you sign in again.")) return; await api("/signout", { body: {} }); ME = null; location.hash = "#/signin"; };
  $("#bk").onsubmit = async (e) => { e.preventDefault(); await act(() => api("/settings", { body: { backup_dir: e.target.backup_dir.value } }), "Saved"); route(); };
  $("#bknow").onclick = async () => { const r = await act(() => api("/backup", { body: {} })); if (r.error) toast(r.error, true); else toast("Backup saved"); route(); };
}

const AI_HELP = {
  gemini_lite: "Google Gemini Flash-Lite on the free tier. Good for clear, printed invoices; limited reads per day.",
  gemini: "Google Gemini Flash (paid). Accurate and cheap — about ₹1 per invoice.",
  groq: "Qwen on Groq's free tier. Free, but about 25 invoices a day and at most 3 pages per invoice.",
  claude: "Anthropic Claude. The most accurate, especially for handwritten bills; costs more.",
};
async function viewAdmin() {
  if (!ME?.licence?.admin) { location.hash = "#/"; return; }
  const r = await api("/admin/users", { body: {} });
  const keyNote = Object.entries(r.ai || {}).filter(([, ok]) => !ok).map(([k]) => ME.ai_labels[k] || k);
  app().innerHTML = topBar([["Admin"]]) + `<div class="page wide">
    <div class="bar" style="padding:0 0 14px;border:0"><h1>Users</h1><div class="spacer"></div><button class="btn primary" id="add">+ Add user</button></div>
    ${keyNote.length ? `<div class="alert warn" style="margin-bottom:12px">No API key on the service for: ${keyNote.map(esc).join(", ")}. Users given only these can't read invoices until the key is added in Cloudflare.</div>` : ""}
    <table class="grid"><thead><tr><th>User</th><th class="num">Invoice credits</th><th class="num">Statement credits</th><th class="num">Companies</th><th>Posting</th><th>AI</th><th>Last seen</th></tr></thead><tbody>
    ${r.users.map((u) => `<tr class="click" data-href="#/admin/u/${encodeURIComponent(u.email)}"><td><b>${esc(u.name || u.email)}</b>${u.admin ? ' <span class="tag">admin</span>' : ""}${u.active ? "" : ' <span class="tag bad">off</span>'}<div class="muted small">${esc(u.email)}</div></td>
      <td class="num">${u.admin ? "∞" : u.invoice_credits.toLocaleString("en-IN")}${u.used?.invoice ? `<div class="muted small">${u.used.invoice.credits} used</div>` : ""}</td>
      <td class="num">${u.admin ? "∞" : u.statement_credits.toLocaleString("en-IN")}${u.used?.statement ? `<div class="muted small">${u.used.statement.credits} used</div>` : ""}</td>
      <td class="num">${u.companies} of ${u.admin ? "∞" : u.company_limit}</td><td>${u.admin || u.can_post ? '<span class="good">Allowed</span>' : '<span class="bad">Blocked</span>'}</td>
      <td class="small">${(u.admin ? Object.keys(AI_HELP) : u.ai_options).map((a) => esc(ME.ai_labels[a] || a)).join(", ")}</td>
      <td class="muted small">${u.last_seen ? ago(u.last_seen) : "not signed in yet"}</td></tr>`).join("")}</tbody></table>
    <p class="muted small" style="margin-top:12px">A user signs in with their Google account on their own PC. Give credits when they pay you; switch a user off to sign them out everywhere.</p></div>`;
  wireTop();
  $$("tr[data-href]").forEach((tr) => tr.onclick = () => location.hash = tr.dataset.href);
  $("#add").onclick = () => userModal(null);
}

function userModal(u) {
  const ai = u?.ai_options || ["gemini_lite"];
  modal(`<h2>${u ? "Edit " + esc(u.name || u.email) : "Add user"}</h2>
    <div class="field"><label>Google email</label><input class="in" name="email" type="email" value="${esc(u?.email || "")}" ${u ? "readonly" : "required"} placeholder="name@gmail.com"></div>
    <div class="field"><label>Name</label><input class="in" name="name" value="${esc(u?.name || "")}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field"><label>Companies allowed</label><input class="in" name="company_limit" type="number" min="0" max="999" value="${u?.company_limit ?? 1}"></div>
      <div class="field"><label>Posting to Tally</label><select class="in" name="can_post"><option value="1" ${u?.can_post !== false ? "selected" : ""}>Allowed</option><option value="0" ${u?.can_post === false ? "selected" : ""}>Blocked — can read and review only</option></select></div></div>
    ${u ? "" : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field"><label>Invoice credits to start with</label><input class="in" name="invoice" type="number" min="0" value="0"></div>
      <div class="field"><label>Statement credits to start with</label><input class="in" name="statement" type="number" min="0" value="0"></div></div>`}
    <div class="field"><label>AI this user may use</label>${Object.keys(AI_HELP).map((k) => `<label class="check-row"><input type="checkbox" name="ai_${k}" ${ai.includes(k) ? "checked" : ""}> <span><b>${esc(ME.ai_labels[k])}</b> <span class="muted small">— ${esc(AI_HELP[k])}</span></span></label>`).join("")}</div>
    <div class="field"><label>Note (only you see it)</label><input class="in" name="note" value="${esc(u?.note || "")}" placeholder="e.g. paid ₹2,000 on 20 Oct by UPI"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${u ? "Save" : "Add user"}</button></div>`,
  async (d) => {
    const body = { email: d.email, name: d.name, company_limit: +d.company_limit, can_post: d.can_post === "1", note: d.note,
      ai_options: Object.keys(AI_HELP).filter((k) => d["ai_" + k]) };
    if (!body.ai_options.length) throw new Error("Tick at least one AI");
    await api("/admin/save-user", { body });
    if (!u && (+d.invoice || +d.statement)) await api("/admin/add-credits", { body: { email: d.email, invoice: +d.invoice || 0, statement: +d.statement || 0, note: d.note } });
    toast(u ? "Saved" : "User added — they can sign in now");
    if (u) route(); else location.hash = `#/admin/u/${encodeURIComponent(d.email.toLowerCase())}`;
  });
}

async function viewAdminUser(email) {
  if (!ME?.licence?.admin) { location.hash = "#/"; return; }
  const r = await api("/admin/user-detail", { body: { email } });
  const u = r.user;
  const KIND = { invoice: "Invoice read", statement: "Statement saved", split: "Pages split", add_invoice: "Invoice credits added", add_statement: "Statement credits added" };
  app().innerHTML = topBar([["Admin", "#/admin"], [u.name || u.email]]) + `<div class="page wide">
    <div class="bar" style="padding:0 0 14px;border:0"><div><h1 style="margin:0">${esc(u.name || u.email)}</h1><div class="muted">${esc(u.email)}${u.note ? " · " + esc(u.note) : ""}</div></div><div class="spacer"></div>
      <button class="btn" id="edit">Edit limits</button>
      ${u.admin ? "" : `<button class="btn ${u.active ? "danger" : ""}" id="toggle">${u.active ? "Switch off" : "Switch on"}</button>`}</div>
    <div class="stats">
      <div><div class="eyebrow">Invoice credits</div><div class="v">${u.admin ? "∞" : u.invoice_credits.toLocaleString("en-IN")}</div></div>
      <div><div class="eyebrow">Statement credits</div><div class="v">${u.admin ? "∞" : u.statement_credits.toLocaleString("en-IN")}</div></div>
      <div><div class="eyebrow">Companies</div><div class="v">${u.companies} <span class="muted" style="font-size:14px">of ${u.admin ? "∞" : u.company_limit}</span></div></div>
      <div><div class="eyebrow">Posting to Tally</div><div class="v" style="font-size:18px">${u.admin || u.can_post ? '<span class="good">Allowed</span>' : '<span class="bad">Blocked</span>'}</div></div></div>
    ${u.admin ? "" : `<form class="card" id="cr" style="margin:14px 0;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="margin:0"><label>Invoice credits</label><input class="in" name="invoice" type="number" value="0" style="width:130px"></div>
      <div class="field" style="margin:0"><label>Statement credits</label><input class="in" name="statement" type="number" value="0" style="width:130px"></div>
      <div class="field" style="margin:0;flex:1;min-width:200px"><label>Note</label><input class="in" name="note" placeholder="e.g. paid ₹2,000 by UPI"></div>
      <button class="btn primary">Add credits</button><span class="muted small" style="width:100%">Use a minus number to take credits away.</span></form>`}
    <div class="cols2">
      <div><h2>Companies</h2>${r.companies.length ? `<table class="grid"><tbody>${r.companies.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="muted small">${esc(c.gstin || "")} · added ${ago(c.created_at)}</div></td>
        <td style="text-align:right"><button class="btn sm" data-free="${esc(c.company_id)}" title="Frees one place under the limit">Remove</button></td></tr>`).join("")}</tbody></table>` : `<p class="muted">None yet.</p>`}
        <h2 style="margin-top:20px">PCs signed in</h2>${r.devices.filter((d) => !d.revoked).length ? `<table class="grid"><tbody>${r.devices.filter((d) => !d.revoked).map((d) => `<tr><td>${esc(d.name)}<div class="muted small">since ${ago(d.created_at)} · last seen ${ago(d.last_seen)}</div></td>
        <td style="text-align:right"><button class="btn sm" data-dev="${esc(d.id)}">Sign out</button></td></tr>`).join("")}</tbody></table>` : `<p class="muted">None.</p>`}</div>
      <div><h2>History</h2>${r.usage.length ? `<table class="grid"><thead><tr><th>When</th><th>What</th><th class="num">Credits</th></tr></thead><tbody>${r.usage.map((x) => `<tr><td class="muted small">${ago(x.at)}</td>
        <td>${esc(KIND[x.kind] || x.kind)}<div class="muted small">${esc(x.detail || "")}${x.ai ? " · " + esc(ME.ai_labels[x.ai] || x.ai) : ""}${x.cost_usd ? ` · AI ≈ ₹${(x.cost_usd * 88).toFixed(2)}` : ""}</div></td>
        <td class="num ${x.credits > 0 ? "good" : ""}">${x.credits > 0 ? "+" : ""}${x.credits || "—"}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Nothing yet.</p>`}</div></div>
    ${u.admin ? "" : `<p style="margin-top:20px"><button class="btn danger sm" id="remove">Remove this user</button></p>`}</div>`;
  wireTop();
  $("#edit").onclick = () => userModal(u);
  $("#toggle")?.addEventListener("click", async () => {
    if (u.active && !confirm(`Switch off ${u.email}? They are signed out on every PC and can't sign in until you switch them on.`)) return;
    await act(() => api("/admin/save-user", { body: { email: u.email, active: !u.active } }), u.active ? "Switched off" : "Switched on"); route();
  });
  $("#cr")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target;
    await act(() => api("/admin/add-credits", { body: { email: u.email, invoice: +f.invoice.value || 0, statement: +f.statement.value || 0, note: f.note.value } }), "Credits updated");
    route();
  });
  $$("[data-free]").forEach((b) => b.onclick = async () => { if (confirm("Remove this company from the user's count? Their data on their PC is not touched.")) { await act(() => api("/admin/free-company", { body: { email: u.email, company_id: b.dataset.free } }), "Removed"); route(); } });
  $$("[data-dev]").forEach((b) => b.onclick = async () => { await act(() => api("/admin/sign-out-device", { body: { id: b.dataset.dev } }), "Signed out"); route(); });
  $("#remove")?.addEventListener("click", async () => { if (confirm(`Remove ${u.email} completely? Their credits and history are deleted.`)) { await act(() => api("/admin/remove-user", { body: { email: u.email } }), "Removed"); location.hash = "#/admin"; } });
}

// ---------------------------------------------------------------------------
// companies
// ---------------------------------------------------------------------------
async function viewCompanies() {
  const list = await api("/companies");
  const l = ME.licence || {};
  const full = !l.unlimited && list.length >= (l.company_limit || 0);
  if (list.length === 1 && !sessionStorage.getItem("it_seen_list")) { sessionStorage.setItem("it_seen_list", 1); location.hash = `#/c/${list[0].id}`; return; }
  app().innerHTML = topBar([["Companies", "#/"]]) + `<div class="page">
    <div class="bar" style="padding:0 0 14px;border:0"><h1>Companies</h1><div class="spacer"></div>
    ${l.unlimited ? "" : `<span class="muted small" style="margin-right:10px">${list.length} of ${l.company_limit} used</span>`}
    <button class="btn primary" id="add" ${full ? `disabled title="Your account allows ${l.company_limit} — ask the admin for more"` : ""}>+ Add company</button></div>
    ${ME.tally.status === "down" ? `<div class="alert warn" style="margin-bottom:12px"><b>TallyPrime isn't answering.</b> Open TallyPrime on this PC. If it is open, turn on its connectivity: <b>F1 Help → Settings → Connectivity</b> → <i>TallyPrime acts as</i> <b>Both</b>, port <b>9000</b>.</div>` : ""}
    ${list.length ? `<div class="cards">${list.map((c) => { const st = tallyState(c); return `<a class="card" href="#/c/${c.id}">
      <div class="big">${esc(c.name)}</div>
      <div class="muted" style="font-size:13px">${esc(c.gstin || "No GSTIN")} ${c.state_name ? "· " + esc(c.state_name) : ""}</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <span class="pill"><span class="dot ${st[0]}"></span>${esc(st[1])}</span>
        <span class="pill">${c.masters.ledger} ledgers · ${c.masters.stock_item} items</span></div></a>`; }).join("")}</div>`
      : `<div class="card empty">Add your first company — the Tally company you'll post invoices into.${ME.tally.companies?.length ? `<div class="muted small" style="margin-top:6px">Open in Tally now: ${ME.tally.companies.map(esc).join(", ")}</div>` : ""}</div>`}
  </div>`;
  wireTop();
  $("#add").onclick = () => companyModal();
}

function modal(html, onSubmit) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<form class="modal">${html}</form>`;
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  const f = $("form", bg);
  setTimeout(() => $("input:not([readonly]),select", f)?.focus(), 20);
  f.onsubmit = async (e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(f)); try { await onSubmit(data); bg.remove(); } catch (err) { toast(err.message, true); } };
  $$("[data-close]", f).forEach((b) => b.onclick = () => bg.remove());
  return bg;
}

function companyModal() {
  const open = ME.tally.companies || [];
  modal(`<h2>Add company</h2>
    <div class="field"><label>Company in Tally</label>${open.length ? `<select class="in" name="tally_company">${open.map((n) => `<option>${esc(n)}</option>`).join("")}<option value="">Other (type below)</option></select>` : ""}
      <input class="in" name="tally_other" placeholder="${open.length ? "…or type the name exactly as in Tally" : "Name exactly as in Tally"}" ${open.length ? "" : "required"} style="margin-top:6px">
      ${open.length ? "" : `<div class="muted small" style="margin-top:4px">Open TallyPrime to pick the company from a list.</div>`}</div>
    <div class="field"><label>Short name in this app (optional)</label><input class="in" name="name"></div>
    <div class="field"><label>Your GSTIN (decides intra- vs inter-state tax)</label><input class="in mono" name="gstin" maxlength="15"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Add</button></div>`,
  async (d) => {
    const tc = (d.tally_other || d.tally_company || "").trim();
    if (!tc) throw new Error("Pick or type the company's name in Tally");
    const c = await api("/companies", { body: { name: (d.name || tc).trim(), tally_company: tc, gstin: d.gstin } });
    await api(`/companies/${c.id}/import-masters`, { method: "POST" }).catch(() => {});
    toast("Company added — reading its masters from Tally");
    location.hash = `#/c/${c.id}`;
  });
}

// ---------------------------------------------------------------------------
// company home
// ---------------------------------------------------------------------------
async function viewCompany(cid, tab) {
  const c = await api(`/companies/${cid}`);
  CURRENT.company = c;
  const tabs = [["batches", "Invoices"], ["bank", "Bank statements"], ["gstr2b", "GSTR-2B"], ["masters", "Masters"], ["jobs", "Tally log"], ["settings", "Settings"]];
  const upload = { bank: ["bank/upload", "⇪ Upload bank statement"], gstr2b: ["gstr2b/upload", "⇪ Upload GSTR-2B"] }[tab] || ["upload", "⇪ Upload invoices"];
  app().innerHTML = topBar([[c.name, `#/c/${cid}`]], c) + `<div class="bar">
      <div class="status">${c.masters.ledger} ledgers · ${c.masters.stock_item} stock items · masters ${c.masters_imported_at ? "imported " + ago(c.masters_imported_at) : c.pending_jobs ? "being read from Tally…" : "not imported yet"}</div>
      <div class="spacer"></div><a class="btn primary" href="#/c/${cid}/${upload[0]}">${upload[1]} <kbd>U</kbd></a></div>
    <div class="page wide"><nav class="tabs">${tabs.map(([k, l]) => `<a href="#/c/${cid}${k === "batches" ? "" : "/" + k}" class="${tab === k ? "on" : ""}">${l}</a>`).join("")}</nav>
    <div id="tab"></div></div>`;
  wireTop(c);
  keymap.u = () => location.hash = `#/c/${cid}/${upload[0]}`;
  const el = $("#tab");
  if (tab === "batches") return companyBatches(c, el);
  if (tab === "masters") return companyMasters(c, el);
  if (tab === "jobs") return companyJobs(c, el);
  if (tab === "settings") return companySettings(c, el);
  if (tab === "bank") return companyBank(c, el);
  if (tab === "gstr2b") return companyGst(c, el);
}

function tallyHelp(c) {
  if (c.tally_status === "down") return `<b>TallyPrime isn't answering.</b> Open TallyPrime on this PC, with <b>F1 Help → Settings → Connectivity</b> → <i>TallyPrime acts as</i> <b>Both</b>, port <b>9000</b>.`;
  if (c.tally_status === "ok" && !c.company_open) return `<b>“${esc(c.tally_company || c.name)}” is not open in Tally.</b> Open it (several companies can be open with <b>Alt+F3</b>), or fix the Tally name in Settings.`;
  return "";
}
async function companyBatches(c, el) {
  const rows = await api(`/companies/${c.id}/batches`);
  const help = tallyHelp(c);
  if (!c.masters.ledger) el.insertAdjacentHTML("beforebegin", `<div class="alert warn" style="margin-bottom:12px">${help || (c.pending_jobs ? "Reading your ledgers and stock items from Tally…" : "Masters aren't imported yet. Press <b>Import masters</b> (top right) so invoices can be matched to your ledgers and stock items.")}</div>`);
  else if (help && c.pending_jobs) el.insertAdjacentHTML("beforebegin", `<div class="alert warn" style="margin-bottom:12px">${help} ${plural(c.pending_jobs, "entry is", "entries are")} waiting to go to Tally.</div>`);
  const stageLbl = { find: "Finding invoices…", split: "Checking the split…", read: "Reading…", review: "", error: "Failed" };
  el.innerHTML = rows.length ? `<table class="grid"><thead><tr><th>Batch</th><th>Type</th><th>Uploaded</th><th class="num">Invoices</th><th>Progress</th></tr></thead><tbody>
    ${rows.map((b) => { const n = b.counts || {}; const done = n.synced || 0;
      return `<tr class="click" data-href="#/b/${b.id}"><td><b>${esc(b.name)}</b></td><td>${esc(b.voucher_type)}</td><td class="muted">${ago(b.created_at)}</td>
      <td class="num">${b.invoices}</td><td>${b.stage !== "review" ? `<span class="${b.stage === "error" ? "bad" : "warn"}">${stageLbl[b.stage]} ${b.stage === "error" ? esc(b.error || "") : ""}</span>` :
        `<span class="${done === b.invoices && done ? "good" : ""}">${done} of ${b.invoices} in Tally</span>${n.failed ? ` · <span class="bad">${n.failed} failed</span>` : ""}`}</td></tr>`; }).join("")}
    </tbody></table>` : `<div class="card empty">No invoices yet. <a class="btn primary" style="margin-left:8px" href="#/c/${c.id}/upload">Upload invoices</a></div>`;
  $$("tr[data-href]", el).forEach((tr) => tr.onclick = () => location.hash = tr.dataset.href);
  every(5000, async () => { if (rows.some((b) => b.stage !== "review" && b.stage !== "error") || (!c.masters.ledger && c.pending_jobs)) refresh(); });
}

async function companyMasters(c, el) {
  el.innerHTML = `<div class="filters" style="padding:0 0 10px;border:0"><div class="seg" id="kind">
      <button data-k="ledger" class="on">Ledgers <span class="c">${c.masters.ledger}</span></button>
      <button data-k="stock_item">Stock items <span class="c">${c.masters.stock_item}</span></button>
      <button data-k="group">Groups <span class="c">${c.masters.group}</span></button>
      <button data-k="unit">Units <span class="c">${c.masters.unit}</span></button></div>
    <input class="in" id="q" placeholder="Search name, group, GSTIN, HSN…" style="max-width:340px"></div><div id="list"></div>`;
  let kind = "ledger";
  const load = async () => {
    const r = await api(`/companies/${c.id}/masters?kind=${kind}&q=${encodeURIComponent($("#q").value)}`);
    $("#list").innerHTML = `<table class="grid"><thead><tr><th>Name</th><th>${kind === "stock_item" ? "HSN" : "Under"}</th><th>${kind === "stock_item" ? "GST" : kind === "ledger" ? "GSTIN" : ""}</th><th>${kind === "stock_item" ? "Unit" : kind === "ledger" ? "Group" : ""}</th></tr></thead><tbody>
      ${r.items.map((m) => `<tr><td>${esc(m.name)} ${m.pending ? '<span class="tag warn">being created in Tally</span>' : ""}</td>
      <td class="muted">${esc(kind === "stock_item" ? m.hsn || "" : m.parent || "")}</td>
      <td class="mono muted">${esc(kind === "stock_item" ? (m.gst_rate ?? "") + (m.gst_rate != null ? "%" : "") : kind === "ledger" ? m.gstin || "" : "")}</td>
      <td class="muted">${esc(kind === "stock_item" ? m.unit || "" : kind === "ledger" ? m.primary_group || "" : "")}</td></tr>`).join("")}</tbody></table>
      <p class="muted">${r.total > r.items.length ? `Showing ${r.items.length} of ${r.total}` : `${r.total} records`}</p>`;
  };
  $$("#kind button").forEach((b) => b.onclick = () => { $$("#kind button").forEach((x) => x.classList.toggle("on", x === b)); kind = b.dataset.k; load(); });
  $("#q").oninput = debounce(load);
  load();
}

async function companyJobs(c, el) {
  const rows = await api(`/companies/${c.id}/jobs`);
  const lbl = { import_voucher: "Post voucher", import_master: "Create master", import_bank: "Post bank entry", export_ledgers: "Read ledgers", export_stock: "Read stock items",
    export_groups: "Read groups", export_units: "Read units", export_purchase_gst: "Read purchases for GSTR-2B" };
  // where each job's "open" goes: the invoice, the bank statement or the GSTR-2B it belongs to
  const link = (j) => j.kind === "import_voucher" ? `#/i/${j.invoice_id}` : j.kind === "import_bank" && j.statement_id ? `#/s/${j.statement_id}`
    : j.kind === "export_purchase_gst" ? `#/g/${j.invoice_id}` : "";
  const help = tallyHelp(c);
  el.innerHTML = (help && rows.some((j) => j.status === "pending") ? `<div class="alert warn" style="margin-bottom:12px">${help}</div>` : "") + (rows.length ? `<table class="grid"><thead><tr><th>When</th><th>Job</th><th>Status</th><th>Result</th></tr></thead><tbody>
    ${rows.map((j) => `<tr><td class="muted">${ago(j.created_at)}</td><td>${lbl[j.kind] || esc(j.kind)} ${j.invoice_id && link(j) ? `<a href="${link(j)}"><u>open</u></a>` : ""}</td>
    <td class="${j.status === "done" ? "good" : j.status === "failed" ? "bad" : "warn"}">${{ done: "Done", failed: "Failed", pending: "Waiting", sent: "With Tally" }[j.status] || esc(j.status)}</td><td class="muted">${esc(j.result || "")}</td></tr>`).join("")}</tbody></table>`
    : `<div class="card empty">Nothing has been sent to Tally yet.</div>`);
  every(3000, () => { if (rows.some((j) => j.status === "pending" || j.status === "sent")) refresh(); });
}

function aiChoiceHtml(cur, opts) {
  return `<div class="field"><label>AI that reads this company's invoices</label><div class="choices" style="margin-top:4px">
    ${opts.map((v) => `<label class="choice ${cur === v ? "on" : ""}">
        <input type="radio" name="ai" value="${v}" ${cur === v ? "checked" : ""} style="margin-right:10px">
        <div style="flex:1"><div><b>${esc(ME.ai_labels[v] || v)}</b></div><div class="sub">${esc(AI_HELP[v] || "")}</div></div></label>`).join("")}</div>
    ${opts.length < 4 ? `<div class="muted small" style="margin-top:6px">The admin decides which AI you can use.</div>` : ""}
    <div style="margin-top:8px"><button type="button" class="btn" id="aiTest">Test the AI</button> <span class="muted small">One tiny request (no invoice, no credit used).</span><div id="aiTestOut" style="margin-top:8px"></div></div></div>`;
}

async function companySettings(c, el) {
  const s = c.settings || {};
  const ledR = await api(`/companies/${c.id}/masters?kind=ledger&groups=${encodeURIComponent("Purchase Accounts|Sales Accounts")}`);
  const led = ledR.items;
  const aiOpts = ME.licence?.ai_options || [];
  const curAI = aiOpts.includes(s.ai) ? s.ai : aiOpts[0];
  const opts = (grp, cur) => `<option value="">— suggest automatically —</option>` + led.filter((l) => l.primary_group === grp).map((l) => `<option ${l.name === cur ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  el.innerHTML = `<form id="f" style="max-width:640px">
    ${aiChoiceHtml(curAI, aiOpts)}
    <div class="field"><label>Company name</label><input class="in" name="name" value="${esc(c.name)}"></div>
    <div class="field"><label>Company name in Tally (must match exactly)</label><input class="in" name="tally_company" value="${esc(c.tally_company || "")}"></div>
    <div class="field"><label>Your GSTIN</label><input class="in mono" name="gstin" value="${esc(c.gstin || "")}" maxlength="15"></div>
    <div class="field"><label>Default purchase ledger</label><select class="in" name="default_purchase_ledger">${opts("Purchase Accounts", s.default_purchase_ledger)}</select></div>
    <div class="field"><label>Default sales ledger</label><select class="in" name="default_sales_ledger">${opts("Sales Accounts", s.default_sales_ledger)}</select></div>
    <label style="display:flex;gap:8px;margin:8px 0"><input type="checkbox" name="send_descriptions" ${s.send_descriptions !== false ? "checked" : ""}> Send the invoice's item description under each stock item</label>
    <label style="display:flex;gap:8px;margin:8px 0 16px"><input type="checkbox" name="round_off" ${s.round_off !== false ? "checked" : ""}> Round the bill to the nearest rupee</label>
    <button class="btn primary">Save</button> <button type="button" class="btn danger" id="del" style="margin-left:8px">Delete company</button></form>`;
  $$("input[name=ai]").forEach((r) => r.onchange = () => $$("input[name=ai]").forEach((x) => x.closest(".choice").classList.toggle("on", x.checked)));
  $("#aiTest").onclick = async () => {
    const ai = ($("input[name=ai]:checked") || {}).value || curAI;
    $("#aiTestOut").innerHTML = '<span class="spin" style="display:inline-block;vertical-align:-2px"></span> Testing…';
    const r = await api("/ai/test", { body: { ai } }).catch((e) => ({ ok: false, error: e.message }));
    $("#aiTestOut").innerHTML = r.ok ? `<div class="alert ok">${esc(ME.ai_labels[ai] || ai)} is working — answered in ${((r.ms || 0) / 1000).toFixed(1)} s.</div>`
      : `<div class="alert bad"><b>${esc(ME.ai_labels[ai] || ai)}:</b> ${esc(r.error)}</div>`;
  };
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    await act(() => api(`/companies/${c.id}`, { method: "PATCH", body: { name: f.name.value, tally_company: f.tally_company.value, gstin: f.gstin.value,
      settings: { default_purchase_ledger: f.default_purchase_ledger.value, default_sales_ledger: f.default_sales_ledger.value, send_descriptions: f.send_descriptions.checked, round_off: f.round_off.checked,
        ai: (f.querySelector("input[name=ai]:checked") || {}).value || curAI } } }), "Saved");
    route();
  };
  $("#del").onclick = async () => { if (confirm(`Delete ${c.name} and all its data in this app? (Nothing in Tally is touched. It still counts towards your company limit.)`)) { await api(`/companies/${c.id}`, { method: "DELETE" }); location.hash = "#/"; } };
}

// ---------------------------------------------------------------------------
// upload wizard
// ---------------------------------------------------------------------------
async function viewUpload(cid) {
  const c = await api(`/companies/${cid}`);
  const st = { type: null, source: null, files: [] };
  const render = () => {
    const step = !st.type ? 1 : !st.source ? 2 : 3;
    const ch = (key, val, title, sub) => `<div class="choice ${st[key] === val ? "on" : ""}" data-k="${key}" data-v="${val}"><div><div><b>${title}</b></div><div class="sub">${sub}</div></div>${st[key] === val ? "✓" : ""}</div>`;
    const done = (n, title, val, key) => `<div class="wstep"><div class="head"><span class="check">✓</span><b>${title}</b><div class="spacer"></div><span class="muted">${val}</span><button class="btn sm" data-reset="${key}">Change</button></div></div>`;
    app().innerHTML = topBar([[c.name, `#/c/${cid}`], ["Upload invoices"]], c) + `<div class="bar"><span class="status">${st.files.length} file(s)</span><div class="spacer"></div>
      <a class="btn" href="#/c/${cid}">Back <kbd>Esc</kbd></a><button class="btn primary" id="go" ${step === 3 && st.files.length ? "" : "disabled"}>Upload &amp; read <kbd>↵</kbd></button></div>
    <div class="page wiz"><div class="eyebrow">Upload invoices</div><h1>${esc(c.name)}</h1>
      ${step > 1 ? done(1, "What are these invoices?", `Booked as ${st.type}`, "type") : `<div class="wstep active"><div class="head"><span class="n">1</span><b>What are these invoices?</b></div><div class="choices">
        ${ch("type", "Purchase", "Purchase", "Bills from your suppliers — booked as Purchase vouchers")}${ch("type", "Sales", "Sales", "Invoices you issued — booked as Sales vouchers")}</div></div>`}
      ${step > 2 ? done(2, "Where do they come from?", st.source === "pdf" ? "PDFs or photos" : "Excel / CSV", "source") : `<div class="wstep ${step === 2 ? "active" : ""}"><div class="head"><span class="n">2</span><b>Where do they come from?</b></div>${step === 2 ? `<div class="choices">
        ${ch("source", "pdf", "PDFs or photos", "Scanned, photographed, Tally-printed or handwritten — split and read for you · PDF, PNG, JPEG")}
        ${ch("source", "excel", "Excel or CSV register", "Any sheet of invoices — its columns are understood automatically · .xlsx or .csv")}</div>` : ""}</div>`}
      <div class="wstep ${step === 3 ? "active" : ""}"><div class="head"><span class="n">3</span><b>The files</b></div>${step === 3 ? `
        <label class="drop" id="drop"><input type="file" id="fi" multiple hidden accept="${st.source === "pdf" ? ".pdf,.png,.jpg,.jpeg,.webp,.bmp,image/*" : ".xlsx,.xlsm,.csv"}">
          <div style="font-size:15px;color:var(--text)">Drop files here or click to choose</div>
          <div>${st.source === "pdf" ? "One PDF can hold many invoices — they're split automatically." : "One row per item line; rows sharing an invoice number become one invoice."}</div></label>
        <div class="files">${st.files.map((f, i) => `<div><span>${esc(f.name)}</span><span class="muted">${(f.size / 1024).toFixed(0)} KB <a href="#" data-rm="${i}">✕</a></span></div>`).join("")}</div>` : ""}</div>
    </div>`;
    wireTop(c);
    $$(".choice").forEach((el) => el.onclick = () => { st[el.dataset.k] = el.dataset.v; render(); });
    $$("[data-reset]").forEach((b) => b.onclick = () => { if (b.dataset.reset === "type") { st.type = null; } st.source = null; st.files = []; render(); });
    $$("[data-rm]").forEach((a) => a.onclick = (e) => { e.preventDefault(); st.files.splice(+a.dataset.rm, 1); render(); });
    const drop = $("#drop");
    if (drop) {
      $("#fi").onchange = (e) => { st.files.push(...e.target.files); render(); };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); st.files.push(...e.dataTransfer.files); render(); };
    }
    $("#go").onclick = upload;
  };
  let busy = false;
  const upload = async () => {
    if (!st.files.length || busy) return;
    busy = true;
    const go = $("#go"), status = $(".bar .status");
    go.disabled = true;
    const say = (t) => { status.textContent = t; go.textContent = "Uploading…"; };
    let batch = null;
    try {
      // Check sheets / render pages first, so a bad file fails before anything is uploaded.
      const prepared = [];
      for (const [n, f] of st.files.entries()) {
        if (st.source === "excel") { say(`Reading ${f.name}…`); prepared.push({ f, text: await Ingest.sheet(f) }); }
        else prepared.push({ f, pages: await Ingest.pages(f, (i, tot) => say(`Preparing ${f.name} — page ${i} of ${tot} (file ${n + 1} of ${st.files.length})`)) });
      }
      batch = await api(`/companies/${cid}/batches`, { body: { voucher_type: st.type, source: st.source,
        files: prepared.map((x) => ({ filename: x.f.name, pages: x.pages?.length || 0 })) } });
      const totalPages = prepared.reduce((a, x) => a + (x.pages?.length || 0), 0);
      let sent = 0;
      for (const [n, x] of prepared.entries()) {
        const fid = batch.files[n].id;
        if (x.text != null) { say(`Uploading ${x.f.name}…`); await api(`/files/${fid}/sheet`, { body: { text: x.text } }); continue; }
        for (const [i, pg] of x.pages.entries()) {
          say(`Uploading page ${++sent} of ${totalPages}…`);
          for (let attempt = 0; ; attempt++) {
            try { await api(`/files/${fid}/pages`, { body: { idx: i, ...pg } }); break; }
            catch (e) { if (attempt >= 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
          }
        }
      }
      await api(`/batches/${batch.id}/start`, { body: {} });
      location.hash = `#/b/${batch.id}`;
    } catch (e) {
      toast(e.message, true);
      if (batch) api(`/batches/${batch.id}`, { method: "DELETE" }).catch(() => {});
      busy = false; render();
    }
  };
  keymap.Escape = () => location.hash = `#/c/${cid}`;
  keymap.enter = () => upload();
  render();
}

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------
async function loadBatchCtx(bid) {
  const b = await api(`/batches/${bid}`);
  const c = b.company;
  CURRENT.company = c;
  return { b, c };
}

// The app reads in the background (it keeps going while you look at other screens); this page just refreshes.
function driveBatch() {}

async function viewBatch(bid) {
  const { b, c } = await loadBatchCtx(bid);
  const working = ["find", "read", "uploading"].includes(b.stage);
  if (working) every(2500, refresh);
  const filesDone = b.files.filter((f) => f.status === "done" || f.status === "failed").length;
  const read = b.invoices.filter((i) => !["pending", "reading"].includes(i.status)).length;
  const stepIdx = { uploading: 0, find: 0, read: 1, review: 2, error: 2 }[b.stage];
  const stepRow = (i, title, doneText, runText, done, total) => {
    const state = stepIdx > i ? "done" : stepIdx === i && working ? "run" : stepIdx === i ? "done" : "wait";
    const pct = total ? Math.round((100 * done) / total) : 5;
    return `<div class="ps ${state === "run" ? "cur" : ""}"><span>${state === "done" ? '<span class="check">✓</span>' : state === "run" ? '<span class="spin"></span>' : `<span class="n">${i + 1}</span>`}</span>
      <span class="t">${title}</span><span class="r">${state === "done" ? doneText : ""}</span></div>
      ${state === "run" ? `<div style="padding:0 16px 12px"><div class="prog"><div style="width:${Math.max(4, pct)}%"></div></div><div class="muted" style="margin-left:32px">${runText} · ${done} of ${total}. It keeps going if you close this tab.</div></div>` : ""}`;
  };
  const failedFiles = b.files.filter((f) => f.status === "failed");
  const reviewable = b.invoices.filter((i) => i.status === "review" || i.status === "failed").length;
  const rechecked = b.invoices.filter((i) => i.rechecked).length;
  app().innerHTML = topBar([[c.name, `#/c/${c.id}`], [b.name]], c) + `<div class="bar">
      <span class="status">${b.stage === "review" ? `${b.invoices.length} invoice(s) read — ${reviewable ? "ready to review" : "all done"}${rechecked ? ` · ${rechecked} double-checked by a second read` : ""}${b.ai_cost_usd ? ` · AI cost ≈ ₹${(b.ai_cost_usd * 88).toFixed(2)}` : ""}` : b.stage === "error" ? "Something went wrong" : "Working…"}</span><div class="spacer"></div>
      <button class="btn" id="refresh">⟳ Refresh <kbd>Alt+R</kbd></button><a class="btn" href="#/c/${c.id}">Back <kbd>Esc</kbd></a>
      <button class="btn danger" id="del" title="Delete batch">🗑</button>
      ${!working && (b.invoices.some((i) => i.status === "error") || failedFiles.length) ? `<button class="btn" id="retry">↻ Retry failed</button>` : ""}
      ${b.stage === "review" && reviewable ? `<a class="btn primary" href="#/b/${bid}/review/party">Bulk review <kbd>R</kbd></a>` : ""}</div>
    <div class="pipe">${b.source === "excel"
      ? stepRow(0, "Read the sheet", `${b.invoices.length} invoice(s)`, "Reading the sheet", filesDone, b.files.length) + stepRow(1, "Match to your Tally masters", `${read} matched`, "Matching", read, b.invoices.length)
      : stepRow(0, "Find each invoice", `${b.files.length} file(s) · ${b.pages} page(s) · ${b.invoices.length} invoice(s)`, "Finding where each invoice starts", filesDone, b.files.length) +
        stepRow(1, "Read each invoice", `${read} read`, "Reading your invoices", read, b.invoices.length)}</div>
    ${b.stage === "error" ? `<div class="page"><div class="alert bad">${esc(b.error)}</div></div>` : ""}
    ${b.files.filter((f) => f.note && (f.status === "ready" || f.status === "working")).map((f) => `<div style="padding:8px 16px 0"><div class="alert warn">
      <b>${esc(f.filename)}</b>: ${esc(f.note)} <span class="muted">(try ${f.attempts || 1} of 4 — it tries again by itself in a moment)</span></div></div>`).join("")}
    ${failedFiles.map((f) => `<div style="padding:8px 16px 0"><div class="alert bad">${esc(f.filename)}: ${esc(f.error || "failed")}</div></div>`).join("")}
    ${b.invoices.length ? `<div style="padding:14px 16px 4px" class="eyebrow">${b.invoices.length} invoice${b.invoices.length > 1 ? "s" : ""}</div>
    <table class="grid"><thead><tr><th>Invoice</th><th>Date</th><th>Party</th><th class="num">Lines</th><th class="num">Total</th><th>State</th></tr></thead><tbody>
    ${b.invoices.map((i) => `<tr class="click" data-href="#/i/${i.id}"><td><b>${esc(i.number || "—")}</b>${i.warnings.length ? ` <span class="warn" title="${esc(i.warnings.join("\n"))}">⚠</span>` : ""}</td>
      <td class="mono">${fmtDate(i.date)}</td><td>${esc(i.party_name || "—")}${i.party_ledger ? ` <span class="faint">→</span> <span class="muted">${esc(i.party_ledger)}</span>` : ""}</td>
      <td class="num">${i.lines || ""}</td><td class="num">${["pending", "reading"].includes(i.status) ? "" : money(i.total)}</td>
      <td class="${i.status === "synced" ? "good" : i.status === "failed" || i.status === "error" ? "bad" : ""}">${["pending", "reading"].includes(i.status) ? '<span class="spin" style="display:inline-block;vertical-align:-2px"></span> ' : ""}${esc(i.state)}${i.error ? `<div class="muted" style="font-size:12px">${esc(i.error)}</div>` : ""}</td></tr>`).join("")}
    </tbody></table>` : ""}`;
  wireTop(c);
  $$("tr[data-href]").forEach((tr) => tr.onclick = () => location.hash = tr.dataset.href);
  $("#refresh").onclick = route; keymap["Alt+r"] = route;
  keymap.Escape = () => location.hash = `#/c/${c.id}`;
  keymap.r = () => b.stage === "review" && (location.hash = `#/b/${bid}/review/party`);
  $("#del").onclick = async () => { if (confirm("Delete this batch and its invoices? (Vouchers already in Tally stay there.)")) { DRIVERS.get(bid) && (DRIVERS.get(bid).stop = true); await api(`/batches/${bid}`, { method: "DELETE" }); location.hash = `#/c/${c.id}`; } };
  $("#retry")?.addEventListener("click", async () => { await act(() => api(`/batches/${bid}/retry`, { body: {} }), "Reading again…"); route(); });
  if (working) every(2500, refresh);
}

// ---------------------------------------------------------------------------
// review (Party → Stock → Ledger → Tax → Sync)
// ---------------------------------------------------------------------------
const STEPS = [["party", "Party"], ["stock", "Stock"], ["ledger", "Ledger"], ["tax", "Tax + rounding off"], ["sync", "Sync"]];

async function viewReview(bid, step) {
  const [{ b, c }, data] = await Promise.all([loadBatchCtx(bid), api(`/batches/${bid}/review/${step}`)]);
  const inReview = b.invoices.filter((i) => i.status === "review" || i.status === "failed");
  const doneStep = (k) => k === "sync" ? b.invoices.length > 0 && b.invoices.every((i) => i.status === "synced") : inReview.every((i) => i.steps[k]);
  const idx = STEPS.findIndex((s) => s[0] === step);
  const next = STEPS[idx + 1], prev = STEPS[idx - 1];
  const locked = (k) => k === "sync" && !inReview.every((i) => i.steps.party && i.steps.stock && i.steps.ledger && i.steps.tax) && inReview.length > 0;
  const head = `${topBar([[c.name, `#/c/${c.id}`], [b.name, `#/b/${bid}`], [`${STEPS[idx][1]} · ${idx + 1} of 5`]], c)}
    <div class="bar"><span class="status" id="stat"></span><div class="spacer"></div>
      <a class="btn" href="${prev ? `#/b/${bid}/review/${prev[0]}` : `#/b/${bid}`}">Back <kbd>Esc</kbd></a>
      <span id="extraBtns" style="display:contents"></span>
      ${next ? `<a class="btn primary" href="#/b/${bid}/review/${next[0]}">Continue to ${next[1].split(" ")[0]} <kbd>N</kbd></a>` : ""}</div>
    <div class="bar"><b style="margin-right:6px">Resolve</b><nav class="steps">${STEPS.map(([k, l], i) => `<a href="#/b/${bid}/review/${k}" class="${k === step ? "on" : ""}">${i + 1} ${l} ${doneStep(k) ? '<span class="ok">✓</span>' : locked(k) ? "🔒" : ""}</a>`).join("")}</nav>
      <span class="vt">${b.voucher_type.toUpperCase()}</span><div class="spacer"></div><a class="btn sm" href="#/b/${bid}">Invoices</a></div>`;
  keymap.Escape = () => location.hash = prev ? `#/b/${bid}/review/${prev[0]}` : `#/b/${bid}`;
  if (next) keymap.n = () => location.hash = `#/b/${bid}/review/${next[0]}`;
  const ctx = { b, c, data, head, bid, invById: Object.fromEntries(b.invoices.map((i) => [i.id, i])) };
  if (step === "party") return reviewParty(ctx);
  if (step === "stock") return reviewLines(ctx, "stock");
  if (step === "ledger") return reviewLines(ctx, "ledger");
  if (step === "tax") return reviewTax(ctx);
  if (step === "sync") return reviewSync(ctx);
}

// generic two-pane layout with selection
function twoPane(ctx, { filters, rowsHtml, panel }) {
  app().innerHTML = ctx.head + `<div class="split"><div class="left">${filters}<div id="rows">${rowsHtml}</div></div><div class="right" id="panel">${panel}</div></div>`;
  wireTop(ctx.c);
}

function pageViewer(pageIds) {
  if (!pageIds?.length) return `<div class="muted">No image for this invoice (it came from a sheet).</div>`;
  return `<div style="display:flex;gap:6px;margin-bottom:6px"><button class="btn sm" data-zoom="-">−</button><button class="btn sm" data-zoom="+">+</button><span class="muted" style="font-size:12px;align-self:center">Scroll to pan</span></div>
    <div class="viewer">${pageIds.map((p) => `<img data-pid="${p}" alt="Invoice page">`).join("")}</div>`;
}
function wireViewer(root) {
  loadPageImages(root);
  let z = 1;
  $$("[data-zoom]", root).forEach((b) => b.onclick = () => { z = Math.max(0.6, Math.min(3, z + (b.dataset.zoom === "+" ? 0.25 : -0.25))); $$(".viewer img", root).forEach((i) => i.style.width = z * 100 + "%"); });
}

// picker: suggestions + full search + create
function picker({ title, count, placeholder, suggest, search, createLabel, selected, onPick, onCreate, render }) {
  const id = "p" + Math.random().toString(36).slice(2, 8);
  const html = `<div class="box picker" id="${id}"><div class="bh"><span class="eyebrow">${title}</span><span class="muted" style="font-size:12px">${count ?? ""}</span></div>
    <div class="search">⌕<input placeholder="${placeholder}" autocomplete="off"></div><div class="list"></div></div>`;
  const wire = () => {
    const root = $("#" + id);
    const input = $("input", root), list = $(".list", root);
    let cur = selected, items = [];
    const draw = async () => {
      const q = input.value.trim();
      const [sug, all] = await Promise.all([suggest ? suggest(q) : [], search(q)]);
      const seen = new Set(sug.map((s) => s.name));
      items = [...sug.map((s) => ({ ...s, _s: true })), ...all.filter((a) => !seen.has(a.name))];
      list.innerHTML = (sug.length ? `<div class="sect">✦ Suggested matches</div>` : "") +
        items.map((it, i) => `${!it._s && (i === 0 || items[i - 1]._s) && sug.length ? `<div class="sect">All</div>` : ""}<div class="opt ${it.name === cur ? "on" : ""}" data-i="${i}">${render(it)}</div>`).join("") +
        (onCreate && createLabel && createLabel(q) ? `<div class="opt create" data-create>＋ ${createLabel(q)}</div>` : "") +
        (!items.length && !onCreate ? `<div class="empty">Nothing found</div>` : "");
      $$(".opt[data-i]", list).forEach((o) => o.onclick = () => { cur = items[+o.dataset.i].name; $$(".opt", list).forEach((x) => x.classList.toggle("on", x === o)); onPick(items[+o.dataset.i]); });
      $(".opt[data-create]", list)?.addEventListener("click", () => onCreate(input.value.trim()));
    };
    input.oninput = debounce(draw, 150);
    draw();
    return { focus: () => input.focus(), setQuery: (q) => { input.value = q; draw(); } };
  };
  return { html, wire };
}

function willSet(text, btn, extra = "") {
  return `<div class="footer-act" style="flex-direction:column;align-items:stretch">${text ? `<div class="will"><span><span class="eyebrow">Will set</span>&nbsp; ${text}</span></div>` : ""}
    <div style="display:flex;gap:8px;align-items:center">${btn}${extra}</div></div>`;
}

// ---- Party -----------------------------------------------------------------
function reviewParty(ctx) {
  const { data, c, bid } = ctx;
  const items = data.items;
  let filter = items.some((i) => !i.ledger) ? "need" : "done";
  let sel = 0;
  const vis = () => items.filter((i) => filter === "need" ? !i.ledger : !!i.ledger);
  const nNeed = items.filter((i) => !i.ledger).length;
  const draw = () => {
    const v = vis();
    sel = Math.min(sel, Math.max(0, v.length - 1));
    const rows = v.length ? `<table class="grid"><thead><tr><th>Party on invoice</th><th>Tally ledger</th><th class="num">Invoices</th><th class="num">Amount</th></tr></thead><tbody>
      ${v.map((g, i) => `<tr class="click ${i === sel ? "sel" : ""}" data-i="${i}"><td><b>${esc(g.name || "(no name)")}</b><div class="mono muted" style="font-size:12px">${esc(g.gstin || "no GSTIN")} ${g.gstin_valid === false ? '<span class="bad">· invalid</span>' : ""}</div></td>
      <td>${g.ledger ? `<span class="state-resolved">${esc(g.ledger)}</span><div class="muted" style="font-size:12px">${esc(g.method || "")}</div>` : g.proposed ? `<span class="state-proposed">${esc(g.proposed)}</span> <span class="muted">proposed</span>` : `<span class="state-suspense">Suspense</span> <span class="muted">needs a ledger</span>`}</td>
      <td class="num">${g.invoice_ids.length}</td><td class="num">${money(g.total)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${filter === "need" ? "Every party is matched. ✓" : "Nothing resolved yet."}</div>`;
    const g = v[sel];
    let panel = `<div class="empty">Select a party</div>`, pk = null, pick = null;
    if (g) {
      pick = g.ledger || g.proposed || null;
      pk = picker({
        title: `Select ledger · ${data.group}`, placeholder: "Search ledger, group, GSTIN…", selected: pick,
        suggest: async (q) => q ? [] : api(`/companies/${c.id}/suggest/party?vtype=${data.voucher_type}&name=${encodeURIComponent(g.name || "")}&gstin=${encodeURIComponent(g.gstin || "")}`),
        search: async (q) => (await api(`/companies/${c.id}/masters?kind=ledger&q=${encodeURIComponent(q)}${q ? "" : "&groups=" + encodeURIComponent(data.group)}`)).items,
        render: (it) => `<div><div class="nm">${esc(it.name)}</div><div class="sub">${esc(it.parent || "")} ${it.gstin ? "· " + esc(it.gstin) : ""}</div></div><div class="tag">${(it.tags || []).join(" · ")}${it.score != null && it._s ? ` ${it.score}%` : ""}</div>`,
        onPick: (it) => { pick = it.name; $("#willtxt").innerHTML = `Party → <b>${esc(pick)}</b>`; $("#apply").disabled = false; },
        createLabel: (q) => `Create ledger “${esc(q || g.name || "")}”`,
        onCreate: (q) => createLedgerModal(q || g.name, g, data.group),
      });
      panel = `<div class="box"><div class="bh"><span class="eyebrow">Extracted party</span><a class="btn sm" href="#/i/${g.invoice_ids[0]}">View invoice ↗</a></div><div class="bb">
        <div class="big">${esc(g.name || "(no name)")}</div>
        <div class="kv"><div><span>GSTIN</span><span class="mono">${esc(g.gstin || "—")} ${g.gstin_valid === true ? '<span class="good">✓</span>' : g.gstin_valid === false ? '<span class="bad">checksum fails</span>' : ""}</span></div>
          <div><span>State</span><span>${esc(g.state || "—")}</span></div><div><span>Found on</span><span>${g.invoice_ids.length} invoice(s)</span></div></div>
        ${g.address ? `<div class="muted" style="margin-top:8px;font-size:13px">${esc(g.address)}</div>` : ""}</div></div>
        ${pk.html}${willSet(`<span id="willtxt">${pick ? `Party → <b>${esc(pick)}</b>` : "Pick a ledger"}</span>`, `<button class="btn primary" id="apply" ${pick ? "" : "disabled"}>${g.ledger ? "Change party" : "Set party"} <kbd>↵</kbd></button>`)}`;
    }
    twoPane(ctx, {
      filters: `<div class="filters"><b>Match parties to ledgers</b><span class="muted">${items.reduce((a, g) => a + g.invoice_ids.length, 0)} invoice(s) · ${items.length} part${items.length === 1 ? "y" : "ies"}</span>
        <div class="seg"><button data-f="need" class="${filter === "need" ? "on" : ""}">Needs review <span class="c">${nNeed}</span></button><button data-f="done" class="${filter === "done" ? "on" : ""}">Resolved <span class="c">${items.length - nNeed}</span></button></div>
        <div class="spacer"></div><span class="muted">Searching <b>${esc(data.group)}</b></span></div>`, rowsHtml: rows, panel,
    });
    $("#stat").textContent = `${items.length - nNeed} matched · ${nNeed} need you`;
    $$(".seg button").forEach((bt) => bt.onclick = () => { filter = bt.dataset.f; sel = 0; draw(); });
    $$("#rows tr[data-i]").forEach((tr) => tr.onclick = () => { sel = +tr.dataset.i; draw(); });
    if (pk) {
      pk.wire();
      const apply = async () => { if (!pick) return; await act(() => api(`/batches/${bid}/party`, { body: { invoice_ids: g.invoice_ids, ledger: pick } }), `Party set to ${pick}`); route(); };
      $("#apply").onclick = apply; keymap.enter = apply;
    }
  };
  draw();
}

function createLedgerModal(name, g, group) {
  modal(`<h2>Create ledger in Tally</h2>
    <div class="field"><label>Ledger name</label><input class="in" name="name" value="${esc(name || "")}" required></div>
    <div class="field"><label>Under group</label><input class="in" name="parent" value="${esc(group)}"></div>
    <div class="field"><label>GSTIN</label><input class="in mono" name="gstin" value="${esc(g?.gstin || "")}" maxlength="15"></div>
    <div class="field"><label>State</label><input class="in" name="state" value="${esc(g?.state || "")}"></div>
    <div class="field"><label>Address</label><textarea class="in" name="address" rows="2">${esc(g?.address || "")}</textarea></div>
    <p class="muted" style="font-size:12.5px">It's created in Tally first, then the voucher is posted.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create &amp; use</button></div>`,
    async (d) => { await api(`/batches/${location.hash.split("/")[2]}/party`, { body: { invoice_ids: g.invoice_ids, create: d } }); toast(`Ledger ${d.name} will be created`); route(); });
}

// ---- Stock & Ledger --------------------------------------------------------
function reviewLines(ctx, mode) {
  const { data, c, bid } = ctx;
  const items = data.items;
  const stateOf = (g) => mode === "stock" ? g.stock_state : g.ledger_state;
  const counts = { suspense: 0, proposed: 0, resolved: 0 };
  items.forEach((g) => counts[stateOf(g)]++);
  let filter = counts.suspense ? "suspense" : counts.proposed ? "proposed" : "resolved";
  let sel = 0, q = "";
  const vis = () => items.filter((g) => stateOf(g) === filter && (!q || (g.description + " " + (g.hsn || "") + " " + (g.stock_item || "")).toLowerCase().includes(q.toLowerCase())));
  const draw = () => {
    const v = vis();
    sel = Math.min(sel, Math.max(0, v.length - 1));
    const cell = (val, st, need) => st === "resolved" ? `<span>${esc(val)}</span>` : st === "proposed" ? `<span class="state-proposed">${esc(val)}</span> <span class="muted">proposed</span>` : `<span class="state-suspense">Suspense</span> <span class="muted">${need}</span>`;
    const rows = v.length ? `<table class="grid"><thead><tr><th>Extracted line</th>${mode === "stock" ? "<th>Stock item</th>" : "<th>Item</th>"}<th>Ledger</th><th class="num">Amount</th></tr></thead><tbody>
      ${v.map((g, i) => `<tr class="click ${i === sel ? "sel" : ""}" data-i="${i}"><td><b>${esc(g.description)}</b><div class="muted mono" style="font-size:11.5px">${g.hsn ? "HSN " + esc(g.hsn) : ""}${g.gst_rate != null ? " · " + g.gst_rate + "%" : ""}${g.line_ids.length > 1 ? ` · ${g.line_ids.length} lines` : ""}</div></td>
        <td>${g.kind === "ledger" ? '<span class="muted">— charge / service —</span>' : mode === "stock" ? cell(g.stock_item, g.stock_state, "needs a stock item") : esc(g.stock_item || "")}</td>
        <td>${cell(g.ledger, g.ledger_state, "needs a ledger")}</td><td class="num">${money(g.amount)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${!items.length ? "No invoices in this batch are waiting at this step." : filter === "resolved" ? "Nothing resolved yet." : "Nothing here. ✓"}</div>`;
    const g = v[sel];
    let panel = items.length ? `<div class="empty">Select a line</div>` : `<div class="empty"><a class="btn" href="#/b/${bid}/review/sync">Go to Sync</a></div>`, pks = [];
    let pickStock = null, pickLedger = null;
    if (g) {
      pickStock = g.stock_item; pickLedger = g.ledger;
      const invId = g.invoice_ids[0];
      const extracted = `<div class="box"><div class="bh"><div class="seg"><button class="on" data-tab="act">Action</button><button data-tab="view">View invoice</button></div><a class="btn sm" href="#/i/${invId}">Open invoice ↗</a></div>
        <div class="bb" id="tabAct"><div class="eyebrow">Extracted</div><div class="big" style="margin-top:4px">${esc(g.description)}</div>
          <div class="kv"><div><span>Amount</span><span class="mono">${money(g.amount)}</span></div><div><span>HSN/SAC</span><span class="mono">${esc(g.hsn || "—")}</span></div>
          <div><span>GST</span><span class="mono">${g.gst_rate != null ? g.gst_rate + "%" : "—"}</span></div><div><span>Found on</span><span>${g.line_ids.length} line · ${g.invoice_ids.length} invoice</span></div></div>
          ${g.lines.length ? `<div class="muted mono" style="font-size:12px;margin-top:8px">${g.lines.slice(0, 4).map((l) => `#${esc(l.invoice)}: ${l.qty ?? "—"} ${esc(l.unit || "")} × ${l.rate ?? "—"}${l.discount_pct ? ` − ${l.discount_pct}%` : ""} = ${money(l.amount)}`).join("<br>")}</div>` : ""}
          ${mode === "stock" && g.kind === "item" ? `<div class="will" style="margin-top:10px"><span>Not a stock item? A service or a charge goes on a ledger.</span><button class="btn sm" id="moveLedger">Move to ledger <kbd>T</kbd></button></div>` : ""}</div>
        <div class="bb hidden" id="tabView">${pageViewer(ctx.invById[invId]?.page_ids)}</div></div>`;
      const stockPk = mode === "stock" && g.kind === "item" ? picker({
        title: "Select stock item", count: `${c.masters.stock_item} stock items`, placeholder: "Search stock item, HSN…", selected: pickStock,
        suggest: async (qq) => api(`/companies/${c.id}/suggest/stock?desc=${encodeURIComponent(g.description)}&hsn=${encodeURIComponent(g.hsn || "")}&gst_rate=${g.gst_rate ?? ""}${qq ? "&q=" + encodeURIComponent(qq) : ""}`),
        search: async (qq) => (await api(`/companies/${c.id}/masters?kind=stock_item&q=${encodeURIComponent(qq)}`)).items,
        render: (it) => `<div><div class="nm">${esc(it.name)}</div><div class="sub">${it._s && it.similarity != null ? it.similarity + "% similar name · " : ""}${it.hsn ? "HSN " + esc(it.hsn) : ""}${it.gst_rate != null ? " · GST " + it.gst_rate + "%" : ""}${it.unit ? " · " + esc(it.unit) : ""}</div></div><div class="tag">${(it.tags || []).join(" · ")}</div>`,
        onPick: (it) => { pickStock = it.name; updWill(); },
        createLabel: (qq) => `Create stock item “${esc(qq || g.description)}”`,
        onCreate: (qq) => createStockModal(qq || g.description, g, bid),
      }) : null;
      const ledgerGroups = g.kind === "ledger" ? "" : data.account_group;
      const ledgerPk = picker({
        title: "Select ledger", count: ledgerGroups ? `under ${ledgerGroups}` : "", placeholder: "Search ledger, group…", selected: pickLedger,
        suggest: null,
        search: async (qq) => (await api(`/companies/${c.id}/masters?kind=ledger&q=${encodeURIComponent(qq)}${!qq && ledgerGroups ? "&groups=" + encodeURIComponent(ledgerGroups) : ""}`)).items,
        render: (it) => `<div><div class="nm">${esc(it.name)}</div><div class="sub">${esc(it.parent || "")}</div></div>`,
        onPick: (it) => { pickLedger = it.name; updWill(); },
        createLabel: (qq) => qq ? `Create ledger “${esc(qq)}”` : null,
        onCreate: (qq) => qq && api(`/batches/${bid}/ledger`, { body: { line_ids: g.line_ids, create: { name: qq, parent: ledgerGroups || "Indirect Expenses" } } }).then(() => { toast("Ledger will be created"); route(); }),
      });
      pks = [stockPk, ledgerPk].filter(Boolean);
      const showStock = mode === "stock" && g.kind === "item";
      panel = extracted + `<div class="pickers ${showStock && mode === "stock" ? "" : "one"}">${showStock ? stockPk.html : ""}${mode === "ledger" || g.kind === "ledger" ? ledgerPk.html : showStock ? ledgerPk.html : ""}</div>` +
        willSet(`<span id="willtxt"></span>`, `<button class="btn primary" id="apply">Apply <kbd>↵</kbd></button>`,
          mode === "ledger" && g.kind === "item" ? `<label class="muted" style="font-size:12.5px;display:flex;gap:6px"><input type="checkbox" id="remParty"> Use for everything from this party</label>`
          : g.kind === "ledger" ? `<label class="muted" style="font-size:12.5px;display:flex;gap:6px" title="For suppliers of stationery, packing material, printing, services: their next bills skip the Stock step and post as a voucher"><input type="checkbox" id="remVoucher"> Always post this party's bills to this ledger, as a voucher</label>` : "");
    }
    twoPane(ctx, {
      filters: `<div class="filters"><input class="in" id="q" placeholder="Description, HSN, item…" style="max-width:220px" value="${esc(q)}">
        <div class="seg">${[["suspense", "Suspense"], ["proposed", "Needs review"], ["resolved", "Resolved"]].map(([k, l]) => `<button data-f="${k}" class="${filter === k ? "on" : ""}">${l} <span class="c">${counts[k]}</span></button>`).join("")}</div>
        ${mode === "stock" && counts.suspense + counts.proposed ? `<button class="btn sm" id="bulkCreate" title="Create a stock item for each line in Suspense, named as on the invoice">Create stock items ${counts.suspense}</button>` : ""}</div>`,
      rowsHtml: rows, panel,
    });
    const total = items.reduce((a, g) => a + g.line_ids.length, 0);
    $("#stat").textContent = `${items.length} item(s) · ${counts.suspense} on Suspense · ${counts.proposed} need review · ${total} line(s)`;
    $$(".seg button[data-f]").forEach((bt) => bt.onclick = () => { filter = bt.dataset.f; sel = 0; draw(); });
    $("#q").oninput = debounce((e) => { q = e.target.value; draw(); $("#q").focus(); const v = $("#q"); v.setSelectionRange(v.value.length, v.value.length); }, 250);
    $$("#rows tr[data-i]").forEach((tr) => tr.onclick = () => { sel = +tr.dataset.i; draw(); });
    $("#bulkCreate")?.addEventListener("click", async () => {
      const targets = items.filter((x) => x.kind === "item" && x.stock_state === "suspense");
      if (!targets.length || !confirm(`Create ${targets.length} new stock item(s) in Tally, named exactly as on the invoice?`)) return;
      for (const t of targets) await api(`/batches/${bid}/stock`, { body: { line_ids: t.line_ids, create: { name: t.description, unit: t.unit, hsn: t.hsn, gst_rate: t.gst_rate } } });
      toast(`${targets.length} stock item(s) queued for creation`); route();
    });
    if (!g) return;
    $$("[data-tab]").forEach((bt) => bt.onclick = () => { $$("[data-tab]").forEach((x) => x.classList.toggle("on", x === bt)); $("#tabAct").classList.toggle("hidden", bt.dataset.tab !== "act"); $("#tabView").classList.toggle("hidden", bt.dataset.tab !== "view"); });
    wireViewer($("#panel"));
    pks.forEach((p) => { if ($(`#${p.html.match(/id="(p\w+)"/)[1]}`)) p.wire(); });
    const updWill = () => {
      const parts = [];
      if (mode === "stock" && g.kind === "item" && pickStock) parts.push(`Stock item → <b>${esc(pickStock)}</b>`);
      if (pickLedger && (mode === "ledger" || g.ledger_state !== "resolved" || pickLedger !== g.ledger)) parts.push(`Ledger → <b>${esc(pickLedger)}</b>`);
      $("#willtxt").innerHTML = parts.join(" &nbsp;·&nbsp; ") || "Pick from the list";
    };
    updWill();
    const apply = async () => {
      await act(async () => {
        if (mode === "stock" && g.kind === "item" && pickStock) await api(`/batches/${bid}/stock`, { body: { line_ids: g.line_ids, stock_item: pickStock } });
        if (pickLedger && (mode === "ledger" || pickLedger !== g.ledger || g.ledger_state !== "resolved"))
          await api(`/batches/${bid}/ledger`, { body: { line_ids: g.line_ids, ledger: pickLedger, remember_for_party: $("#remParty")?.checked, remember_party_voucher: $("#remVoucher")?.checked } });
      }, "Saved");
      route();
    };
    $("#apply").onclick = apply; keymap.enter = apply;
    const mv = async () => { await act(() => api(`/batches/${bid}/stock`, { body: { line_ids: g.line_ids, move_to_ledger: true } }), "Moved to ledger"); route(); };
    $("#moveLedger")?.addEventListener("click", mv);
    if (mode === "stock") keymap.t = mv;
  };
  draw();
}

function createStockModal(name, g, bid) {
  modal(`<h2>Create stock item in Tally</h2>
    <div class="field"><label>Name</label><input class="in" name="name" value="${esc(name)}" required></div>
    <div class="row"><div class="field"><label>Unit</label><input class="in" name="unit" value="${esc(g.unit || "Nos")}"></div>
    <div class="field"><label>HSN</label><input class="in mono" name="hsn" value="${esc(g.hsn || "")}"></div>
    <div class="field"><label>GST %</label><input class="in mono" name="gst_rate" value="${g.gst_rate ?? ""}"></div></div>
    <div class="field"><label>Stock group (optional)</label><input class="in" name="parent"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create &amp; use</button></div>`,
    async (d) => { d.gst_rate = d.gst_rate === "" ? null : Number(d.gst_rate); await api(`/batches/${bid}/stock`, { body: { line_ids: g.line_ids, create: d } }); toast(`Stock item ${d.name} will be created`); route(); });
}

// ---- Tax -------------------------------------------------------------------
function reviewTax(ctx) {
  const { data, c, bid } = ctx;
  const calc = async () => { await act(() => api(`/batches/${bid}/calculate-tax`, { body: {} }), "Tax calculated"); route(); };
  keymap.c = calc;
  if (!data.items.length) {
    twoPane(ctx, {
      filters: `<div class="filters"><button class="btn primary" id="calc">Calculate tax <kbd>C</kbd></button><span class="muted">Works out CGST, SGST, IGST and the round-off from the mapped lines, the way Tally does.</span></div>`,
      rowsHtml: "", panel: `<div><h2>Tax lines are not calculated yet.</h2><p class="muted">GST heads, round-off and the rest are derived from the mapped stock and ledger lines, then each head is posted to its ledger here.</p><button class="btn primary" id="calc2">Calculate tax <kbd>C</kbd></button></div>`,
    });
    $("#stat").textContent = "Tax not calculated yet";
    $("#calc").onclick = calc; $("#calc2").onclick = calc;
    return;
  }
  let sel = 0;
  const draw = () => {
    const items = data.items;
    const t = items[sel];
    let pick = t?.ledger;
    const isRound = t?.head === "ROUND";
    const pk = t && picker({
      title: "Select tax ledger", count: isRound ? "" : "Duties & Taxes", placeholder: "Search ledger, group…", selected: pick,
      suggest: null,
      search: async (q) => (await api(`/companies/${c.id}/masters?kind=ledger&q=${encodeURIComponent(q || (isRound ? "round" : t.head === "SGST" ? "GST" : t.head))}${!q && !isRound ? "&groups=" + encodeURIComponent("Duties & Taxes") : ""}`)).items,
      render: (it) => `<div><div class="nm">${esc(it.name)}</div><div class="sub">${esc(it.parent || "")}</div></div>${it.name === t.ledger ? `<div class="tag">${esc(t.method || "")}</div>` : ""}`,
      onPick: (it) => { pick = it.name; $("#apply").disabled = pick === t.ledger; },
    });
    twoPane(ctx, {
      filters: `<div class="filters"><button class="btn" id="calc">Recalculate <kbd>C</kbd></button><span class="muted">Calculated ${data.invoices - data.not_calculated} voucher(s)${data.not_calculated ? ` · <span class="warn">${data.not_calculated} not calculated</span>` : ""}</span></div>`,
      rowsHtml: `<table class="grid"><thead><tr><th>GST head</th><th class="num">Rate</th><th class="num">Amount</th><th class="num">Invoices</th><th>Ledger</th></tr></thead><tbody>
        ${items.map((x, i) => `<tr class="click ${i === sel ? "sel" : ""}" data-i="${i}"><td><b>${esc(x.label)}</b> <span class="muted">${esc(x.note || "")}</span></td><td class="num">${x.rate != null ? x.rate + "%" : ""}</td>
        <td class="num">${money(x.amount)}</td><td class="num">${x.invoice_ids.length}</td><td>${x.ledger ? `<span class="state-resolved">${esc(x.ledger)}</span>` : '<span class="state-suspense">needs a ledger</span>'}</td></tr>`).join("")}</tbody></table>`,
      panel: t ? `<div class="box"><div class="bb"><div class="eyebrow">Tax head</div><div class="big">${esc(t.label)}</div><div class="muted">${esc(t.note || "")} · ${money(t.amount)} · ${t.invoice_ids.length} invoice(s)</div></div></div>
        ${pk.html}${willSet("", `<button class="btn primary" id="apply" disabled>Resolve <kbd>↵</kbd></button>`, t.ledger ? `<span class="good" style="font-size:12.5px">Mapped to ${esc(t.ledger)}</span>` : "")}` : "",
    });
    $("#stat").textContent = `${items.length} GST head(s) · ${items.filter((x) => !x.ledger).length} without a ledger`;
    $("#calc").onclick = calc;
    $$("#rows tr[data-i]").forEach((tr) => tr.onclick = () => { sel = +tr.dataset.i; draw(); });
    if (pk) {
      pk.wire();
      const apply = async () => { if (!pick || pick === t.ledger) return; await act(() => api(`/batches/${bid}/tax-ledger`, { body: { head: t.head, rate: t.rate, ledger: pick } }), "Saved"); route(); };
      $("#apply").onclick = apply; keymap.enter = apply;
    }
  };
  draw();
}

// ---- Sync ------------------------------------------------------------------
function reviewSync(ctx) {
  const { data, c, bid } = ctx;
  const items = data.items;
  const n = { review: 0, ready: 0, failed: 0, synced: 0, queued: 0 };
  items.forEach((i) => { if (i.status === "synced") n.synced++; else if (i.status === "failed") n.failed++; else if (i.status === "queued") n.queued++; else if (i.steps.ready) n.ready++; else n.review++; });
  let filter = "all", q = "";
  const checked = new Set();
  const draw = () => {
    const v = items.filter((i) => (filter === "all" || (filter === "ready" ? i.status === "review" && i.steps.ready : filter === "review" ? i.status === "review" && !i.steps.ready : i.status === filter))
      && (!q || `${i.number} ${i.party_ledger || i.party_name} ${i.total}`.toLowerCase().includes(q.toLowerCase())));
    app().innerHTML = ctx.head + `<div class="page wide">
      <div class="stats">${[["review", "In review", n.review, "nothing pending", "resolve every step first"], ["ready", "Ready to sync", n.ready, "push them to Tally"], ["failed", "Failed", n.failed, "no rejections"], ["synced", "Synced", n.synced, "already in Tally"], ["all", "Invoices in batch", items.length, "everything is in Tally"]]
        .map(([k, l, val, sub]) => `<div class="click ${filter === k ? "on" : ""}" data-f="${k}" style="cursor:pointer"><div class="eyebrow">${l}</div><div class="v">${val}</div><div class="muted" style="font-size:12px">${k === "review" && val ? "resolve every step first" : k === "all" && n.synced !== items.length ? `${n.queued ? n.queued + " sending… " : ""}` : sub}</div></div>`).join("")}</div>
      <div class="filters" style="padding:12px 0"><input class="in" id="q" placeholder="Number, party, amount…" style="max-width:260px" value="${esc(q)}"><div class="spacer"></div>
        <button class="btn" id="markSynced" title="Already entered in Tally by hand">Mark as synced <kbd>Y</kbd></button>
        <button class="btn" id="backReview">Send back to review <kbd>R</kbd></button></div>
      <table class="grid"><thead><tr><th style="width:30px"><input type="checkbox" id="all"></th><th>Invoice</th><th>Party</th><th>Type</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
      ${v.map((i) => `<tr><td><input type="checkbox" data-id="${i.id}" ${checked.has(i.id) ? "checked" : ""}></td><td><a href="#/i/${i.id}"><b>${esc(i.number || "—")}</b></a> <span class="muted mono">${fmtDate(i.date)}</span></td>
        <td>${esc(i.party_ledger || i.party_name || "")}</td><td>${esc(ctx.b.voucher_type)} <span class="muted" title="${i.as_voucher ? "Every line goes to a ledger, so it is posted in voucher mode: party Cr with the bill reference, each line Dr to its ledger, GST and round off" : "Posted as an item invoice with stock items"}">· ${i.as_voucher ? "voucher" : "item invoice"}</span></td><td class="num">${money(i.total)}</td>
        <td class="${i.status === "synced" ? "good" : i.status === "failed" ? "bad" : i.status === "queued" ? "warn" : ""}">${i.status === "synced" ? `In Tally · bill ${esc(i.number)}` : i.status === "queued" ? "Sending to Tally…" : i.status === "failed" ? "Failed" : i.steps.ready ? "Ready to sync" : `<span class="warn">Needs fixing:</span> ${esc((i.steps.blockers || []).join("; "))} <a href="#/i/${i.id}"><u>open invoice</u></a>`}
        ${i.error ? `<div class="muted" style="font-size:12px">${esc(i.error)}</div>` : ""}</td></tr>`).join("")}</tbody></table>
      ${n.synced === items.length && items.length ? `<p class="good" style="margin-top:16px">Everything in this batch is in Tally.</p>` : ""}
      ${!ME.licence?.can_post ? `<div class="alert warn" style="margin-top:14px">Posting to Tally is not allowed for your account — you can read and review. Ask the admin to allow posting.</div>`
        : tallyHelp(c) ? `<div class="alert warn" style="margin-top:14px">${tallyHelp(c)} Pushed invoices wait until then.</div>` : ""}</div>`;
    wireTop(c);
    $("#extraBtns").innerHTML = `<button class="btn primary" id="push" ${n.ready + n.failed && ME.licence?.can_post ? "" : "disabled"} ${ME.licence?.can_post ? "" : 'title="Posting to Tally is not allowed for your account"'}>Push to Tally <kbd>P</kbd></button>`;
    $("#stat").textContent = `${items.length} invoice(s) · ${n.review} in review · ${n.ready} ready · ${n.synced} in Tally`;
    $$(".stats [data-f]").forEach((d) => d.onclick = () => { filter = d.dataset.f; draw(); });
    $("#q").oninput = debounce((e) => { q = e.target.value; draw(); $("#q").focus(); }, 250);
    $$("input[data-id]").forEach((cb) => cb.onchange = () => cb.checked ? checked.add(cb.dataset.id) : checked.delete(cb.dataset.id));
    $("#all").onchange = (e) => { v.forEach((i) => e.target.checked ? checked.add(i.id) : checked.delete(i.id)); draw(); };
    const sel = () => [...checked];
    const push = async () => {
      const ids = sel().length ? sel() : items.filter((i) => (i.status === "review" && i.steps.ready) || i.status === "failed").map((i) => i.id);
      const r = await act(() => api(`/batches/${bid}/push`, { body: { invoice_ids: ids } }));
      if (r.skipped.length) {
        const dups = r.skipped.filter((x) => /already in Tally/.test(x.reason));
        toast(`${r.pushed} sent · ${r.skipped.length} skipped: ${r.skipped[0].reason}`, true);
        if (dups.length && confirm(`${dups.length} invoice(s) look like duplicates of vouchers already in Tally. Post them anyway?`))
          await act(() => api(`/batches/${bid}/push`, { body: { invoice_ids: dups.map((x) => x.id), force: true } }), "Sent");
      } else toast(`${r.pushed} invoice(s) sent to Tally`);
      route();
    };
    const bulk = async (action, label) => { if (!sel().length) return toast("Tick the invoices first", true); for (const id of sel()) await api(`/invoices/${id}/${action}`, { method: "POST" }); toast(label); route(); };
    $("#push").onclick = push; keymap.p = push;
    $("#markSynced").onclick = () => bulk("mark-synced", "Marked as synced"); keymap.y = $("#markSynced").onclick;
    $("#backReview").onclick = () => bulk("back-to-review", "Sent back to review"); keymap.r = $("#backReview").onclick;
  };
  draw();
  if (n.queued) every(2500, refresh);
}

// ---------------------------------------------------------------------------
// single invoice: verify & edit
// ---------------------------------------------------------------------------
async function viewInvoice(iid) {
  const inv = await api(`/invoices/${iid}`);
  const b = inv.batch, c = inv.company;
  const h = inv.data;
  const editable = inv.status !== "queued" && inv.status !== "synced";
  const ro = editable ? "" : "readonly";
  const f = (k, label, cls = "") => `<div class="field"><label>${label}</label><input class="in ${cls}" data-h="${k}" value="${esc(h[k] ?? "")}" ${ro}></div>`;
  const itemsSum = inv.lines.reduce((a, l) => a + (l.amount || 0), 0);
  const taxSum = ["cgst", "sgst", "igst", "cess", "round_off"].reduce((a, k) => a + (Number(h[k]) || 0), 0);
  const diff = h.total != null ? Math.round((itemsSum + taxSum - h.total) * 100) / 100 : 0;
  const lineRow = (l, i) => `<tr data-line="${l.id || ""}" data-kind="${l.kind}">
    <td><input class="cell" data-l="description" value="${esc(l.description)}" ${ro}>${l.kind === "ledger" ? '<span class="tag">charge</span>' : ""}
      <div class="muted" style="font-size:11.5px;padding-left:6px">${l.kind === "item" ? `→ <span class="state-${l.stock_state}">${esc(l.stock_item || "no stock item")}</span> · ` : ""}<span class="state-${l.ledger_state}">${esc(l.ledger || "no ledger")}</span></div></td>
    <td><input class="cell mono" data-l="hsn" value="${esc(l.hsn || "")}" ${ro} style="width:70px"></td>
    <td><input class="cell num" data-l="qty" value="${l.qty ?? ""}" ${ro} style="width:70px"></td>
    <td><input class="cell" data-l="unit" value="${esc(l.unit || "")}" ${ro} style="width:56px"></td>
    <td><input class="cell num" data-l="rate" value="${l.rate ?? ""}" ${ro} style="width:80px"></td>
    <td><input class="cell num" data-l="discount_pct" value="${l.discount_pct ?? ""}" ${ro} style="width:50px"></td>
    <td><input class="cell num" data-l="gst_rate" value="${l.gst_rate ?? ""}" ${ro} style="width:50px"></td>
    <td><input class="cell num" data-l="amount" value="${l.amount ?? ""}" ${ro} style="width:100px"></td>
    <td>${editable ? `<button class="btn sm ghost" data-del="${i}" title="Remove line">✕</button>` : ""}</td></tr>`;
  const statusLbl = { review: inv.steps.ready ? "Ready to sync" : "In review", queued: "Sending to Tally…", synced: "In Tally", failed: "Tally rejected it", error: "Could not read", reading: "Reading…" }[inv.status];
  app().innerHTML = topBar([[c.name, `#/c/${c.id}`], [b.name, `#/b/${b.id}`], [`Invoice ${h.number || ""}`]], c) + `<div class="bar">
      <span class="status"><b class="${inv.status === "synced" ? "good" : inv.status === "failed" || inv.status === "error" ? "bad" : ""}">${statusLbl}</b> · ${b.voucher_type} · steps: ${["party", "stock", "ledger", "tax"].map((s) => `${s} ${inv.steps[s] ? '<span class="good">✓</span>' : '<span class="faint">○</span>'}`).join(" ")}</span>
      <div class="spacer"></div><button class="btn" onclick="history.back()">Back <kbd>Esc</kbd></button>
      ${editable ? `<button class="btn danger" id="del">Delete invoice</button>${inv.pages.length ? `<button class="btn" id="reread" title="Read this invoice again from the image (your edits are replaced)">↻ Read again</button>` : ""}<button class="btn" id="save">Save changes <kbd>Ctrl+S</kbd></button>` : `<button class="btn" id="back">Send back to review</button>`}
      ${inv.steps.ready && ME.licence?.can_post ? `<a class="btn" href="/api/invoices/${iid}/xml?k=${encodeURIComponent(KEY)}">Tally XML</a>` : ""}
      ${editable ? `<a class="btn" href="#/b/${b.id}/review/${["party", "stock", "ledger", "tax"].find((s) => !inv.steps[s]) || "sync"}">Resolve in review</a>` : ""}
      ${editable && inv.steps.ready && ME.licence?.can_post ? `<button class="btn primary" id="push">Push to Tally</button>` : ""}</div>
    <div class="inv-layout"><div>${pageViewer(inv.pages)}</div><div>
      ${inv.sync_error ? `<div class="alert bad" style="margin-bottom:10px">${esc(inv.sync_error)}</div>` : ""}
      ${(h.warnings || []).map((w) => `<div class="alert warn" style="margin-bottom:6px">⚠ ${esc(w)}</div>`).join("")}
      ${h.handwritten ? `<div class="alert warn" style="margin-bottom:6px">Handwritten invoice — please double-check every figure.</div>` : ""}
      ${h.rechecked ? `<div class="alert ok" style="margin-bottom:6px">The first reading didn't add up, so it was read a second time${h.ai?.rechecked_by ? ` by ${esc(h.ai.rechecked_by)}` : ""}${(h.warnings || []).length ? " — the notes above are what still needs your eye" : " — everything adds up now"}.</div>` : ""}
      ${h.ai ? `<div class="muted" style="font-size:12.5px;margin-bottom:8px">Read by <b>${esc(h.ai.read_by)}</b>${h.ai.rechecked_by ? ` · checked by <b>${esc(h.ai.rechecked_by)}</b>` : ""}${h.ai.cost_usd ? ` · AI cost ≈ ₹${(h.ai.cost_usd * 88).toFixed(2)}` : ""}</div>` : ""}
      ${editable && !inv.steps.ready && inv.steps.blockers?.length ? `<div class="alert bad" style="margin-bottom:6px"><b>Not ready for Tally yet:</b> ${esc(inv.steps.blockers.join("; "))}.${!inv.steps.total_ok ? " Compare each line amount and the tax figures below with the image, correct them, and save." : ""}</div>` : ""}
      <div class="row">${f("number", "Invoice no.", "mono")}${f("date", "Date (YYYY-MM-DD)", "mono")}</div>
      <div class="row">${f("party_name", b.voucher_type === "Purchase" ? "Supplier name" : "Customer name")}
        <div class="field"><label>GSTIN ${inv.gstin_valid === true ? '<span class="good">✓ valid</span>' : inv.gstin_valid === false ? '<span class="bad">checksum fails</span>' : ""}</label><input class="in mono" data-h="party_gstin" value="${esc(h.party_gstin || "")}" maxlength="15" ${ro}></div></div>
      <div class="row">${f("party_state", "State")}${f("place_of_supply", "Place of supply")}</div>
      <div class="field"><label>Tally ledger</label><div>${inv.party_ledger ? `<span class="state-resolved">${esc(inv.party_ledger)}</span> <span class="muted">· ${esc(inv.party_method || "")}</span>` : `<span class="state-suspense">not matched yet</span>`}</div></div>
      <h2 style="margin-top:14px">Lines</h2>
      <div style="overflow:auto"><table class="grid lines-tbl"><thead><tr><th>Description</th><th>HSN</th><th class="num">Qty</th><th>Unit</th><th class="num">Rate</th><th class="num">Disc %</th><th class="num">GST %</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody id="lines">${inv.lines.map(lineRow).join("")}</tbody></table></div>
      ${editable ? `<button class="btn sm" id="addLine">+ Item line</button> <button class="btn sm" id="addCharge">+ Charge (freight, packing…)</button>` : ""}
      <div class="totals">
        <span class="lbl">Taxable value</span><span class="num">${money(itemsSum)}</span>
        ${["cgst", "sgst", "igst", "cess", "round_off"].map((k) => `<span class="lbl">${k === "round_off" ? "Round off" : k.toUpperCase()}</span><input class="cell num mono" data-h="${k}" value="${h[k] ?? ""}" ${ro}>`).join("")}
        <span class="lbl"><b>Invoice total</b></span><input class="cell num mono" data-h="total" value="${h.total ?? ""}" ${ro} style="font-weight:700">
      </div>
      ${Math.abs(diff) > 0.009 ? `<div class="alert ${Math.abs(diff) > 1 ? "bad" : "warn"}" style="margin-top:10px">Lines + taxes come to ${money(itemsSum + taxSum)}, which is ${money(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than the invoice total. Check the figures against the image.</div>`
        : `<div class="alert ok" style="margin-top:10px">✓ Lines, taxes and total add up.</div>`}
      ${inv.tax_lines ? `<h2 style="margin-top:16px">Tax posting</h2><table class="grid"><tbody>${inv.tax_lines.map((t) => `<tr><td>${esc(t.label)} ${t.rate != null ? t.rate + "%" : ""}</td><td class="num">${money(t.amount)}</td><td>${esc(t.ledger || "— needs a ledger —")}</td></tr>`).join("")}</tbody></table>` : ""}
      <div class="field" style="margin-top:14px"><label>Narration</label><input class="in" data-h="narration" value="${esc(h.narration || "")}" ${ro}></div>
      ${inv.activity.length ? `<h2 style="margin-top:16px">Activity</h2><div class="muted" style="font-size:12.5px">${inv.activity.map((a) => `${ago(a.at)} — ${esc(a.message)}`).join("<br>")}</div>` : ""}
    </div></div>`;
  wireTop(c);
  wireViewer(app());
  keymap.Escape = () => history.back();
  if (!editable) { $("#back").onclick = async () => { await api(`/invoices/${iid}/back-to-review`, { method: "POST" }); route(); }; return; }
  const collect = () => {
    const data = {};
    $$("[data-h]").forEach((el) => { const k = el.dataset.h; let v = el.value.trim(); if (["cgst", "sgst", "igst", "cess", "round_off", "total"].includes(k)) v = v === "" ? null : Number(v.replace(/,/g, "")); data[k] = v; });
    const lines = $$("#lines tr").map((tr) => { const o = { id: tr.dataset.line || undefined, kind: tr.dataset.kind }; $$("[data-l]", tr).forEach((el) => o[el.dataset.l] = el.value.trim()); return o; });
    return { data, lines };
  };
  const save = async () => { await act(() => api(`/invoices/${iid}`, { method: "PATCH", body: collect() }), "Saved — matching re-run"); route(); };
  $("#save").onclick = save;
  const ks = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } };
  document.addEventListener("keydown", ks);
  onCleanup(() => document.removeEventListener("keydown", ks));
  $$("[data-del]").forEach((bt) => bt.onclick = () => bt.closest("tr").remove());
  // Qty × Rate − Disc% → Amount, like Tally
  $("#lines").addEventListener("input", (e) => {
    const k = e.target.dataset.l;
    if (!["qty", "rate", "discount_pct"].includes(k)) return;
    const tr = e.target.closest("tr"), val = (n) => parseFloat(($(`[data-l="${n}"]`, tr)?.value || "").replace(/,/g, ""));
    const q = val("qty"), r = val("rate"), d = val("discount_pct") || 0;
    if (q && r) $(`[data-l="amount"]`, tr).value = (Math.round(q * r * (1 - d / 100) * 100) / 100).toString();
  });
  const addRow = (kind) => { $("#lines").insertAdjacentHTML("beforeend", lineRow({ kind, description: "", amount: "", stock_state: "suspense", ledger_state: "suspense" }, -1)); $("#lines tr:last-child input").focus(); };
  $("#addLine").onclick = () => addRow("item"); $("#addCharge").onclick = () => addRow("ledger");
  $("#del").onclick = async () => { if (confirm("Delete this invoice from the batch?")) { await api(`/invoices/${iid}`, { method: "DELETE" }); location.hash = `#/b/${b.id}`; } };
  $("#reread")?.addEventListener("click", async () => {
    if (!confirm("Read this invoice again from the image? Your edits on this invoice will be replaced.")) return;
    await act(() => api(`/invoices/${iid}/reread`, { method: "POST" }), "Reading again…");
    location.hash = `#/b/${b.id}`;
  });
  $("#push")?.addEventListener("click", async () => { await act(() => api(`/invoices/${iid}/push`, { method: "POST" }), "Sent to Tally"); route(); });
}

// ---------------------------------------------------------------------------
route();
