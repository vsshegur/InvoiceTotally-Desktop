// InvoiceTotally for Windows — the JSON API behind the app window (served on this PC only; see desktop/main.mjs).
import { db, newId, now, jload } from "./db.js";
import * as P from "./pipeline.js";
import * as M from "./matching.js";
import { cleanGstin, gstinValid, stateCode, stateName } from "./gst.js";
import { parseAmount } from "./num.js";
import { AI_CHOICES, AI_LABELS } from "./reader.js";
import * as BK from "./bank.js";
import * as EC from "./ecommerce.js";
import * as GS from "./gstr2b.js";
import * as G2BP from "./gstr2b-purchase.js";
import * as SC from "./master-assist.js";
import * as GC from "./gst-control.js";
import * as DASH from "./dashboard.js";
import * as AW from "./accounting-workplace.js";
import * as SET from "./marketplace-settlements.js";
import {invoiceDateReview,fiscalYearStart,indiaDate,normalizeInvoiceDate} from "./invoice-period.js";

class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const must = (row, msg = "Not found") => { if (!row) throw new HttpError(404, msg); return row; };

// ------------------------------------------------------------------ who may call
function safeEq(a, b) { a = String(a); b = String(b); let r = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return r === 0; }

/** Only the app window has the key (the launcher opens it with the key); other programs and web pages don't. */
function requireWindow(env, req, url) {
  if (!env.WINDOW_KEY) return; // tests
  const k = req.headers.get("x-it-key") || url.searchParams.get("k") || "";
  if (!k || !safeEq(k, env.WINDOW_KEY)) throw new HttpError(401, "Open InvoiceTotally from its desktop icon.", "window");
}

/** The signed-in account's licence (company limit, posting, credits). */
async function licence(env) {
  if (!env.LIC) return env.TEST_LICENCE || null;
  return env.LIC.current();
}
async function requireLicence(env) {
  const lic = await licence(env);
  if (!lic) throw new HttpError(401, "Please sign in.", "signin");
  if (lic.active === false) throw new HttpError(403, "Your account is switched off. Ask the admin.", "inactive");
  if (lic.stale && env.LIC && env.LIC.online === false) throw new HttpError(403, "Connect this PC to the internet once, so your licence can be checked.", "stale");
  return lic;
}
async function requirePosting(env) {
  const lic = await requireLicence(env);
  if (!lic.can_post) throw new HttpError(403, "Posting to Tally is not allowed for your account. Ask the admin to allow it.", "noposting");
  return lic;
}
async function authorizeCompany(D,env,cid) {
  const lic=await requireLicence(env);
  const c=await D.first("SELECT id,name,owner_email FROM companies WHERE id=?",cid);
  if(!c)throw new HttpError(404,"Company not found");
  if(c.owner_email && c.owner_email.toLowerCase() !== String(lic.email||"").toLowerCase())
    throw new HttpError(403,"This company belongs to another account");
  return c;
}
const canChooseAI = (lic, ai) => AI_CHOICES.includes(ai) && (lic.admin || (lic.ai_options || []).includes(ai));
const allowedAI = (lic) => lic.admin ? AI_CHOICES : (lic.ai_options || []).filter((a) => AI_CHOICES.includes(a));
/** A company's AIs in priority order: only ones this account may use, each once. */
function aiOrderFor(lic, list) {
  if (!Array.isArray(list)) throw new HttpError(400, "Choose the AIs as a list.");
  const order = [...new Set(list.map(String))];
  const bad = order.find((a) => !canChooseAI(lic, a));
  if (bad) throw new HttpError(400, `${AI_LABELS[bad] || bad} is not available for your account. Ask the admin.`);
  if (!order.length) throw new HttpError(400, "Tick at least one AI.");
  return order;
}

// ------------------------------------------------------------------ views
let TALLY = null; // the Tally runner (desktop/runner.mjs), set per request
async function companyView(D, id) {
  const [[c], kinds, [pend]] = await D.many([
    ["SELECT * FROM companies WHERE id=?", id],
    ["SELECT kind, count(*) n FROM masters WHERE company_id=? GROUP BY kind", id],
    ["SELECT count(*) n FROM jobs WHERE company_id=? AND status IN ('pending','sent')", id]]);
  if (!c) return null;
  c.settings = jload(c.settings, {});
  c.state_code = c.state_code || stateCode(c.gstin);
  for (const k of ["bridge_info", "bridge_token", "bridge_last_seen"]) delete c[k];
  const st = TALLY?.state || { status: "unknown", companies: [] };
  const tc = String(c.tally_company || c.name).trim().toLowerCase();
  const counts = Object.fromEntries(kinds.map((r) => [r.kind, r.n]));
  const pending = pend.n;
  return { ...c, tally_status: st.status, tally_detail: st.detail || "", tally_online: st.status === "ok",
    company_open: st.status === "ok" && st.companies.some((n) => n.toLowerCase() === tc), pending_jobs: pending, state_name: stateName(c.state_code),
    masters: { ledger: counts.ledger || 0, stock_item: counts.stock_item || 0, group: counts.group || 0, unit: counts.unit || 0 } };
}

function invoiceSummary(inv) {
  const h = inv.data;
  const state = { pending: "Waiting to be read", reading: "Reading", review: inv.steps.ready ? "Ready to sync" : "Ready to review",
    queued: "Queued for Tally", synced: "In Tally", failed: "Failed", error: "Could not read" }[inv.status] || inv.status;
  return { id: inv.id, number: h.number, date: h.date, party_name: h.party_name, party_ledger: inv.party_ledger, lines: inv.lines.length,
    total: h.total != null ? h.total : inv.computed_total, status: inv.status, state, steps: inv.steps, error: inv.sync_error,
    warnings: h.warnings || [], date_review:inv.date_review||invoiceDateReview(inv), page_ids: inv.page_ids, rechecked: !!h.rechecked, ai: h.ai || null,
    // every line to a ledger (stationery, packing material…): posted as an accounting voucher, not an item invoice
    as_voucher: inv.lines.length > 0 && inv.lines.every((l) => l.kind === "ledger") };
}

const REVIEWABLE = ["review", "failed"];
const partyKey = (h) => (h.party_gstin ? `g:${h.party_gstin}` : `n:${M.normParty(h.party_name)}`);

// ------------------------------------------------------------------ routes
const routes = [];
// opts: open (no key), keyed (window key, no sign-in needed), post (needs posting permission)
const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn, ...opts });

route("GET", "/api/health", async ({ env }) => json({ ok: true, version: env.VERSION || "dev" }), { open: true });

// The account on this PC, its licence and the state of Tally — the app shell shows these on every screen.
function licView(lic) {
  if (!lic) return null;
  return { email: lic.email, name: lic.name || "", admin: !!lic.admin, active: lic.active !== false, company_limit: lic.company_limit ?? 0,
    can_post: !!lic.can_post, invoice_credits: lic.invoice_credits ?? 0, statement_credits: lic.statement_credits ?? 0,
    unlimited: !!lic.admin, ai_options: allowedAI(lic),
    issued_at: lic.issued_at, stale: !!lic.stale };
}
route("GET", "/api/me", async ({ env, D }) => {
  const lic = await licence(env);
  const n = lic ? (await D.first("SELECT count(*) n FROM companies WHERE owner_email=?", lic.email)).n : 0;
  const st = TALLY?.state || {};
  return json({ version: env.VERSION || "dev", signed_in: !!lic, licence: licView(lic), companies: n,
    online: env.LIC ? env.LIC.online : true, service: env.LIC?.serviceUrl?.() || "", service_error: env.LIC?.lastError || "",
    tally: { status: st.status || "unknown", detail: st.detail || "", companies: st.companies || [], busy: st.busy || "" },
    ai_labels: AI_LABELS, update: env.update || null });
}, { keyed: true });
// The service address is built into the installer; this sets it on a copy that doesn't have one (before signing in).
route("POST", "/api/service", async ({ env, body }) => {
  if (await licence(env)) throw new HttpError(403, "Sign out first.");
  const u = String(body.url || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) throw new HttpError(400, "Enter the address like https://invoicetotally.example.com");
  env.setConfig?.("service_url", u);
  return json({ ok: true, service: u });
}, { keyed: true });
route("POST", "/api/signin/start", async ({ env }) => {
  if (!env.LIC?.serviceUrl()) throw new HttpError(503, "The InvoiceTotally service address is not set in this copy of the app.");
  return json(await env.LIC.signInStart());
}, { keyed: true });
route("POST", "/api/signin/poll", async ({ env }) => {
  try { return json(await env.LIC.signInPoll()); }
  catch (e) { throw new HttpError(e.status || 503, e.message); }
}, { keyed: true });
route("POST", "/api/signout", async ({ env }) => { await env.LIC?.signOut(); return json({ ok: true }); }, { keyed: true });

route("POST", "/api/licence/refresh", async ({ env }) => {
  const lic = env.LIC ? await env.LIC.refresh() : await licence(env);
  return json({ licence: licView(lic), online: env.LIC?.online ?? true, error: env.LIC?.lastError || "" });
}, { keyed: true });
route("POST", "/api/tally/check", async () => json(TALLY ? await TALLY.tally(true) : { status: "unknown" }), { keyed: true });

// Admin (vipulshegur@gmail.com): users, credits, limits — kept by the service; this app only passes the requests on.
route("POST", "/api/admin/:action", async ({ env, p, body }) => {
  const lic = await requireLicence(env);
  if (!lic.admin) throw new HttpError(403, "Only the admin can do this.");
  if (!/^[a-z-]+$/.test(p.action)) throw new HttpError(400, "unknown action");
  try { return json(await env.LIC.call(`/api/lic/admin/${p.action}`, body)); }
  catch (e) { throw new HttpError(e.status || 503, e.message); }
});
// Settings → Test the AI: one tiny request through the service with this company's AI choice.
route("POST", "/api/ai/test", async ({ env, body }) => {
  const lic = await requireLicence(env);
  if (!canChooseAI(lic, body.ai)) throw new HttpError(400, "That AI is not available for your account.");
  try { return json({ ok: true, ...(await env.LIC.call("/api/lic/ai/test", { ai: body.ai })) }); }
  catch (e) { return json({ ok: false, error: e.message }); }
});
// App settings on this PC: where the daily backup goes.
route("GET", "/api/settings", async ({ env }) => json({ backup_dir: env.getConfig?.("backup_dir") || "", data_dir: env.DATA || "",
  backup_last: jload(env.getConfig?.("backup_last"), null) }));
route("POST", "/api/settings", async ({ env, body }) => {
  if ("backup_dir" in body) env.setConfig("backup_dir", String(body.backup_dir || "").trim());
  return json({ ok: true });
});
route("POST", "/api/backup", async ({ env }) => json(env.backupNow ? env.backupNow() : { error: "not available" }));
route("GET", "/api/backups", async ({ env }) => json({ backups: env.listBackups?.() || [] }));
route("POST","/api/backups/encrypted",async({env,body})=>{
  const lic=await requireLicence(env);
  if(!lic.admin)throw new HttpError(403,"Only the admin can create a portable encrypted database backup");
  if(!env.encryptedBackup)throw new HttpError(503,"This backup is available only on the desktop");
  return json(env.encryptedBackup(String(body.passphrase||"")));
});
route("POST", "/api/backups/restore", async ({ env, body }) => {
  const lic=await requireLicence(env);
  if(!lic.admin)throw new HttpError(403,"Only the admin may restore a PC-wide backup");
  const name=String(body.name||"");
  if(!/^invoicetotally-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name) && !/^invoicetotally-encrypted-\d{8}-\d{6}-[a-f0-9]{6}\.itbak$/.test(name))
    throw new HttpError(400,"Choose a verified backup");
  if(!env.scheduleRestore)throw new HttpError(503,"Restore is available only in the desktop app");
  return json(env.scheduleRestore(name,String(body.passphrase||"")));
});

// companies
// each Google account signed in on this PC has its own companies
route("GET", "/api/companies", async ({ env, D }) => {
  const lic = await requireLicence(env);
  const rows = await D.all("SELECT id FROM companies WHERE owner_email=? OR owner_email IS NULL ORDER BY created_at", lic.email);
  return json(await Promise.all(rows.map((c) => companyView(D, c.id))));
});
route("POST", "/api/companies", async ({ env, D, body }) => {
  const lic = await requireLicence(env);
  if (!String(body.name || "").trim()) throw new HttpError(400, "Company name is required");
  const n = (await D.first("SELECT count(*) n FROM companies WHERE owner_email=?", lic.email)).n;
  if (!lic.admin && n >= (lic.company_limit || 0))
    throw new HttpError(403, `Your account allows ${lic.company_limit || 0} compan${lic.company_limit === 1 ? "y" : "ies"}. Ask the admin to increase the limit.`, "limit");
  const id = newId(), g = cleanGstin(body.gstin);
  // the service keeps the count, so the limit holds even if this PC's data is reset (needs the internet once)
  if (env.LIC) {
    try { await env.LIC.call("/api/lic/company", { id, name: String(body.name).trim(), gstin: g || "" }); }
    catch (e) { throw new HttpError(e.status || 503, e.offline ? "Adding a company needs an internet connection (to check your licence). Try again when online." : e.message, "limit"); }
  }
  await D.insert("companies", { id, name: body.name.trim(), tally_company: String(body.tally_company || body.name).trim(), gstin: g,
    state_code: stateCode(g, body.state), bridge_token: "local_" + id, settings: JSON.stringify(defaultSettings(lic)), owner_email: lic.email, created_at: now() });
  return json(await companyView(D, id));
});
// every AI the account may use, cheapest first: a free AI reads, Gemini or Claude re-reads handwritten bills
const AI_DEFAULT_ORDER = ["gemini_lite", "groq", "gemini", "claude"];
function defaultSettings(lic) {
  const ok = allowedAI(lic);
  const order = AI_DEFAULT_ORDER.filter((a) => ok.includes(a));
  return { ai: order[0] || "gemini_lite", ai_order: order.length ? order : ["gemini_lite"] };
}
route("GET", "/api/companies/:cid", async ({ D, p }) => json(must(await companyView(D, p.cid))));
route("PATCH", "/api/companies/:cid", async ({ env, D, p, body }) => {
  const c = must(await P.getCompany(D, p.cid));
  const upd = {};
  if ("name" in body) {
    upd.name = String(body.name || "").trim();
    if (!upd.name) throw new HttpError(400, "Company name is required");
  }
  // blank "name in Tally" means: the same as the company name
  if ("tally_company" in body) upd.tally_company = String(body.tally_company || "").trim() || upd.name || c.name;
  if ("gstin" in body) { upd.gstin = cleanGstin(body.gstin); upd.state_code = stateCode(upd.gstin, body.state); }
  if (body.settings) {
    const set = { ...body.settings };
    if ("ai_order" in set) { set.ai_order = aiOrderFor(await requireLicence(env), set.ai_order); set.ai = set.ai_order[0]; }
    else if (set.ai) {
      if (!canChooseAI(await requireLicence(env), set.ai)) throw new HttpError(400, "That AI is not available for your account. Ask the admin.");
      set.ai_order = [set.ai, ...(c.settings.ai_order || []).filter((a) => a !== set.ai)];
    }
    upd.settings = JSON.stringify({ ...c.settings, ...set });
  }
  await D.update("companies", p.cid, upd);
  return json(await companyView(D, p.cid));
});
route("DELETE", "/api/companies/:cid", async ({ D, p }) => {
  const bs = await D.all("SELECT id FROM batches WHERE company_id=?", p.cid);
  for (const b of bs) await deleteBatch(D, b.id);
  // everything that belongs to the company: bank statements and GSTR-2B too (nothing in Tally is touched)
  await D.batch([
    D.stmt("DELETE FROM bank_pages WHERE statement_id IN (SELECT id FROM bank_statements WHERE company_id=?)", p.cid),
    ...["masters", "aliases", "jobs", "bank_lines", "bank_statements", "bank_rules", "tally_bank_entries", "gst_docs", "gst_returns", "tally_gst_vouchers", "ecommerce_vouchers", "ecommerce_batches", "settlement_batches", "dashboard_balances", "gst_control"]
      .map((t) => D.stmt(`DELETE FROM ${t} WHERE company_id=?`, p.cid)),
    D.stmt("DELETE FROM companies WHERE id=?", p.cid)]);
  return json({ ok: true });
});
route("POST", "/api/companies/:cid/import-masters", async ({ D, p }) => { await P.queueImportMasters(D, p.cid); return json({ ok: true }); });
route("GET", "/api/companies/:cid/masters", async ({ D, p, url }) => {
  const kind = url.searchParams.get("kind") || "ledger", q = (url.searchParams.get("q") || "").trim();
  const groups = (url.searchParams.get("groups") || "").split("|").filter(Boolean);
  let sql = "SELECT name, parent, primary_group, gstin, state, hsn, gst_rate, unit, pending FROM masters WHERE company_id=? AND kind=?";
  const args = [p.cid, kind];
  if (q) { sql += " AND (uname LIKE ? OR parent LIKE ? OR gstin LIKE ? OR hsn LIKE ?)"; args.push(`%${M.norm(q)}%`, `%${q}%`, `%${q.toUpperCase()}%`, `%${q}%`); }
  if (groups.length) { sql += ` AND primary_group IN (${groups.map(() => "?").join(",")})`; args.push(...groups); }
  const total = (await D.first(`SELECT count(*) n FROM (${sql})`, ...args)).n;
  return json({ total, items: await D.all(sql + " ORDER BY name LIMIT 200", ...args) });
});
route("GET", "/api/companies/:cid/suggest/:what", async ({ D, p, url }) => {
  const s = url.searchParams;
  if (p.what === "party") return json(await M.partyCandidates(D, p.cid, s.get("vtype") || "Purchase", s.get("q") || s.get("name"), s.get("gstin")));
  if (p.what === "stock") return json(await M.stockCandidates(D, p.cid, { description: s.get("desc"), hsn: s.get("hsn"),
    gst_rate: s.get("gst_rate") ? +s.get("gst_rate") : null }, 8, s.get("q") || null));
  throw new HttpError(400, "unknown suggestion type");
});
route("GET", "/api/companies/:cid/jobs", async ({ D, p }) => json(await D.all(
  `SELECT id, kind, invoice_id, status, result, created_at, updated_at,
    CASE WHEN kind='import_bank' THEN (SELECT statement_id FROM bank_lines WHERE id=jobs.invoice_id) END AS statement_id
    FROM jobs WHERE company_id=? ORDER BY created_at DESC LIMIT 100`, p.cid)));

// batches & upload
route("GET", "/api/companies/:cid/batches", async ({ D, p }) => {
  const rows = await D.all("SELECT * FROM batches WHERE company_id=? ORDER BY created_at DESC LIMIT 200", p.cid);
  const counts = await D.all("SELECT batch_id, status, count(*) n FROM invoices WHERE company_id=? GROUP BY batch_id, status", p.cid);
  const byId=new Map(rows.map(b=>[b.id,b]));
  // Only scalar date fields are read here, not invoice line/page images.
  const dateRows=await D.all(`SELECT i.batch_id,
    json_extract(i.data,'$.date') AS date,
    json_extract(i.data,'$.handwritten') AS handwritten,
    json_extract(i.data,'$.date_issue_original') AS date_issue_original,
    json_extract(i.data,'$.date_verified_value') AS date_verified_value,
    json_extract(i.data,'$.date_verified_at') AS date_verified_at
    FROM invoices i JOIN batches b ON b.id=i.batch_id
    WHERE i.company_id=? AND i.status IN ('review','failed','synced','queued')
      AND b.id IN (SELECT id FROM batches WHERE company_id=? ORDER BY created_at DESC LIMIT 200)`,p.cid,p.cid);
  for (const b of rows) {
    b.counts = {};
    b.have_a_look=0;
    for (const c of counts) if (c.batch_id === b.id) b.counts[c.status] = c.n;
    b.invoices = Object.values(b.counts).reduce((a, n) => a + n, 0);
  }
  for(const d of dateRows){
    const batch=byId.get(d.batch_id);
    if(batch&&invoiceDateReview({...batch,batch_created_at:batch.created_at,
      data:{date:d.date,handwritten:!!d.handwritten,date_issue_original:d.date_issue_original,
        date_verified_value:d.date_verified_value,date_verified_at:d.date_verified_at}}).needs_review)
      batch.have_a_look++;
  }
  return json(rows);
});
async function createBatch(D, cid, body, { source, label = "" } = {}) {
  const vt = body.voucher_type === "Sales" ? "Sales" : "Purchase";
  const files = (body.files || []).slice(0, 40);
  const mode=body.period_mode||"mixed";
  if(!["mixed","month"].includes(mode))throw new HttpError(400,"Choose a specific month/year or regular mixed invoices");
  const period=String(body.expected_period||"");
  if(mode==="month"&&(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||+period.slice(0,4)<2000||+period.slice(0,4)>2100))
    throw new HttpError(400,"Choose the invoice month and year before uploading");
  const fy=fiscalYearStart(indiaDate());
  if (!files.length) throw new HttpError(400, "Add at least one file");
  const d = new Date(Date.now() + 5.5 * 3600e3);
  const uploadDay=`${String(d.getUTCDate()).padStart(2,"0")}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${d.getUTCFullYear()}`;
  let name=mode==="month"?`${vt.toUpperCase()}_${period}_UPLOAD_${uploadDay}`:
    mode==="mixed"?`${vt.toUpperCase()}_MIXED_FY${fy}-${String((fy+1)%100).padStart(2,"0")}_UPLOAD_${uploadDay}`:
    `${vt.toUpperCase()}_${uploadDay}`;
  if (label) name += ` · ${label}`;
  const n = (await D.first("SELECT count(*) n FROM batches WHERE company_id=? AND name LIKE ?", cid, name + "%")).n;
  if (n) name += ` (${n + 1})`;
  const id = newId();
  const fileRows = files.map((f, i) => ({ id: newId(), batch_id: id, filename: String(f.filename || "file").slice(0, 200), pages: Math.min(+f.pages || 0, 200), status: "uploading", idx: i }));
  await D.batch([D.insertStmt("batches", { id, company_id: cid, name, voucher_type: vt, source, stage: "uploading", period_mode:mode,expected_period:mode==="month"?period:null,fy_start:fy, created_at: now() }),
    ...fileRows.map((f) => D.insertStmt("files", f))]);
  return { id, name, files: fileRows.map((f) => ({ id: f.id, filename: f.filename })) };
}
const MAX_PAGE_B64 = 1_900_000;
async function addPage(D, f, body) {
  if (f.status !== "uploading") throw new HttpError(400, "File already submitted");
  const img = String(body.image_b64 || ""), thumb = String(body.thumb_b64 || "") || img;
  if (!img || img.length > MAX_PAGE_B64 || thumb.length > MAX_PAGE_B64) throw new HttpError(400, "Page image missing or too large");
  if (!img.startsWith("/9j/")) throw new HttpError(400, "Pages must be JPEG images");
  const idx = Math.max(0, Math.min(999, Math.floor(+body.idx || 0)));
  // Same index sent twice (a retry after a dropped connection) replaces the page instead of duplicating it.
  await D.batch([D.stmt("DELETE FROM pages WHERE file_id=? AND idx=?", f.id, idx),
    D.insertStmt("pages", { id: newId(), batch_id: f.batch_id, file_id: f.id, idx, image_b64: img, thumb_b64: thumb })]);
}
async function startBatch(D, bid) {
  const [[pg], [b], [sheets]] = await D.many([["SELECT count(*) n FROM pages WHERE batch_id=?", bid], ["SELECT source FROM batches WHERE id=?", bid],
    ["SELECT count(*) n FROM files WHERE batch_id=? AND sheet_text IS NOT NULL", bid]]);
  if (!pg.n && !sheets.n) throw new HttpError(400, "Nothing was uploaded in this batch");
  await D.batch([D.stmt("UPDATE files SET status='ready' WHERE batch_id=? AND status='uploading'", bid),
    D.stmt("UPDATE batches SET stage='find' WHERE id=? AND stage='uploading'", bid)]);
  await D.log(b?.source === "phone" ? "Received from the phone — reading started" : "Upload complete — reading started", { batch_id: bid });
}
route("POST", "/api/companies/:cid/batches", async ({ D, p, body }) => {
  must(await D.first("SELECT id FROM companies WHERE id=?", p.cid), "Company not found");
  return json(await createBatch(D, p.cid, body, { source: body.source === "excel" ? "excel" : "pdf" }));
});
route("POST", "/api/files/:fid/pages", async ({ D, p, body }) => {
  await addPage(D, must(await D.first("SELECT id, batch_id, status FROM files WHERE id=?", p.fid)), body);
  return json({ ok: true });
});
route("POST", "/api/files/:fid/sheet", async ({ D, p, body }) => {
  must(await D.first("SELECT id FROM files WHERE id=?", p.fid));
  await D.update("files", p.fid, { sheet_text: String(body.text || "").slice(0, 900_000) });
  return json({ ok: true });
});
route("POST", "/api/batches/:bid/start", async ({ D, p }) => {
  must(await D.first("SELECT id FROM batches WHERE id=?", p.bid));
  await startBatch(D, p.bid);
  return json({ ok: true });
}, { wakes: true });
route("POST", "/api/batches/:bid/work", async ({ env, D, p }) => {
  const did = await P.doWork(env, D, { batchId: p.bid });
  const b = await D.first("SELECT stage FROM batches WHERE id=?", p.bid);
  return json({ did, stage: b?.stage });
});
route("POST", "/api/batches/:bid/retry", async ({ D, p }) => {
  const r = await D.run("UPDATE invoices SET status='pending', attempts=0, claimed_at=NULL, sync_error=NULL WHERE batch_id=? AND status='error'", p.bid);
  await D.run("UPDATE files SET status='ready', error=NULL, note=NULL, attempts=0, claimed_at=NULL WHERE batch_id=? AND status='failed'", p.bid);
  await D.update("batches", p.bid, { stage: "find", error: null });
  await P.refreshStage(D, p.bid);
  return json({ ok: true, retried: r.meta?.changes ?? 0 });
}, { wakes: true });
route("GET", "/api/batches/:bid", async ({ D, p }) => {
  const [[b], files, [pg]] = await D.many([
    ["SELECT * FROM batches WHERE id=?", p.bid],
    ["SELECT id, filename, status, error, note, attempts, pages FROM files WHERE batch_id=? ORDER BY idx", p.bid],
    ["SELECT count(*) n FROM pages WHERE batch_id=?", p.bid]]);
  must(b);
  const [invs, company] = await Promise.all([P.loadBatchInvoices(D, p.bid), companyView(D, b.company_id)]);
  const ai_cost_usd = Math.round(invs.reduce((s, i) => s + (i.data.ai?.cost_usd || 0), 0) * 1e4) / 1e4;
  return json({ ...b, files, pages: pg.n, invoices: invs.map(invoiceSummary), company, ai_cost_usd,
    have_a_look:invs.filter(i=>(i.date_review||invoiceDateReview(i)).needs_review).length });
});
async function deleteBatch(D, bid) {
  const b=must(await D.first("SELECT id FROM batches WHERE id=?",bid),"Batch not found (already deleted)");
  // A job which reached 'sent' might have created a voucher; never lose its identity
  // while Tally is answering. Pending jobs are cancelled transactionally below.
  const busy=await D.first("SELECT id FROM jobs WHERE status='sent' AND invoice_id IN (SELECT id FROM invoices WHERE batch_id=?) LIMIT 1",bid);
  if(busy)throw new HttpError(409,"Tally is currently processing an invoice from this batch. Check its result and try deleting again. Nothing has been deleted.");
  await D.batch([
    D.stmt("DELETE FROM lines WHERE invoice_id IN (SELECT id FROM invoices WHERE batch_id=?)", bid),
    D.stmt("DELETE FROM jobs WHERE status='pending' AND invoice_id IN (SELECT id FROM invoices WHERE batch_id=?)", bid),
    ...["invoices", "pages", "files", "activity"].map((t) => D.stmt(`DELETE FROM ${t} WHERE batch_id=?`, bid)),
    D.stmt("DELETE FROM batches WHERE id=?", bid)]);
}
route("DELETE", "/api/batches/:bid", async ({ D, p }) => { await deleteBatch(D, p.bid); return json({ ok: true }); });
route("GET", "/api/pages/:pid", async ({ D, p }) => {
  const pg = must(await D.first("SELECT image_b64 FROM pages WHERE id=?", p.pid));
  return new Response(JSON.stringify({ b64: pg.image_b64 }), { headers: { "content-type": "application/json", "cache-control": "private, max-age=86400" } });
});
route("GET", "/api/batches/:bid/activity", async ({ D, p }) => json(await D.all(
  "SELECT a.message, a.at, a.invoice_id FROM activity a WHERE a.batch_id=? OR a.invoice_id IN (SELECT id FROM invoices WHERE batch_id=?) ORDER BY a.at DESC LIMIT 200", p.bid, p.bid)));

// review
route("GET", "/api/batches/:bid/review/:step", async ({ D, p }) => {
  const b = must(await D.first("SELECT * FROM batches WHERE id=?", p.bid));
  const step = p.step;
  if (step === "sync") return json({ items: (await P.loadBatchInvoices(D, p.bid)).map(invoiceSummary) });
  const invs = await P.loadBatchInvoices(D, p.bid, REVIEWABLE);
  if (step === "party") {
    const groups = {};
    for (const i of invs) {
      const h = i.data, k = partyKey(h);
      const g = groups[k] ||= { key: k, name: h.party_name, gstin: h.party_gstin, gstin_valid: h.party_gstin ? gstinValid(h.party_gstin) : null,
        address: h.party_address, state: h.party_state, ledger: i.party_ledger, method: i.party_method, proposed: i.party_proposed, invoice_ids: [], total: 0 };
      g.invoice_ids.push(i.id);
      g.total += h.total || 0;
      if (!i.party_ledger) g.ledger = null;
    }
    return json({ voucher_type: b.voucher_type, group: M.partyGroup(b.voucher_type), items: Object.values(groups) });
  }
  if (step === "stock" || step === "ledger") {
    const groups = {}, order = { suspense: 0, proposed: 1, resolved: 2 };
    for (const i of invs) for (const l of i.lines) {
      if (step === "stock" && l.kind !== "item") continue;
      const party = i.party_ledger || i.data.party_name || "";
      const k = step === "stock" ? `${M.norm(party)}|${M.stockKey(l.description)}` : `${l.kind}|${l.stock_item || M.norm(l.description)}`;
      const g = groups[k] ||= { key: k, kind: l.kind, description: l.description, hsn: l.hsn, gst_rate: l.gst_rate, unit: l.unit, parties: [],
        stock_item: l.stock_item, stock_state: l.stock_state, ledger: l.ledger, ledger_state: l.ledger_state, amount: 0, line_ids: [], invoice_ids: [], lines: [] };
      g.amount = Math.round((g.amount + (l.amount || 0)) * 100) / 100;
      g.line_ids.push(l.id);
      if (party && !g.parties.includes(party)) g.parties.push(party);
      if (!g.invoice_ids.includes(i.id)) g.invoice_ids.push(i.id);
      g.lines.push({ id: l.id, invoice: i.data.number, invoice_id: i.id, qty: l.qty, unit: l.unit, rate: l.rate, amount: l.amount, discount_pct: l.discount_pct });
      for (const f of ["stock_state", "ledger_state"]) if ((order[l[f]] ?? 2) < (order[g[f]] ?? 2)) g[f] = l[f];
    }
    return json({ voucher_type: b.voucher_type, account_group: M.accountGroup(b.voucher_type), items: Object.values(groups) });
  }
  if (step === "tax") {
    const heads = {};
    let notCalc = 0;
    for (const i of invs) {
      if (!i.tax_lines) { notCalc++; continue; }
      for (const t of i.tax_lines) {
        const k = `${t.head}|${t.rate}`;
        const g = heads[k] ||= { ...t, key: k, amount: 0, invoice_ids: [] };
        g.amount = Math.round((g.amount + t.amount) * 100) / 100;
        g.invoice_ids.push(i.id);
        if (!t.ledger) g.ledger = null;
      }
    }
    return json({ voucher_type: b.voucher_type, not_calculated: notCalc, items: Object.values(heads), invoices: invs.length });
  }
  throw new HttpError(400, "unknown step");
});

// Corrects the extracted party's name/GSTIN/state/address on every invoice's own data — e.g. when the AI misread
// the GSTIN. Resets the ledger match so it's picked again with the corrected details, and clears any stale checksum
// warning. Used on its own (fix first, then pick a ledger) and from /party when a ledger is created or chosen
// alongside corrected details.
function applyPartyDetails(h, details) {
  if ("name" in details) h.party_name = String(details.name || "").trim();
  if ("gstin" in details) h.party_gstin = cleanGstin(details.gstin);
  if ("state" in details) h.party_state = String(details.state || "").trim();
  if ("address" in details) h.party_address = String(details.address || "").trim();
  h.warnings = (h.warnings || []).filter((w) => !/^GSTIN .* fails the checksum/.test(w));
  if (h.party_gstin && !gstinValid(h.party_gstin)) h.warnings.push(`GSTIN ${h.party_gstin} fails the checksum — check for a misread character.`);
  h.edited = true;
}
route("POST", "/api/batches/:bid/party-fix", async ({ D, p, body }) => {
  must(await D.first("SELECT id FROM batches WHERE id=?", p.bid));
  const ids = body.invoice_ids || [];
  if (!ids.length) throw new HttpError(400, "No invoices to update");
  const invs = await Promise.all(ids.map((iid) => P.loadInvoice(D, iid)));
  const stmts = [];
  for (const inv of invs.filter(Boolean)) {
    const h = inv.data;
    applyPartyDetails(h, body);
    stmts.push(D.updateStmt("invoices", inv.id, { data: JSON.stringify(h), tax_lines: null,
      ...(inv.party_ledger ? { party_ledger: null, party_method: null } : {}) }));
  }
  stmts.push(D.stmt("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", p.bid, null, "Party details corrected", now()));
  await D.batch(stmts);
  return json({ ok: true });
});
route("POST", "/api/batches/:bid/party", async ({ D, p, body }) => {
  const b = must(await D.first("SELECT * FROM batches WHERE id=?", p.bid));
  let ledger = body.ledger;
  if (body.create) {
    const c = body.create;
    ledger = String(c.name || "").trim();
    if (!ledger) throw new HttpError(400, "Ledger name is required");
    await P.createMaster(D, b.company_id, "ledger", ledger, { parent: c.parent || M.partyGroup(b.voucher_type), gstin: c.gstin,
      state: c.state || stateName(stateCode(c.gstin)), address: c.address });
  }
  if (!ledger) throw new HttpError(400, "Pick a ledger");
  const ids = body.invoice_ids || [];
  const invs = await Promise.all(ids.map((iid) => P.loadInvoice(D, iid)));
  const stmts = [];
  for (const inv of invs.filter(Boolean)) {
    const h = inv.data;
    // a ledger created (or picked) here with corrected details also corrects the invoice's own record, so the
    // alias remembers the right GSTIN and the invoice, GSTR-2B and Tally all agree afterwards
    if (body.details) applyPartyDetails(h, body.details);
    stmts.push(D.updateStmt("invoices", inv.id, { party_ledger: ledger, party_method: "Picked by you", party_proposed: null,
      ...(body.details ? { data: JSON.stringify(h), tax_lines: null } : {}) }));
    if (h.party_gstin) stmts.push(M.aliasSetStmt(D, b.company_id, "party", `gstin:${h.party_gstin}`, ledger));
    if (h.party_name) stmts.push(M.aliasSetStmt(D, b.company_id, "party", `name:${M.normParty(h.party_name)}`, ledger));
  }
  stmts.push(D.stmt("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", p.bid, null, `Party set to ${ledger}`, now()));
  await D.batch(stmts);
  await Promise.all(ids.map((iid) => P.autoMatch(D, iid, true)));
  return json({ ok: true });
}, { createPosts: true });

async function lineCtx(D, lid) {
  return must(await D.first(`SELECT l.*, i.company_id, i.batch_id, i.party_ledger, b.voucher_type FROM lines l
    JOIN invoices i ON i.id=l.invoice_id JOIN batches b ON b.id=i.batch_id WHERE l.id=?`, lid));
}
const inList = (ids) => ids.map(() => "?").join(",");

route("POST", "/api/batches/:bid/stock", async ({ D, body }) => {
  const ids = body.line_ids || [];
  const [first, invRows] = await Promise.all([lineCtx(D, ids[0]), D.all(`SELECT DISTINCT invoice_id FROM lines WHERE id IN (${inList(ids)})`, ...ids)]);
  const cid = first.company_id;
  const invIds = invRows.map((r) => r.invoice_id);
  if (body.move_to_ledger) {
    await D.run(`UPDATE lines SET kind='ledger', stock_item=NULL, stock_state=NULL, ledger=NULL, ledger_state='suspense' WHERE id IN (${inList(ids)})`, ...ids);
  } else {
    let item = body.stock_item;
    if (body.create) {
      const c = body.create;
      item = String(c.name || "").trim();
      if (!item) throw new HttpError(400, "Name is required");
      await P.createMaster(D, cid, "stock_item", item, { unit: c.unit || first.unit, hsn: c.hsn || first.hsn,
        gst_rate: c.gst_rate ?? first.gst_rate, parent: c.parent });
    }
    if (!item) throw new HttpError(400, "Pick a stock item");
    // remembered for each supplier these lines came from, so their next bill matches by itself
    const parties = await D.all(`SELECT DISTINCT i.party_ledger p FROM lines l JOIN invoices i ON i.id=l.invoice_id WHERE l.id IN (${inList(ids)}) AND i.party_ledger IS NOT NULL`, ...ids);
    await D.batch([D.stmt(`UPDATE lines SET stock_item=?, stock_state='resolved' WHERE id IN (${inList(ids)})`, item, ...ids),
      M.aliasSetStmt(D, cid, "stock", M.stockKey(first.description), item),
      ...parties.map((r) => M.aliasSetStmt(D, cid, "stock_party", M.stockPartyKey(r.p, first.description), item)),
      D.stmt("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", first.batch_id, null, `'${first.description}' → stock item ${item}`, now())]);
  }
  await Promise.all(invIds.map((iid) => P.autoMatch(D, iid, true)));
  return json({ ok: true });
}, { createPosts: true });

route("POST", "/api/batches/:bid/ledger", async ({ D, body }) => {
  const ids = body.line_ids || [];
  const first = await lineCtx(D, ids[0]);
  const cid = first.company_id;
  let ledger = body.ledger;
  if (body.create) {
    ledger = String(body.create.name || "").trim();
    await P.createMaster(D, cid, "ledger", ledger, { parent: body.create.parent || M.accountGroup(first.voucher_type) });
  }
  if (!ledger) throw new HttpError(400, "Pick a ledger");
  const stmts = [D.stmt(`UPDATE lines SET ledger=?, ledger_state='resolved' WHERE id IN (${inList(ids)})`, ledger, ...ids)];
  if (first.kind === "ledger") stmts.push(M.aliasSetStmt(D, cid, "charge", M.norm(first.description), ledger));
  else if (first.stock_item) stmts.push(M.aliasSetStmt(D, cid, "ledger", `item:${first.voucher_type}:${first.stock_item}`, ledger));
  if (body.remember_for_party && first.party_ledger) stmts.push(M.aliasSetStmt(D, cid, "ledger", `party:${first.voucher_type}:${first.party_ledger}`, ledger));
  // This supplier sells no stock items (stationery, packing material, printing): every line of their bills goes to this
  // ledger and the bill posts as a voucher — the Stock step is skipped for them from now on.
  if (body.remember_party_voucher && first.party_ledger && first.kind === "ledger")
    stmts.push(M.aliasSetStmt(D, cid, "voucher", `${first.voucher_type}:${first.party_ledger}`, ledger));
  stmts.push(D.stmt("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", first.batch_id, null, `'${first.description}' posts to ${ledger}`, now()));
  await D.batch(stmts);
  if (body.remember_party_voucher && first.party_ledger && first.kind === "ledger") {
    // apply it now to this party's other bills in the batch too
    const same = await D.all("SELECT id FROM invoices WHERE batch_id=? AND party_ledger=? AND status IN ('review','failed')", first.batch_id, first.party_ledger);
    await Promise.all(same.map((r) => P.autoMatch(D, r.id, true)));
  }
  return json({ ok: true });
}, { createPosts: true });

route("POST", "/api/batches/:bid/calculate-tax", async ({ D, p, body }) => {
  const ids = body.invoice_ids || (await P.loadBatchInvoices(D, p.bid, REVIEWABLE)).map((i) => i.id);
  await Promise.all(ids.slice(0, 40).map((iid) => P.calculateTax(D, iid)));
  return json({ ok: true, calculated: Math.min(ids.length, 40), remaining: Math.max(0, ids.length - 40) });
});

route("POST", "/api/batches/:bid/tax-ledger", async ({ D, p, body }) => {
  const b = must(await D.first("SELECT * FROM batches WHERE id=?", p.bid));
  const stmts = [];
  for (const i of await P.loadBatchInvoices(D, p.bid, REVIEWABLE)) {
    if (!i.tax_lines) continue;
    let changed = false;
    for (const t of i.tax_lines) if (t.head === body.head && (t.rate ?? null) === (body.rate ?? null)) { t.ledger = body.ledger; t.method = "Picked by you"; changed = true; }
    if (changed) stmts.push(D.updateStmt("invoices", i.id, { tax_lines: JSON.stringify(i.tax_lines) }));
  }
  stmts.push(M.aliasSetStmt(D, b.company_id, "tax", `${b.voucher_type}:${body.head}:${body.rate ?? ""}`, body.ledger));
  await D.batch(stmts);
  return json({ ok: true });
});

route("POST", "/api/batches/:bid/push", async ({ D, p, body }) => {
  const ids = body.invoice_ids || (await P.loadBatchInvoices(D, p.bid, REVIEWABLE)).filter((i) => i.steps.ready).map((i) => i.id);
  let pushed = 0;
  const skipped = [];
  for (const iid of ids) {
    try { await P.pushInvoice(D, iid, !!body.force); pushed++; } catch (e) { skipped.push({ id: iid, reason: e.message }); }
  }
  return json({ pushed, skipped });
}, { post: true });

// single invoice
const LINE_FIELDS = ["description", "hsn", "qty", "unit", "alt_qty", "alt_unit", "rate", "discount_pct", "amount", "gst_rate", "kind"];
const HEADER_FIELDS = ["number", "date", "party_name", "party_gstin", "party_address", "party_state", "place_of_supply", "cgst", "sgst", "igst", "cess", "round_off", "total", "narration"];
const NUMERIC = new Set(["qty", "alt_qty", "rate", "discount_pct", "amount", "gst_rate", "cgst", "sgst", "igst", "cess", "round_off", "total"]);
const toNum = (v) => parseAmount(v);

async function invoiceFull(D, iid) {
  const inv = must(await P.loadInvoice(D, iid));
  inv.pages = inv.page_ids;
  const [[activity, [batch]], company] = await Promise.all([
    D.many([["SELECT message, at FROM activity WHERE invoice_id=? ORDER BY at DESC LIMIT 50", iid],
      ["SELECT id, name, voucher_type, company_id FROM batches WHERE id=?", inv.batch_id]]),
    companyView(D, inv.company_id)]);
  inv.activity = activity;
  inv.batch = batch;
  inv.company = company;
  inv.gstin_valid = inv.data.party_gstin ? gstinValid(inv.data.party_gstin) : null;
  return inv;
}
route("GET", "/api/invoices/:iid", async ({ D, p }) => json(await invoiceFull(D, p.iid)));
route("DELETE", "/api/invoices/:iid", async ({ D, p }) => {
  const inv=must(await D.first("SELECT id FROM invoices WHERE id=?",p.iid),"Invoice not found");
  if(await D.first("SELECT id FROM jobs WHERE invoice_id=? AND status='sent' LIMIT 1",p.iid))
    throw new HttpError(409,"This invoice is being processed by Tally. Confirm the result before deleting.");
  await D.batch([D.stmt("DELETE FROM lines WHERE invoice_id=?", p.iid), D.stmt("DELETE FROM jobs WHERE invoice_id=? AND status='pending'", p.iid),
    D.stmt("DELETE FROM invoices WHERE id=?", p.iid)]);
  return json({ ok: true });
});
route("PATCH", "/api/invoices/:iid", async ({ D, p, body }) => {
  const inv = must(await P.loadInvoice(D, p.iid));
  if (["queued", "synced"].includes(inv.status)) throw new HttpError(400, "Send it back to review before editing");
  const h = inv.data;
  const previousDate=P.normDate(h.date);
  let partyChanged = false;
  for (const k of HEADER_FIELDS) if (body.data && k in body.data) {
    let v = body.data[k];
    if (k === "party_gstin") v = cleanGstin(v);
    if (NUMERIC.has(k)) v = toNum(v);
    if (k === "date") v = P.normDate(v) || String(v || "").trim();
    if ((k === "party_name" || k === "party_gstin") && v !== h[k]) partyChanged = true;
    h[k] = v;
  }
  if(P.normDate(h.date)!==previousDate){h.date_verified_value=null;h.date_verified_at=null;}
  if(body.confirm_date===true){
    if(!normalizeInvoiceDate(h.date))throw new HttpError(400,"Correct the invalid invoice date first.");
    const check=invoiceDateReview({...inv,data:h});
    if(check.hard_mismatch)throw new HttpError(400,"This is a month-specific batch for "+
      check.month+". To post this invoice, correct its date to the selected month or upload it as regular mixed invoices.");
    h.date_verified_value=P.normDate(h.date);
    h.date_verified_at=now();
  }
  h.warnings = (h.warnings||[]).filter(w=>!/^GSTIN .* fails the checksum/.test(w));
  if (h.party_gstin && !gstinValid(h.party_gstin)) h.warnings.push(`GSTIN ${h.party_gstin} fails the checksum — check for a misread character.`);
  h.edited = true;
  const stmts = [D.updateStmt("invoices", p.iid, { data: JSON.stringify(h), tax_lines: null,
    ...(partyChanged ? { party_ledger: null, party_method: null } : {}), ...(inv.status === "error" ? { status: "review", sync_error: null } : {}) })];
  if (body.lines) {
    const existing = Object.fromEntries(inv.lines.map((l) => [l.id, l]));
    const keep = new Set();
    body.lines.forEach((l, idx) => {
      const vals = {};
      for (const k of LINE_FIELDS) if (k in l) vals[k] = NUMERIC.has(k) ? toNum(l[k]) : String(l[k] ?? "");
      if (l.id && existing[l.id]) {
        const old = existing[l.id];
        if ("description" in vals && vals.description !== old.description && old.kind === "item") vals.stock_state = "suspense";
        stmts.push(D.updateStmt("lines", l.id, { idx, ...vals }));
        keep.add(l.id);
      } else stmts.push(D.insertStmt("lines", P.lineRow(p.iid, idx, vals.kind || "item", vals)));
    });
    for (const id of Object.keys(existing)) if (!keep.has(id)) stmts.push(D.stmt("DELETE FROM lines WHERE id=?", id));
  }
  await D.batch(stmts);
  await D.log("Edited invoice details", { invoice_id: p.iid, batch_id: inv.batch_id });
  await P.autoMatch(D, p.iid, true);
  return json(await invoiceFull(D, p.iid));
});
route("POST", "/api/invoices/:iid/:action", async ({ env, D, p, url }) => {
  const inv = must(await P.loadInvoice(D, p.iid));
  if (p.action === "push") { await requirePosting(env); await P.pushInvoice(D, p.iid, url.searchParams.get("force") === "1"); }
  else if (p.action === "mark-synced") { await D.update("invoices", p.iid, { status: "synced", synced_at: now(), sync_error: null }); await D.log("Marked as synced by you", { invoice_id: p.iid }); }
  else if (p.action === "back-to-review") { await D.run("DELETE FROM jobs WHERE invoice_id=? AND status='pending'", p.iid); await D.update("invoices", p.iid, { status: "review" }); await D.log("Sent back to review", { invoice_id: p.iid }); }
  else if (p.action === "calculate-tax") await P.calculateTax(D, p.iid);
  else if (p.action === "reread") { await D.update("invoices", p.iid, { status: "pending", attempts: 0, sync_error: null }); await D.update("batches", inv.batch_id, { stage: "read" }); }
  else throw new HttpError(400, "unknown action");
  return json({ ok: true });
});
route("GET", "/api/invoices/:iid/xml", async ({ D, p }) => {
  const inv = must(await P.loadInvoice(D, p.iid));
  if (!inv.steps.ready) throw new HttpError(400, "Not ready yet");
  return new Response(await P.buildVoucherXml(D, inv), { headers: { "content-type": "application/xml", "content-disposition": `attachment; filename="voucher-${inv.data.number || p.iid.slice(0, 8)}.xml"` } });
}, { post: true });

// bank statements: one statement credit each (counted by the service; needs the internet at that moment)
async function useStatementCredit(env, D, st, lines) {
  if (!env.LIC) return;
  const c = await D.first("SELECT id, name, gstin FROM companies WHERE id=?", st.company_id);
  try { await env.LIC.call("/api/lic/use/statement", { company: c, name: st.name, lines }); }
  catch (e) {
    if (e.offline) throw new HttpError(503, "Saving a statement uses one statement credit, which needs an internet connection. Try again when online.");
    throw new HttpError(e.status || 503, e.message);
  }
}
BK.bankRoutes(route, { useCredit: useStatementCredit, requirePosting, authorizeCompany });
EC.ecommerceRoutes(route, { requirePosting, requireLicence });
// GSTR-2B reconciliation
GS.gstRoutes(route);
G2BP.purchase2bRoutes(route,{authorizeCompany,requirePosting});
SC.smartRoutes(route,authorizeCompany);
DASH.dashboardRoutes(route,requireLicence,authorizeCompany);
AW.accountingRoutes(route,authorizeCompany);
SET.settlementRoutes(route,authorizeCompany);
GC.gstControlRoutes(route,authorizeCompany);
// Read-only local recovery diagnostics: never exposes licence keys, raw bank data or invoice images.
route("GET","/api/diagnostics",async({env,D})=>{
  let database="unknown";
  try{
    const r=env.DB?.sql?.prepare("PRAGMA quick_check")?.get();
    database=Object.values(r||{})[0]==="ok"?"ok":"integrity warning";
  }catch(e){database="error: "+String(e.message).slice(0,150);}
  const [[pending],[uncertain],[failed]]=await D.many([
    ["SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','sent')"],
    ["SELECT COUNT(*) n FROM bank_lines WHERE status='uncertain'"],
    ["SELECT COUNT(*) n FROM jobs WHERE status='failed'"]
  ]);
  let back;
  try{back=JSON.parse(env.getConfig?.("backup_last")||"null");}catch{}
  const last=back?.checked?"Verified "+new Date(back.at*1000).toISOString():back?.error?"Backup error: "+back.error:"No recent backup status";
  return json({version:env.VERSION||"dev",database,
    tally_status:env.TALLY?.state?.status||"unknown",tally_detail:env.TALLY?.state?.detail||"",
    jobs:{pending:pending?.n||0,uncertain:uncertain?.n||0,failed:failed?.n||0},
    backup_status:last});
});

// ------------------------------------------------------------------ entry
async function handleApi(req, env, url) {
  const D = db(env);
  TALLY = env.TALLY || null;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    if (!r.open) requireWindow(env, req, url);
    if (!r.open && !r.keyed) await requireLicence(env);
    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") { try { body = await req.json(); } catch { body = {}; } }
    if (r.post || (r.createPosts && body.create)) await requirePosting(env);
    const res = await r.fn({ env, D, req, url, p: m.groups || {}, body });
    if (r.wakes && env.wakeReader) env.wakeReader();
    return res;
  }
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(req, env, url); }
      catch (e) {
        const status = e.status || 500;
        if (status === 500) (env.log || console.error)(e.stack || e);
        return json({ error: e.message || String(e), code: e.code || undefined }, status);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
