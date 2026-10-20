// The InvoiceTotally service — the only online part of InvoiceTotally for Windows.
//
// It keeps the list of people allowed to use the app (added by the admin), each person's limits (companies,
// posting to Tally, which AI) and credits (invoice credits, statement credits), and it runs the AI that reads
// invoices, so the AI keys never leave it. Each PC signs in once with Google and then holds a device key; the
// service answers with a licence signed by its own Ed25519 key, which the app keeps for working offline.
//
// This file is shared: it runs inside the existing InvoiceTotally Cloudflare Worker (copied there as
// worker/licence.js) and in this repository's tests. Everything it needs from the Worker is passed in.

export const ADMIN_EMAIL = "vipulshegur@gmail.com";
export const AI_CHOICES = ["gemini_lite", "gemini", "groq", "claude"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGNIN_SECS = 10 * 60;

export const LIC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lic_users (email TEXT PRIMARY KEY, name TEXT, active INTEGER DEFAULT 1, company_limit INTEGER DEFAULT 1,
    can_post INTEGER DEFAULT 1, invoice_credits INTEGER DEFAULT 0, statement_credits INTEGER DEFAULT 0, ai_options TEXT DEFAULT '["gemini_lite"]',
    note TEXT, created_at REAL, updated_at REAL)`,
  `CREATE TABLE IF NOT EXISTS lic_devices (id TEXT PRIMARY KEY, email TEXT NOT NULL, secret_hash TEXT NOT NULL, name TEXT,
    created_at REAL, last_seen REAL, revoked INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_lic_devices ON lic_devices(email)`,
  `CREATE TABLE IF NOT EXISTS lic_signins (nonce_hash TEXT PRIMARY KEY, email TEXT, device_id TEXT, device_secret TEXT, error TEXT, created_at REAL)`,
  `CREATE TABLE IF NOT EXISTS lic_companies (email TEXT NOT NULL, company_id TEXT NOT NULL, name TEXT, gstin TEXT, created_at REAL,
    PRIMARY KEY (email, company_id))`,
  `CREATE TABLE IF NOT EXISTS lic_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, kind TEXT, credits INTEGER DEFAULT 0,
    detail TEXT, ai TEXT, cost_usd REAL DEFAULT 0, at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_lic_usage ON lic_usage(email, at)`,
];

export class LicError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const now = () => Date.now() / 1000;
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uText = (s) => b64u(enc.encode(s));
const rand = (n = 24) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const str = (v, n) => String(v ?? "").trim().slice(0, n);
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));
const jl = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const adminEmail = (env) => String(env?.ADMIN_EMAIL || ADMIN_EMAIL).toLowerCase();
const isAdmin = (env, email) => String(email).toLowerCase() === adminEmail(env);

// tables made once per database binding (kept for the life of the Worker isolate)
const ready = new WeakMap();
async function init(env, D) {
  let p = ready.get(env.DB);
  if (!p) { p = D.batch(LIC_SCHEMA.map((s) => D.stmt(s))).catch((e) => { ready.delete(env.DB); throw e; }); ready.set(env.DB, p); }
  return p;
}

// ------------------------------------------------------------------ signing key (made once, kept in app_config)
const keys = new WeakMap();
let BINDING = null; // the database binding of the current request (set by the router wrapper)
async function signingKey(D) {
  const hit = keys.get(BINDING);
  if (hit) return hit;
  let row = await D.first("SELECT value FROM app_config WHERE key='lic_key'");
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const value = JSON.stringify({ priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) });
    await D.run("INSERT INTO app_config (key, value, updated_at) VALUES ('lic_key', ?, ?) ON CONFLICT(key) DO NOTHING", value, now());
    row = await D.first("SELECT value FROM app_config WHERE key='lic_key'");
  }
  const k = JSON.parse(row.value);
  const pub = { kty: k.pub.kty, crv: k.pub.crv, x: k.pub.x };
  const out = { pub, priv: await crypto.subtle.importKey("jwk", k.priv, { name: "Ed25519" }, false, ["sign"]) };
  if (BINDING) keys.set(BINDING, out);
  return out;
}
async function sign(D, payload) {
  const k = await signingKey(D);
  const p = b64uText(JSON.stringify(payload));
  return { payload: p, sig: b64u(await crypto.subtle.sign({ name: "Ed25519" }, k.priv, enc.encode(p))) };
}

// ------------------------------------------------------------------ people
async function getUser(env, D, email) {
  email = String(email || "").toLowerCase();
  let u = await D.first("SELECT * FROM lic_users WHERE email=?", email);
  if (!u && isAdmin(env, email)) {
    await D.run("INSERT INTO lic_users (email, name, active, company_limit, can_post, ai_options, created_at, updated_at) VALUES (?,?,1,999,1,?,?,?) ON CONFLICT(email) DO NOTHING",
      email, "Admin", JSON.stringify(AI_CHOICES), now(), now());
    u = await D.first("SELECT * FROM lic_users WHERE email=?", email);
  }
  if (!u) return null;
  u.admin = isAdmin(env, email);
  u.ai_options = u.admin ? AI_CHOICES : jl(u.ai_options, []).filter((a) => AI_CHOICES.includes(a));
  return u;
}

async function licenceFor(env, D, u, deviceId) {
  const companies = (await D.first("SELECT count(*) n FROM lic_companies WHERE email=?", u.email)).n;
  return sign(D, { v: 1, email: u.email, name: u.name || "", admin: u.admin, active: !!u.active,
    company_limit: u.admin ? 999 : u.company_limit, can_post: u.admin || !!u.can_post,
    invoice_credits: u.invoice_credits, statement_credits: u.statement_credits, ai_options: u.ai_options,
    companies, device: deviceId, issued_at: Math.floor(now()) });
}

async function device(env, D, req) {
  const m = /^Device ([0-9a-f]{32})\.([\w-]{20,})$/.exec(req.headers.get("authorization") || "");
  if (!m) throw new LicError(401, "Please sign in.");
  const d = await D.first("SELECT * FROM lic_devices WHERE id=?", m[1]);
  if (!d || d.revoked || d.secret_hash !== (await sha256(m[2]))) throw new LicError(401, "This PC was signed out. Please sign in again.");
  const u = await getUser(env, D, d.email);
  if (!u) throw new LicError(401, "Your account was removed. Ask the admin.");
  if (!d.last_seen || now() - d.last_seen > 3600) await D.run("UPDATE lic_devices SET last_seen=? WHERE id=?", now(), d.id);
  return { d, u };
}
const needActive = (u) => { if (!u.active) throw new LicError(403, "Your account is switched off. Ask the admin."); };

// ------------------------------------------------------------------ reading with the AI
function pickAI(u, wanted) {
  if (wanted && u.ai_options.includes(wanted)) return wanted;
  if (!u.ai_options.length) throw new LicError(403, "No AI is enabled for your account. Ask the admin.");
  return u.ai_options[0];
}
async function companyFor(D, u, c) {
  const id = str(c?.id, 40);
  if (!u.admin) {
    const row = id && (await D.first("SELECT name FROM lic_companies WHERE email=? AND company_id=?", u.email, id));
    if (!row) throw new LicError(403, "This company is not registered for your account. Open the app while online once, or ask the admin.");
  }
  return { id, name: str(c?.name, 200), gstin: str(c?.gstin, 15), state_code: str(c?.state_code, 2) };
}
function needCredits(u, kind, n = 1) {
  if (u.admin) return;
  const have = kind === "statement" ? u.statement_credits : u.invoice_credits;
  if (have < n) throw new LicError(402, kind === "statement" ? "No statement credits left. Ask the admin to add credits." : "No invoice credits left. Ask the admin to add credits.");
}
async function charge(D, u, kind, n, detail, ai = null, cost = 0) {
  const col = kind === "statement" ? "statement_credits" : "invoice_credits";
  const take = u.admin ? 0 : n;
  const stmts = [D.stmt("INSERT INTO lic_usage (email, kind, credits, detail, ai, cost_usd, at) VALUES (?,?,?,?,?,?,?)", u.email, kind, -take, str(detail, 300), ai, cost || 0, now())];
  if (take) stmts.unshift(D.stmt(`UPDATE lic_users SET ${col}=max(0, ${col}-?), updated_at=? WHERE email=?`, take, now(), u.email));
  await D.batch(stmts);
  if (take) u[col] = Math.max(0, u[col] - take);
}
const aiCompany = (c, ai) => ({ ...c, settings: { ai_mode: ai } });

// ------------------------------------------------------------------ the sign-in page (Google, on the service's own address)
export function signinPage(env, url, clientId) {
  const n = str(url.searchParams.get("n"), 80), d = str(url.searchParams.get("d"), 80);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const body = !clientId ? `<p class="bad">Google sign-in is not set up on the service yet (no Google client ID).</p>`
    : !n ? `<p class="bad">Open this page from the InvoiceTotally app (Sign in with Google).</p>`
    : `<div id="g"></div><p id="msg" class="muted">Sign in with the Google account the admin added for you.</p>
<script src="https://accounts.google.com/gsi/client" async onload="start()"></script>
<script>
function start(){google.accounts.id.initialize({client_id:${JSON.stringify(clientId)},callback:done,ux_mode:"popup"});
google.accounts.id.renderButton(document.getElementById("g"),{theme:"filled_blue",size:"large",text:"signin_with",shape:"pill"});}
async function done(r){const m=document.getElementById("msg");m.className="muted";m.textContent="Checking…";
try{const x=await fetch("/api/lic/signin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({n:${JSON.stringify(n)},d:${JSON.stringify(d)},credential:r.credential})});
const j=await x.json();if(!x.ok)throw new Error(j.error||"Sign-in failed");document.getElementById("g").remove();
m.className="good";m.textContent="Signed in as "+j.email+". You can close this window and go back to InvoiceTotally.";setTimeout(()=>window.close(),2500);}
catch(e){m.className="bad";m.textContent=e.message;}}
</script>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — InvoiceTotally</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2329;--muted:#5b6670;--good:#1f8a5b;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#111518;--card:#1a1f24;--text:#e6eaee;--muted:#9aa5ae;--good:#4cc38a;--bad:#ff7b6b}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}
.card{background:var(--card);padding:32px 28px;border-radius:14px;max-width:380px;width:calc(100% - 32px);box-shadow:0 2px 14px #0002;text-align:center}
.logo{width:44px;height:44px;border-radius:10px;background:#2fb58b;color:#062018;font:900 20px Arial;display:grid;place-items:center;margin:0 auto 12px}
#g{display:flex;justify-content:center;margin:20px 0 8px}.muted{color:var(--muted)}.good{color:var(--good)}.bad{color:var(--bad)}
</style></head><body><div class="card"><div class="logo">IT</div><h2 style="margin:0">InvoiceTotally</h2>
${d ? `<p class="muted" style="margin:4px 0 0">Signing in on ${esc(d)}</p>` : ""}${body}</div></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}

// ------------------------------------------------------------------ routes
/**
 * route(method, pattern, fn, { open: true }) — the Worker's router. deps:
 *   googleCheck(env, D, credential, allowedEmails) → { email, name }   (verifies the Google ID token)
 *   ai: { readInvoice(env, pages, company, vt), splitPages(env, pages, company), readSheet(env, text, company, vt), testAI(env, ai), keys(env) }
 */
export function licenceRoutes(route, { db, googleCheck, ai }) {
  const R = (method, path, fn) => route(method, path, async (ctx) => {
    const D = ctx.D || db(ctx.env);
    BINDING = ctx.env.DB;
    await init(ctx.env, D);
    try { return await fn({ ...ctx, D }); }
    catch (e) { if (e instanceof LicError) return json({ error: e.message }, e.status); throw e; }
  }, { open: true });
  const reply = async (env, D, u, d, extra = {}) => json({ ...extra, licence: await licenceFor(env, D, u, d.id), pubkey: (await signingKey(D)).pub });

  R("POST", "/api/lic/signin", async ({ env, D, body }) => {
    const n = str(body.n, 80);
    if (n.length < 20) throw new LicError(400, "Start signing in from the InvoiceTotally app.");
    const allowed = (await D.all("SELECT email FROM lic_users WHERE active=1")).map((r) => r.email);
    if (!allowed.includes(adminEmail(env))) allowed.push(adminEmail(env));
    let who;
    try { who = await googleCheck(env, D, body.credential, allowed); }
    catch (e) {
      const msg = e.status === 403 ? "This Google account has not been added to InvoiceTotally. Ask the admin to add it." : e.message;
      throw new LicError(e.status || 401, msg);
    }
    const u = await getUser(env, D, who.email);
    if (!u) throw new LicError(403, "This Google account has not been added to InvoiceTotally. Ask the admin to add it.");
    needActive(u);
    const id = hex(crypto.getRandomValues(new Uint8Array(16))), secret = rand(32);
    const t = now();
    await D.batch([
      D.stmt("INSERT INTO lic_devices (id, email, secret_hash, name, created_at, last_seen) VALUES (?,?,?,?,?,?)", id, u.email, await sha256(secret), str(body.d, 80) || "PC", t, t),
      D.stmt("INSERT INTO lic_signins (nonce_hash, email, device_id, device_secret, created_at) VALUES (?,?,?,?,?) ON CONFLICT(nonce_hash) DO NOTHING", await sha256(n), u.email, id, secret, t),
      D.stmt("DELETE FROM lic_signins WHERE created_at < ?", t - SIGNIN_SECS),
      ...(who.name && !u.name ? [D.stmt("UPDATE lic_users SET name=? WHERE email=?", str(who.name, 80), u.email)] : []),
    ]);
    return json({ ok: true, email: u.email });
  });

  R("POST", "/api/lic/claim", async ({ env, D, body }) => {
    const h = await sha256(str(body.n, 80));
    const row = await D.first("DELETE FROM lic_signins WHERE nonce_hash=? RETURNING *", h);
    if (!row) return json({ pending: true });
    if (now() - row.created_at > SIGNIN_SECS) return json({ error: "That sign-in took too long. Please sign in again." });
    const u = await getUser(env, D, row.email);
    if (!u) return json({ error: "This account was removed." });
    return reply(env, D, u, { id: row.device_id }, { device: { id: row.device_id, secret: row.device_secret } });
  });

  R("POST", "/api/lic/licence", async ({ env, D, req }) => { const { d, u } = await device(env, D, req); return reply(env, D, u, d); });
  R("POST", "/api/lic/signout", async ({ env, D, req }) => { const { d } = await device(env, D, req); await D.run("UPDATE lic_devices SET revoked=1 WHERE id=?", d.id); return json({ ok: true }); });

  R("POST", "/api/lic/company", async ({ env, D, req, body }) => {
    const { d, u } = await device(env, D, req);
    needActive(u);
    const id = str(body.id, 40);
    if (!/^[0-9a-f]{32}$/.test(id)) throw new LicError(400, "Bad company");
    const have = await D.first("SELECT company_id FROM lic_companies WHERE email=? AND company_id=?", u.email, id);
    if (!have) {
      const n = (await D.first("SELECT count(*) n FROM lic_companies WHERE email=?", u.email)).n;
      if (!u.admin && n >= u.company_limit) throw new LicError(403, `Your account allows ${u.company_limit} compan${u.company_limit === 1 ? "y" : "ies"}. Ask the admin to increase the limit.`);
      await D.run("INSERT INTO lic_companies (email, company_id, name, gstin, created_at) VALUES (?,?,?,?,?)", u.email, id, str(body.name, 200), str(body.gstin, 15), now());
    } else await D.run("UPDATE lic_companies SET name=?, gstin=? WHERE email=? AND company_id=?", str(body.name, 200), str(body.gstin, 15), u.email, id);
    return reply(env, D, u, d, { ok: true });
  });

  R("POST", "/api/lic/read/split", async ({ env, D, req, body }) => {
    const { u } = await device(env, D, req);
    needActive(u); needCredits(u, "invoice");
    const c = await companyFor(D, u, body.company), choice = pickAI(u, body.company?.ai);
    const pages = (body.pages || []).slice(0, 200).map(String);
    const groups = await ai.splitPages(env, pages, aiCompany(c, choice));
    return json({ groups });
  });

  R("POST", "/api/lic/read/invoice", async ({ env, D, req, body }) => {
    const { d, u } = await device(env, D, req);
    needActive(u); needCredits(u, "invoice");
    const c = await companyFor(D, u, body.company), choice = pickAI(u, body.company?.ai);
    const pages = (body.pages || []).slice(0, 30).map(String);
    if (!pages.length) throw new LicError(400, "No pages");
    const data = await ai.readInvoice(env, pages, aiCompany(c, choice), body.voucher_type === "Sales" ? "Sales" : "Purchase");
    await charge(D, u, "invoice", 1, `${c.name}: ${data.number || "invoice"} ${data.seller?.name || ""}`.trim(), choice, data._ai?.cost_usd);
    return reply(env, D, u, d, { data });
  });

  R("POST", "/api/lic/read/sheet", async ({ env, D, req, body }) => {
    const { d, u } = await device(env, D, req);
    needActive(u); needCredits(u, "invoice");
    const c = await companyFor(D, u, body.company), choice = pickAI(u, body.company?.ai);
    let invoices = await ai.readSheet(env, String(body.text || "").slice(0, 900_000), aiCompany(c, choice), body.voucher_type === "Sales" ? "Sales" : "Purchase");
    // only as many invoices as there are credits
    if (!u.admin && invoices.length > u.invoice_credits) invoices = invoices.slice(0, u.invoice_credits);
    await charge(D, u, "invoice", invoices.length, `${c.name}: ${invoices.length} invoice(s) from a register`, choice,
      invoices.reduce((s, i) => s + (i._ai?.cost_usd || 0), 0));
    return reply(env, D, u, d, { invoices });
  });

  R("POST", "/api/lic/use/statement", async ({ env, D, req, body }) => {
    const { d, u } = await device(env, D, req);
    needActive(u); needCredits(u, "statement");
    const c = await companyFor(D, u, body.company);
    await charge(D, u, "statement", 1, `${c.name}: ${str(body.name, 120)} (${int(body.lines, 0, 1e6)} entries)`);
    return reply(env, D, u, d, { ok: true });
  });

  R("POST", "/api/lic/ai/test", async ({ env, D, req, body }) => {
    const { u } = await device(env, D, req);
    const choice = pickAI(u, body.ai);
    try { return json({ ok: true, ai: choice, ...(await ai.testAI(env, choice)) }); }
    catch (e) { return json({ ok: false, ai: choice, error: String(e.message || e) }); }
  });

  // ---------------------------------------------------------------- admin
  const admin = async (env, D, req) => { const x = await device(env, D, req); if (!x.u.admin) throw new LicError(403, "Only the admin can do this."); return x; };
  const userRow = (u, companies = 0, env = null) => ({ email: u.email, name: u.name || "", active: !!u.active, company_limit: u.company_limit, can_post: !!u.can_post,
    invoice_credits: u.invoice_credits, statement_credits: u.statement_credits, ai_options: jl(u.ai_options, []), note: u.note || "",
    companies, created_at: u.created_at, admin: isAdmin(env, u.email) });

  R("POST", "/api/lic/admin/users", async ({ env, D, req }) => {
    await admin(env, D, req);
    const [users, comps, used, devs] = await Promise.all([
      D.all("SELECT * FROM lic_users ORDER BY created_at"),
      D.all("SELECT email, count(*) n FROM lic_companies GROUP BY email"),
      D.all("SELECT email, kind, -sum(credits) n, sum(cost_usd) usd FROM lic_usage WHERE credits<=0 GROUP BY email, kind"),
      D.all("SELECT email, max(last_seen) seen, count(*) n FROM lic_devices WHERE revoked=0 GROUP BY email")]);
    const by = (rows, e) => rows.filter((r) => r.email === e);
    return json({ admin: adminEmail(env), ai: ai.keys(env), users: users.map((u) => ({ ...userRow(u, by(comps, u.email)[0]?.n || 0),
      admin: isAdmin(env, u.email), used: Object.fromEntries(by(used, u.email).map((r) => [r.kind, { credits: r.n, usd: Math.round(r.usd * 1e4) / 1e4 }])),
      last_seen: by(devs, u.email)[0]?.seen || null, devices: by(devs, u.email)[0]?.n || 0 })) });
  });

  R("POST", "/api/lic/admin/save-user", async ({ env, D, req, body }) => {
    await admin(env, D, req);
    const email = str(body.email, 120).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new LicError(400, "Enter a valid Google email address");
    const old = await D.first("SELECT * FROM lic_users WHERE email=?", email);
    const ai_options = Array.isArray(body.ai_options) ? body.ai_options.filter((a) => AI_CHOICES.includes(a)) : jl(old?.ai_options, ["gemini_lite"]);
    const row = {
      name: "name" in body ? str(body.name, 80) : old?.name || "",
      active: "active" in body ? (body.active ? 1 : 0) : old ? old.active : 1,
      company_limit: "company_limit" in body ? int(body.company_limit, 0, 999) : old ? old.company_limit : 1,
      can_post: "can_post" in body ? (body.can_post ? 1 : 0) : old ? old.can_post : 1,
      ai_options: JSON.stringify(ai_options.length ? ai_options : ["gemini_lite"]),
      note: "note" in body ? str(body.note, 300) : old?.note || "",
    };
    if (isAdmin(env, email)) Object.assign(row, { active: 1, can_post: 1, company_limit: 999, ai_options: JSON.stringify(AI_CHOICES) });
    if (old) await D.run("UPDATE lic_users SET name=?, active=?, company_limit=?, can_post=?, ai_options=?, note=?, updated_at=? WHERE email=?",
      row.name, row.active, row.company_limit, row.can_post, row.ai_options, row.note, now(), email);
    else await D.run("INSERT INTO lic_users (email, name, active, company_limit, can_post, ai_options, note, invoice_credits, statement_credits, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,0,?,?)",
      email, row.name, row.active, row.company_limit, row.can_post, row.ai_options, row.note, now(), now());
    if (!row.active) await D.run("UPDATE lic_devices SET revoked=1 WHERE email=?", email); // switched off: every PC is signed out
    return json({ ok: true, user: userRow(await D.first("SELECT * FROM lic_users WHERE email=?", email), 0, env) });
  });

  R("POST", "/api/lic/admin/add-credits", async ({ env, D, req, body }) => {
    const { u: me } = await admin(env, D, req);
    const email = str(body.email, 120).toLowerCase();
    const u = await D.first("SELECT * FROM lic_users WHERE email=?", email);
    if (!u) throw new LicError(404, "No such user");
    const inv = int(body.invoice, -1e6, 1e6), st = int(body.statement, -1e6, 1e6);
    if (!inv && !st) throw new LicError(400, "Enter how many credits to add (or a minus number to take some away)");
    const note = str(body.note, 200) || `Added by ${me.email}`;
    const t = now();
    await D.batch([
      D.stmt("UPDATE lic_users SET invoice_credits=max(0, invoice_credits+?), statement_credits=max(0, statement_credits+?), updated_at=? WHERE email=?", inv, st, t, email),
      ...(inv ? [D.stmt("INSERT INTO lic_usage (email, kind, credits, detail, at) VALUES (?,?,?,?,?)", email, "add_invoice", inv, note, t)] : []),
      ...(st ? [D.stmt("INSERT INTO lic_usage (email, kind, credits, detail, at) VALUES (?,?,?,?,?)", email, "add_statement", st, note, t)] : [])]);
    return json({ ok: true, user: userRow(await D.first("SELECT * FROM lic_users WHERE email=?", email), 0, env) });
  });

  R("POST", "/api/lic/admin/user-detail", async ({ env, D, req, body }) => {
    await admin(env, D, req);
    const email = str(body.email, 120).toLowerCase();
    const u = must(await D.first("SELECT * FROM lic_users WHERE email=?", email));
    const [companies, usage, devices] = await Promise.all([
      D.all("SELECT company_id, name, gstin, created_at FROM lic_companies WHERE email=? ORDER BY created_at", email),
      D.all("SELECT kind, credits, detail, ai, cost_usd, at FROM lic_usage WHERE email=? ORDER BY at DESC LIMIT 200", email),
      D.all("SELECT id, name, created_at, last_seen, revoked FROM lic_devices WHERE email=? ORDER BY created_at DESC LIMIT 30", email)]);
    return json({ user: { ...userRow(u, companies.length), admin: isAdmin(env, email) }, companies, usage, devices });
  });

  R("POST", "/api/lic/admin/free-company", async ({ env, D, req, body }) => {
    await admin(env, D, req);
    await D.run("DELETE FROM lic_companies WHERE email=? AND company_id=?", str(body.email, 120).toLowerCase(), str(body.company_id, 40));
    return json({ ok: true });
  });

  R("POST", "/api/lic/admin/sign-out-device", async ({ env, D, req, body }) => {
    await admin(env, D, req);
    await D.run("UPDATE lic_devices SET revoked=1 WHERE id=?", str(body.id, 40));
    return json({ ok: true });
  });

  R("POST", "/api/lic/admin/remove-user", async ({ env, D, req, body }) => {
    await admin(env, D, req);
    const email = str(body.email, 120).toLowerCase();
    if (isAdmin(env, email)) throw new LicError(400, "The admin can't be removed");
    await D.batch([D.stmt("DELETE FROM lic_users WHERE email=?", email), D.stmt("UPDATE lic_devices SET revoked=1 WHERE email=?", email),
      D.stmt("DELETE FROM lic_companies WHERE email=?", email)]);
    return json({ ok: true });
  });
}
const must = (row) => { if (!row) throw new LicError(404, "Not found"); return row; };
