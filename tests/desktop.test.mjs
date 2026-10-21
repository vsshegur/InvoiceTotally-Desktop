// The whole app as it runs on a PC: desktop/main.mjs (real process) + the service (service/licence.js on SQLite,
// stand-in Google and AI) + a fake TallyPrime. Covers sign-in, admin limits and credits, reading, posting to Tally,
// bank statements to a suspense ledger, and the posting / company-limit rules.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { fakeService } from "./fake-service.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting for " + what); await sleep(150); }
}

const ADMIN = "vipulshegur@gmail.com", USER = "ramesh@example.com";
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const KEY = "k".repeat(40);
let tally, app, svc, base, svcUrl, dataDir, tallyPort;

async function startApp() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, [path.join(here, "..", "desktop", "main.mjs")], {
    env: { ...process.env, IT_PORT: String(port), IT_DATA_DIR: dataDir, IT_SERVICE: svcUrl, TALLY_URL: `http://127.0.0.1:${tallyPort}`, IT_WINDOW_KEY: KEY, EXTRACTOR: "" },
    stdio: ["ignore", "inherit", "inherit"] });
  await until(() => fetch(base + "/api/health").then((r) => r.ok).catch(() => false), 10000, "app start");
}
async function call(method, p, body, key = KEY) {
  const r = await fetch(base + "/api" + p, { method, headers: { "content-type": "application/json", ...(key ? { "x-it-key": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { text }; }
  return Array.isArray(j) ? Object.assign(j, { status: r.status }) : { status: r.status, ...j };
}
async function signIn(email) {
  const s = await call("POST", "/signin/start", {});
  assert.match(s.url, /\/lic\/signin\?n=/);
  assert.equal((await call("POST", "/signin/poll", {})).pending, true, "waits for the browser");
  const g = await svc.signIn(svcUrl, s.nonce, email);
  if (g.status !== 200) return g;
  const done = await call("POST", "/signin/poll", {});
  assert.equal(done.ok, true);
  return call("GET", "/me");
}
const JPEG = "/9j/" + "A".repeat(400);

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "itd-"));
  tallyPort = await freePort();
  tally = spawn(PY, [path.join(here, "mock_tally.py"), String(tallyPort)], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, MOCK_COMPANIES: "VIPUL TEXTILES,Ramesh Traders" } });
  svc = fakeService({ admin: ADMIN });
  svcUrl = await svc.listen();
  await startApp();
});
test.after(() => { app?.kill(); tally?.kill(); svc?.close(); });

test("only the app window can use the API", async () => {
  assert.equal((await call("GET", "/me", null, null)).status, 401);
  assert.equal((await call("GET", "/me", null, "wrong")).status, 401);
  const status = await new Promise((res) => http.get(base + "/api/me", { headers: { host: "evil.example", "x-it-key": KEY } }, (r) => { r.resume(); res(r.statusCode); }));
  assert.equal(status, 421, "other host names are refused (DNS rebinding)");
  const me = await call("GET", "/me");
  assert.equal(me.signed_in, false);
  assert.equal((await call("GET", "/companies")).status, 401, "nothing works before signing in");
});

test("someone the admin has not added cannot sign in", async () => {
  const g = await signIn(USER);
  assert.equal(g.status, 403);
  assert.match(g.error, /not been added/);
});

let cid;
test("admin: signs in, adds a user with limits and credits, sets up a company from Tally", async () => {
  const me = await signIn(ADMIN);
  assert.equal(me.licence.admin, true);
  assert.equal(me.licence.can_post, true);
  assert.deepEqual(me.licence.ai_options, ["gemini_lite", "gemini", "groq", "claude"]);

  const u = await call("POST", "/admin/save-user", { email: USER, name: "Ramesh", company_limit: 1, can_post: false, ai_options: ["groq"] });
  assert.equal(u.ok, true, JSON.stringify(u));
  const cr = await call("POST", "/admin/add-credits", { email: USER, invoice: 2, statement: 1, note: "Paid ₹500 by UPI" });
  assert.deepEqual([cr.user.invoice_credits, cr.user.statement_credits], [2, 1]);
  const list = await call("POST", "/admin/users", {});
  assert.equal(list.users.find((x) => x.email === USER).company_limit, 1);
  assert.deepEqual(list.ai, { gemini_lite: true, gemini: false, groq: true, claude: true });

  const c = await call("POST", "/companies", { name: "Vipul Textiles", tally_company: "VIPUL TEXTILES", gstin: "27ACKPS3168H1Z6" });
  cid = c.id;
  assert.equal(c.settings.ai, "gemini_lite");
  assert.deepEqual(c.settings.ai_order, ["gemini_lite", "groq", "gemini", "claude"], "every AI, free ones first");
  await call("POST", `/companies/${cid}/import-masters`, {});
  const view = await until(async () => { const v = await call("GET", `/companies/${cid}`); return v.masters.ledger > 0 && v.masters.stock_item > 0 && v.pending_jobs === 0 && v; }, 15000, "masters");
  assert.equal(view.tally_online, true);
  assert.equal(view.company_open, true);
  assert.ok(view.masters.ledger >= 14);
});

test("admin: an invoice is read through the service and posted straight to Tally", async () => {
  const b = await call("POST", `/companies/${cid}/batches`, { voucher_type: "Purchase", files: [{ filename: "bill.pdf", pages: 1 }] });
  await call("POST", `/files/${b.files[0].id}/pages`, { idx: 0, image_b64: JPEG });
  await call("POST", `/batches/${b.id}/start`, {});
  const batch = await until(async () => { const x = await call("GET", `/batches/${b.id}`); return x.stage === "review" && x; }, 15000, "reading");
  assert.equal(batch.invoices.length, 1);
  assert.equal(svc.calls.at(-1).ai, "gemini_lite", "the company's AI choice is used");
  assert.deepEqual(svc.calls.at(-1).order, ["gemini_lite", "groq", "gemini", "claude"], "the whole priority list goes to the service");
  // review: the two lines are mapped to stock items once (remembered next time), the purchase ledger picked
  const stock = await call("GET", `/batches/${b.id}/review/stock`);
  const item = { "3060 WHITE 20 DOZ": "3060 ONKAR WHITE CRAPE", "11*11 WHITE 320 DOZ": "1212 ASHOKA" };
  for (const g of stock.items) assert.equal((await call("POST", `/batches/${b.id}/stock`, { line_ids: g.line_ids, stock_item: item[g.description] })).ok, true);
  for (const g of (await call("GET", `/batches/${b.id}/review/ledger`)).items)
    if (g.ledger_state !== "resolved") await call("POST", `/batches/${b.id}/ledger`, { line_ids: g.line_ids, ledger: "GST PURCHASE" });
  await call("POST", `/batches/${b.id}/calculate-tax`, {});
  const inv = (await call("GET", `/batches/${b.id}`)).invoices[0];
  assert.equal(inv.steps.ready, true, JSON.stringify(inv.steps));
  const pushed = await call("POST", `/batches/${b.id}/push`, {});
  assert.equal(pushed.pushed, 1);
  const done = await until(async () => { const x = await call("GET", `/invoices/${inv.id}`); return x.status !== "queued" && x; }, 15000, "posting");
  assert.equal(done.status, "synced", done.sync_error);
});

test("admin: the AIs are put in a new order; the service gets that order", async () => {
  const c = await call("PATCH", `/companies/${cid}`, { settings: { ai_order: ["claude", "gemini", "claude"] } });
  assert.deepEqual([c.settings.ai, c.settings.ai_order], ["claude", ["claude", "gemini"]]);
  assert.equal((await call("PATCH", `/companies/${cid}`, { settings: { ai_order: [] } })).status, 400, "at least one AI");
  assert.equal((await call("PATCH", `/companies/${cid}`, { settings: { ai_order: ["chatgpt"] } })).status, 400);
  const b = await call("POST", `/companies/${cid}/batches`, { voucher_type: "Purchase", files: [{ filename: "bill2.pdf", pages: 1 }] });
  await call("POST", `/files/${b.files[0].id}/pages`, { idx: 0, image_b64: JPEG });
  await call("POST", `/batches/${b.id}/start`, {});
  await until(async () => (await call("GET", `/batches/${b.id}`)).stage === "review", 15000, "reading");
  assert.deepEqual([svc.calls.at(-1).ai, svc.calls.at(-1).order], ["claude", ["claude", "gemini"]]);
  await call("DELETE", `/batches/${b.id}`);
  // choosing just one AI the old way puts it first and keeps the rest of the list
  const c2 = await call("PATCH", `/companies/${cid}`, { settings: { ai: "gemini_lite" } });
  assert.deepEqual(c2.settings.ai_order, ["gemini_lite", "claude", "gemini"]);
});

test("admin: a bank statement goes to the suspense ledger as receipts and payments, never twice", async () => {
  const rows = [
    { date: "2026-10-01", narration: "NEFT-SHREE GANESH TRADERS-INV 44", ref: "N123", debit: 0, credit: 5000, balance: 15000, ok: true },
    { date: "2026-10-02", narration: "UPI/ramesh@okaxis/Packing", ref: "", debit: 1200, credit: 0, balance: 13800, ok: true },
  ];
  const s = await call("POST", `/companies/${cid}/bank`, { bank_ledger: "HDFC Bank 1234", suspense_ledger: "Suspense A/c", filename: "oct.xlsx", source: "excel" });
  await call("POST", `/bank/${s.id}/rows`, { rows, part: 0 });
  assert.equal((await call("POST", `/bank/${s.id}/start`, {})).ok, true);
  let v = await call("GET", `/bank/${s.id}`);
  assert.equal(v.stage, "review");
  assert.deepEqual(v.lines.map((l) => [l.vtype, l.ledger, l.status]), [["Receipt", "Suspense A/c", "ready"], ["Payment", "Suspense A/c", "ready"]]);
  assert.equal(v.lines[0].tally_narration, "NEFT-SHREE GANESH TRADERS-INV 44 | Ref/Chq: N123");
  assert.equal((await call("POST", `/bank/${s.id}/push`, {})).queued, 2);
  v = await until(async () => { const x = await call("GET", `/bank/${s.id}`); return x.lines.every((l) => l.status === "synced") && x; }, 15000, "bank posting");

  // the same statement again (or an overlapping one): already posted, so nothing is ready
  const s2 = await call("POST", `/companies/${cid}/bank`, { bank_ledger: "HDFC Bank 1234", suspense_ledger: "Suspense A/c", filename: "oct-again.xlsx", source: "excel" });
  await call("POST", `/bank/${s2.id}/rows`, { rows: [...rows, { date: "2026-10-03", narration: "SMS CHARGES", debit: 17.7, credit: 0, balance: 13782.3, ok: true }] });
  await call("POST", `/bank/${s2.id}/start`, {});
  const v2 = await call("GET", `/bank/${s2.id}`);
  assert.deepEqual(v2.lines.map((l) => l.status), ["duplicate", "duplicate", "ready"]);
  assert.equal((await call("POST", `/bank/${s2.id}/push`, {})).queued, 1);
});

test("admin: offline Meesho and Flipkart Excel summaries go directly into Tally with safe duplicate blocking", async () => {
  const h = ["GSTIN","HSN Code","Quantity","GST Rate","Total Taxable Sale Value","End Customer State",
    "Eco TCS GSTIN","Financial Year","Month Number"];
  const g = "27ACKPS3168H1Z6";
  const f = (name,rows,sheet="Sheet1") => ({ name,sheets:[{name:sheet,rows}] });
  const files = { sales:f("sales.xlsx",[h,[g,"630260",10,5,1000,"Maharashtra","",2026,9]]),
    returns:f("returns.xlsx",[h,[g,"630260",2,5,200,"Maharashtra","",2026,9]]) };
  const created = await call("POST", "/companies/" + cid + "/ecommerce/prepare", {platform:"ME",year:2026,month:9,files});
  assert.equal(created.vouchers,1);
  let batch = await call("GET","/ecommerce/"+created.id);
  assert.deepEqual([batch.summary.taxable,batch.summary.invoice],[800,840]);
  assert.equal(batch.vouchers[0].vtype,"Sales");
  await call("POST","/ecommerce/"+created.id+"/mapping",{party:"ABCABC",sales:"GST SALES",
    cgst:"CGST",sgst:"SGST",igst:"IGST",round:"ROUND OFF SALES ACCOUNT",mode:"accounting"});
  assert.equal((await call("POST","/ecommerce/"+created.id+"/post",{})).queued,1);
  batch=await until(async()=>{
    const v=await call("GET","/ecommerce/"+created.id);
    return v.vouchers[0].status !== "queued" && v;
  },15000,"Meesho offline Tally post");
  assert.equal(batch.vouchers[0].status,"synced",batch.vouchers[0].error||"");
  assert.equal((await call("POST","/ecommerce/"+created.id+"/post",{})).status,400,
    "already posted month cannot be queued again");
  assert.equal((await call("POST","/companies/"+cid+"/ecommerce/prepare",{platform:"ME",year:2026,month:9,files})).status,400);
  const flips = {flipkart:f("flipkart.xlsx",[["GSTIN","Aggregate Taxable Value","CGST"],[g,700,2.5]],
    "Section 7(A)(2) in GSTR-1")};
  const flip=await call("POST","/companies/"+cid+"/ecommerce/prepare",{platform:"FL",year:2026,month:9,files:flips});
  await call("POST","/ecommerce/"+flip.id+"/mapping",{party:"ABCABC",sales:"GST SALES",
    cgst:"CGST",sgst:"SGST",igst:"IGST",round:"ROUND OFF SALES ACCOUNT",mode:"accounting"});
  assert.equal((await call("POST","/ecommerce/"+flip.id+"/post",{})).queued,1);
  const posted=await until(async()=>{
    const v=await call("GET","/ecommerce/"+flip.id);
    return v.vouchers[0].status !== "queued" && v;
  },15000,"Flipkart offline Tally post");
  assert.equal(posted.vouchers[0].status,"synced",posted.vouchers[0].error||"");
});

test("admin: GST control, multi-company balances, smart mapping and audited posting work over localhost",async()=>{
  const dashboard=await call("GET","/dashboard");
  assert.ok(dashboard.companies.some(x=>x.id===cid));
  const refresh=await call("POST","/dashboard/refresh/"+cid,{});
  assert.equal(refresh.ok,true);
  assert.ok(refresh.ledgers>5);
  const after=await call("GET","/dashboard");
  assert.ok(after.companies.find(x=>x.id===cid).balances.bank>0);

  const period="2026-09";
  assert.equal((await call("POST","/companies/"+cid+"/gst-control/"+period+"/portal",{
    kind:"gstr1",summary:{taxable:1000,igst:0,cgst:25,sgst:25,cess:0}
  })).ok,true);
  assert.equal((await call("POST","/companies/"+cid+"/gst-control/"+period+"/portal",{
    kind:"gstr3b",summary:{taxable:1000,igst:0,cgst:25,sgst:25,cess:0,itcIgst:0,itcCgst:0,itcSgst:0,itcCess:0}
  })).ok,true);
  const tally=await call("POST","/companies/"+cid+"/gst-control/"+period+"/refresh",{});
  assert.equal(tally.ok,true);
  assert.equal(tally.sales.taxable,1000);
  const checked=await call("POST","/companies/"+cid+"/gst-control/"+period+"/reconcile",{});
  assert.equal(checked.result.salesToPortal.cgst.status,"matched");
  assert.equal(checked.result.portalTo3b.sgst.status,"matched");
  assert.match(checked.result.warnings.join(" "),/GSTR-2B/);
  const mappings=await call("GET","/companies/"+cid+"/smart-maps");
  assert.ok(Array.isArray(mappings.pending));
  const alias=await call("GET","/companies/"+cid+"/smart-maps/export");
  assert.ok(Array.isArray(alias.mappings));

  const audit=await call("GET","/companies/"+cid+"/posting-audit");
  assert.equal(audit.integrity.ok,true);
  assert.ok(audit.rows.some(x=>x.phase==="attempt"));
  assert.ok(audit.rows.some(x=>x.phase==="created"));
  const backup=await call("POST","/backup",{});
  assert.ok(backup.file,backup.error||"");
  const backups=await call("GET","/backups");
  assert.ok(backups.backups.some(x=>x.valid&&!x.encrypted));
});

test("user: own companies, company limit, credits counted, posting blocked", async () => {
  await call("POST", "/signout", {});
  assert.equal((await call("GET", "/me")).signed_in, false);
  const me = await signIn(USER);
  assert.deepEqual([me.licence.admin, me.licence.can_post, me.licence.company_limit, me.licence.invoice_credits], [false, false, 1, 2]);
  assert.deepEqual(me.licence.ai_options, ["groq"]);
  assert.equal((await call("GET","/companies/"+cid+"/smart-maps")).status,403,
    "other users cannot see private company ledger mappings");
  assert.equal((await call("GET","/companies/"+cid+"/gst-control/2026-09")).status,403,
    "other users cannot inspect private GST reconciliation");
  assert.equal((await call("GET", "/companies")).length, 0, "the admin's company is not shown to this account");

  const c = await call("POST", "/companies", { name: "Ramesh Traders" });
  assert.equal(c.settings.ai, "groq");
  const c2 = await call("POST", "/companies", { name: "Second Co" });
  assert.equal(c2.status, 403);
  assert.match(c2.error, /allows 1 company/);
  assert.equal((await call("PATCH", `/companies/${c.id}`, { settings: { ai: "claude" } })).status, 400, "only the AI the admin allowed");
  assert.deepEqual(c.settings.ai_order, ["groq"]);
  const bad = await call("PATCH", `/companies/${c.id}`, { settings: { ai_order: ["groq", "claude"] } });
  assert.equal(bad.status, 400);
  assert.match(bad.error, /Claude is not available for your account/);

  const b = await call("POST", `/companies/${c.id}/batches`, { voucher_type: "Purchase", files: [{ filename: "a.pdf", pages: 1 }] });
  await call("POST", `/files/${b.files[0].id}/pages`, { idx: 0, image_b64: JPEG });
  await call("POST", `/batches/${b.id}/start`, {});
  await until(async () => (await call("GET", `/batches/${b.id}`)).stage === "review", 15000, "reading");
  assert.equal(svc.calls.at(-1).ai, "groq");
  const after = await call("GET", "/me");
  assert.equal(after.licence.invoice_credits, 1, "one credit used");

  assert.equal((await call("POST", `/batches/${b.id}/push`, {})).status, 403, "posting not allowed");
  const iid = (await call("GET", `/batches/${b.id}`)).invoices[0].id;
  assert.equal((await call("POST", `/invoices/${iid}/push`, {})).code, "noposting");
  assert.equal((await call("GET", `/invoices/${iid}/xml?k=${KEY}`)).status, 403);

  // statements: one credit each, then none left
  const rows = [{ date: "2026-10-05", narration: "CASH DEP", debit: 0, credit: 100, balance: 100, ok: true }];
  const s = await call("POST", `/companies/${c.id}/bank`, { bank_ledger: "HDFC Bank 1234", suspense_ledger: "Suspense A/c", filename: "a.csv", source: "excel" });
  await call("POST", `/bank/${s.id}/rows`, { rows });
  assert.equal((await call("POST", `/bank/${s.id}/start`, {})).ok, true);
  const s2 = await call("POST", `/companies/${c.id}/bank`, { bank_ledger: "HDFC Bank 1234", suspense_ledger: "Suspense A/c", filename: "b.csv", source: "excel" });
  await call("POST", `/bank/${s2.id}/rows`, { rows: [{ ...rows[0], date: "2026-10-06" }] });
  const no = await call("POST", `/bank/${s2.id}/start`, {});
  assert.equal(no.status, 402);
  assert.match(no.error, /No statement credits left/);
});

test("admin switches the user off: every PC is signed out", async () => {
  await call("POST", "/signout", {});
  await signIn(ADMIN);
  await call("POST", "/admin/save-user", { email: USER, active: false });
  await call("POST", "/signout", {});
  const g = await signIn(USER);
  assert.equal(g.status, 403);
});

test("Tally closed: posts wait, and go through once Tally is back", async () => {
  await signIn(ADMIN);
  tally.kill();
  await sleep(300);
  await call("POST", "/tally/check", {});
  const s = await call("POST", `/companies/${cid}/bank`, { bank_ledger: "HDFC Bank 1234", suspense_ledger: "Suspense A/c", filename: "nov.csv", source: "excel" });
  await call("POST", `/bank/${s.id}/rows`, { rows: [{ date: "2026-11-01", narration: "INTEREST", debit: 0, credit: 42, balance: null }] });
  await call("POST", `/bank/${s.id}/start`, {});
  await call("POST", `/bank/${s.id}/push`, {});
  const jobs = await until(async () => { const j = await call("GET", `/companies/${cid}/jobs`); return j[0].result && j; }, 10000, "the post to wait");
  assert.equal(jobs[0].status, "pending");
  assert.match(jobs[0].result, /Waiting for Tally/);
  assert.equal((await call("GET", "/me")).tally.status, "down");
  tally = spawn(PY, [path.join(here, "mock_tally.py"), String(tallyPort)], { stdio: "ignore", env: { ...process.env, MOCK_COMPANIES: "VIPUL TEXTILES" } });
  await until(async () => (await call("GET", `/bank/${s.id}`)).lines[0].status === "synced", 20000, "posting after Tally came back");
});
