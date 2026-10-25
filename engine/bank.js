// Bank statements, the simple way: the statement is read on this PC without any AI (Excel, CSV, or a PDF downloaded
// from net banking), every transaction is posted against one suspense ledger you choose — money in as a Receipt,
// money out as a Payment — with the bank's narration and reference. You then move each entry from Suspense to the
// right ledger in Tally, as usual. A transaction already posted from an earlier statement is never posted twice.
import { newId, now, jload } from "./db.js";
import * as T from "./tally.js";
import * as TL from "../desktop/tally.mjs";
import * as M from "./matching.js";
import {narrationKey} from "../public/bankparse.js";
import { getCompany } from "./pipeline.js";

export class BankError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const must = (row, msg = "Not found") => { if (!row) throw new BankError(404, msg); return row; };
const inList = (ids) => ids.map(() => "?").join(",");
const r2 = (x) => Math.round(x * 100) / 100;
const cleanRow = (r) => ({
  date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? r.date : null,
  narration: String(r.narration || "").replace(/\s+/g, " ").trim().slice(0, 500),
  ref: String(r.ref || "").trim().slice(0, 60),
  debit: r2(Math.abs(+r.debit || 0)), credit: r2(Math.abs(+r.credit || 0)),
  balance: r.balance == null || r.balance === "" || isNaN(+r.balance) ? null : r2(+r.balance),
  check_ok: r.ok === true ? 1 : r.ok === false ? 0 : null,
});
/** Same bank account, date, amount and narration = the same transaction. */
export const txnKey = (bank, x) => [String(bank).toUpperCase(), x.date, x.credit ? "C" : "D", (x.credit || x.debit).toFixed(2),
  String(x.narration || "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 80), String(x.ref || "").toUpperCase().replace(/\s+/g, "")].join("|");

/** What goes into Tally's narration: the bank's own text and reference. */
export function narrationOf(l) {
  const parts = [l.narration];
  if (l.ref && !String(l.narration || "").includes(l.ref)) parts.push(`Ref/Chq: ${l.ref}`);
  return parts.filter(Boolean).join(" | ");
}

async function statement(D, sid) { return must(await D.first("SELECT * FROM bank_statements WHERE id=?", sid), "Statement not found"); }

// ------------------------------------------------------------------ create
export async function create(D, cid, body) {
  must(await D.first("SELECT id FROM companies WHERE id=?", cid), "Company not found");
  const bank = String(body.bank_ledger || "").trim(), suspense = String(body.suspense_ledger || "").trim();
  if (!bank) throw new BankError(400, "Choose the bank ledger this statement belongs to");
  if (!suspense) throw new BankError(400, "Choose the suspense ledger the entries go to");
  if (bank.toLowerCase() === suspense.toLowerCase()) throw new BankError(400, "The suspense ledger must be different from the bank ledger");
  const id = newId();
  const name = String(body.filename || "Statement").slice(0, 120);
  await D.insert("bank_statements", { id, company_id: cid, name, bank_ledger: bank, suspense_ledger: suspense, filename: name,
    source: ["excel", "pdf"].includes(body.source) ? body.source : "pdf", stage: "uploading",
    opening: body.opening ?? null, closing: body.closing ?? null, created_at: now() });
  return { id };
}

export async function addRows(D, sid, body) {
  const st = await statement(D, sid);
  if (st.stage !== "uploading") throw new BankError(400, "Statement already saved");
  const rows = (body.rows || []).slice(0, 1000);
  const base = (+body.part || 0) * 1000;
  const stmts = [];
  rows.forEach((r, i) => {
    const x = cleanRow(r);
    if (!x.date || (!x.debit && !x.credit)) return;
    stmts.push(D.insertStmt("bank_lines", { id: newId(), statement_id: sid, company_id: st.company_id, seq: base + i, ...x,
      status: "ready", vtype: x.credit ? "Receipt" : "Payment", ledger: st.suspense_ledger, key: txnKey(st.bank_ledger, x) }));
  });
  for (let i = 0; i < stmts.length; i += 90) await D.batch(stmts.slice(i, i + 90));
  return { ok: true, stored: stmts.length };
}

/** All rows are in: mark the ones already posted from an earlier statement, and open the statement for review. */
export async function finish(D, sid) {
  const st = await statement(D, sid);
  const lines = await D.all("SELECT id, key, date, check_ok FROM bank_lines WHERE statement_id=? ORDER BY seq", sid);
  if (!lines.length) { await D.update("bank_statements", sid, { stage: "error", error: "No transactions were found" }); return; }
  const keys = [...new Set(lines.map((l) => l.key))];
  const seen = new Set();
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    for (const r of await D.all(`SELECT key FROM bank_lines WHERE company_id=? AND statement_id<>? AND status IN ('queued','synced','ready','failed','duplicate')
      AND key IN (${inList(part)})`, st.company_id, sid, ...part)) seen.add(r.key);
  }
  const dup = lines.filter((l) => seen.has(l.key)).map((l) => l.id);
  const stmts = [];
  for (let i = 0; i < dup.length; i += 200) {
    const part = dup.slice(i, i + 200);
    stmts.push(D.stmt(`UPDATE bank_lines SET status='duplicate', note='Already in an earlier statement' WHERE id IN (${inList(part)})`, ...part));
  }
  const dates = lines.map((l) => l.date).sort();
  const checked = lines.filter((l) => l.check_ok != null).length, bad = lines.filter((l) => l.check_ok === 0).length;
  stmts.push(D.updateStmt("bank_statements", sid, { stage: "review", error: null, period_from: dates[0], period_to: dates[dates.length - 1], checked, bad }));
  await D.batch(stmts);
}

// ------------------------------------------------------------------ views
const STATUS_LABEL = { ready: "Ready", ignored: "Left out", duplicate: "Already posted earlier", queued: "Sending to Tally", synced: "In Tally", failed: "Tally rejected it" };

export async function list(D, cid) {
  const [rows, counts] = await D.many([
    ["SELECT id, name, bank_ledger, suspense_ledger, stage, error, period_from, period_to, bad, checked, created_at FROM bank_statements WHERE company_id=? ORDER BY created_at DESC LIMIT 100", cid],
    ["SELECT statement_id, status, count(*) n FROM bank_lines WHERE company_id=? GROUP BY statement_id, status", cid]]);
  for (const s of rows) {
    s.counts = {};
    for (const c of counts) if (c.statement_id === s.id) s.counts[c.status] = c.n;
    s.lines = Object.values(s.counts).reduce((a, n) => a + n, 0);
  }
  return rows;
}

export async function view(D, sid) {
  const st = await statement(D, sid);
  const [lines, jobs] = await D.many([
    ["SELECT id, seq, date, narration, ref, debit, credit, balance, check_ok, status, vtype, ledger, note, sync_error, synced_at FROM bank_lines WHERE statement_id=? ORDER BY seq", sid],
    ["SELECT j.status, count(*) n FROM jobs j JOIN bank_lines l ON l.id=j.invoice_id WHERE j.kind='import_bank' AND l.statement_id=? GROUP BY j.status", sid]]);
  for (const l of lines) { l.state = STATUS_LABEL[l.status] || l.status; l.tally_narration = narrationOf(l); }
  const totals = { in: r2(lines.reduce((s, l) => s + l.credit, 0)), out: r2(lines.reduce((s, l) => s + l.debit, 0)) };
  return { ...st, lines, totals, jobs: Object.fromEntries(jobs.map((j) => [j.status, j.n])) };
}

// ------------------------------------------------------------------ changes
export async function setSuspense(D, sid, body) {
  const st = await statement(D, sid);
  const ledger = String(body.suspense_ledger || "").trim();
  if (!ledger) throw new BankError(400, "Choose the suspense ledger");
  if (ledger.toLowerCase() === st.bank_ledger.toLowerCase()) throw new BankError(400, "The suspense ledger must be different from the bank ledger");
  await D.batch([D.updateStmt("bank_statements", sid, { suspense_ledger: ledger }),
    D.stmt("UPDATE bank_lines SET ledger=? WHERE statement_id=? AND status IN ('ready','ignored','duplicate','failed') AND (ledger=? OR ledger IS NULL)", ledger, sid, st.suspense_ledger)]);
  return { ok: true };
}

/** Leave rows out, or bring them back (a duplicate can be brought back on purpose). */
export async function mark(D, sid, body) {
  const ids = (body.ids || []).slice(0, 2000);
  if (!ids.length) return { ok: true, changed: 0 };
  const to = body.status === "ignored" ? "ignored" : "ready";
  const from = to === "ignored" ? "('ready','failed','duplicate')" : "('ignored','duplicate','failed')";
  let changed = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const r = await D.run(`UPDATE bank_lines SET status=?, note=NULL WHERE statement_id=? AND status IN ${from} AND id IN (${inList(part)})`, to, sid, ...part);
    changed += r.meta?.changes ?? 0;
  }
  return { ok: true, changed };
}


/** Assign one reviewed ledger to selected statement lines. No Tally write occurs here. */
export async function assignLedger(D,sid,body){
  const st=await statement(D,sid);
  const ids=[...new Set((Array.isArray(body.ids)?body.ids:[]).map(String))].slice(0,300);
  const ledger=String(body.ledger||"").trim();
  if(!ids.length||!ledger)throw new BankError(400,"Choose statement transactions and an existing Tally ledger");
  if(ledger.toUpperCase()===st.bank_ledger.toUpperCase())throw new BankError(400,"Bank and contra ledgers must not be used as a payee ledger");
  const master=await D.first("SELECT name,primary_group,parent FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND UPPER(name)=UPPER(?)",st.company_id,ledger);
  if(!master)throw new BankError(400,"Ledger was not found in the imported Tally masters");
  if(/^(bank accounts|bank od a\/c|bank occ a\/c|cash-in-hand)$/i.test(master.primary_group||master.parent||""))
    throw new BankError(400,"Bank-to-bank or cash Contra transactions require a separate reviewed workflow");
  const marks=ids.map(()=>"?").join(",");
  const lines=await D.all("SELECT id,narration,status,debit,credit FROM bank_lines WHERE statement_id=? AND id IN ("+marks+")",sid,...ids);
  if(lines.length!==ids.length || lines.some(l=>!["ready","failed"].includes(l.status)))
    throw new BankError(409,"Only ready or safely failed statement rows can be assigned. Refresh and check selections.");
  const party=/^(sundry creditors|sundry debtors)$/i.test(String(master.primary_group||master.parent||"").trim());
  if(party&&body.on_account!==true)throw new BankError(400,
    "A party ledger requires explicit On Account confirmation; automatic bill allocation is not available.");
  const statements=lines.map(l=>D.stmt("UPDATE bank_lines SET ledger=?,method='manual',confidence=100,bills='[]',note=? WHERE id=?",
    master.name,party?"Explicit On Account approval":"Reviewed ledger mapping",l.id));
  if(body.remember===true){
    for(const l of lines){
      const key=narrationKey(l.narration);
      if(!key)continue;
      statements.push(D.stmt("INSERT INTO bank_rules(company_id,bank_ledger,key,ledger,approved_at) VALUES(?,?,?,?,?) ON CONFLICT(company_id,bank_ledger,key) DO UPDATE SET ledger=excluded.ledger,approved_at=excluded.approved_at",
        st.company_id,st.bank_ledger,key,master.name,now()));
    }
  }
  await D.batch(statements);
  return {ok:true,assigned:lines.length,ledger:master.name,remembered:body.remember===true};
}

export async function suggestedLedger(D,sid){
  const st=await statement(D,sid);
  const [rows,rules]=await D.many([
    ["SELECT id,narration,ledger,status,method FROM bank_lines WHERE statement_id=? ORDER BY seq",sid],
    ["SELECT key,ledger FROM bank_rules WHERE company_id=? AND bank_ledger=?",st.company_id,st.bank_ledger]
  ]);
  const byKey=new Map(rules.map(r=>[r.key,r.ledger]));
  return {suggestions:rows.filter(r=>r.status==="ready"&&r.method!=="manual").map(r=>({
    id:r.id,key:narrationKey(r.narration),suggested:byKey.get(narrationKey(r.narration))||null,
    current:r.ledger
  })).filter(x=>x.suggested),notice:"Suggestions are based on manually approved mappings only and never applied or posted automatically."};
}

/** Extracts a plausible counterparty name from a bank narration's cleaned pattern key,
 *  e.g. narrationKey("NEFT/FLIPKART INTERNET PRIVATE LIMITED/...") → "FLIPKART INTERNET PRIVATE".
 *  Returns "" for a UPI handle or anything with no usable name text. */
function likelyPartyName(narration) {
  const m = /^(?:NEFT|RTGS|UPI|TXT):(.+)$/.exec(narrationKey(narration));
  return m && !m[1].includes("@") ? m[1] : "";
}

/** Suggested party-ledger matches per ready line, by narration text alone — never applied automatically.
 *  Receipt lines are matched against Sundry Debtors, Payment lines against Sundry Creditors. */
export async function partySuggestions(D, sid) {
  const st = await statement(D, sid);
  const rows = await D.all("SELECT id,narration,vtype FROM bank_lines WHERE statement_id=? AND status='ready'", sid);
  const out = {};
  for (const r of rows) {
    const name = likelyPartyName(r.narration);
    if (!name) continue;
    const hits = await M.partyCandidates(D, st.company_id, r.vtype === "Payment" ? "Purchase" : "Sales", name, null, 3);
    if (hits.length) out[r.id] = hits.map((h) => ({ name: h.name, score: h.score, tags: h.tags }));
  }
  return out;
}

/** Groups ready lines that share the same cleaned narration pattern (e.g. every "Cashfree" settlement),
 *  so several transactions can be assigned to one ledger in a single action via the existing /assign
 *  endpoint — grouping alone changes nothing; nothing is assigned until that call is made. */
export async function patternGroups(D, sid) {
  const st = await statement(D, sid);
  const [rows, rules] = await D.many([
    ["SELECT id,narration,debit,credit FROM bank_lines WHERE statement_id=? AND status='ready' ORDER BY seq", sid],
    ["SELECT key,ledger FROM bank_rules WHERE company_id=? AND bank_ledger=?", st.company_id, st.bank_ledger],
  ]);
  const byKey = new Map(rules.map((r) => [r.key, r.ledger]));
  const groups = new Map();
  for (const r of rows) {
    const key = narrationKey(r.narration);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, ids: [], total: 0, sample: r.narration, suggested_ledger: byKey.get(key) || null });
    const g = groups.get(key);
    g.ids.push(r.id);
    g.total = r2(g.total + (r.credit || r.debit));
  }
  return [...groups.values()].filter((g) => g.ids.length > 1).sort((a, b) => b.ids.length - a.ids.length).slice(0, 60);
}

/** Live-reads one party ledger's open bills from Tally, for allocating a single bank transaction
 *  against a real bill instead of only On Account. Read-only; nothing is written to Tally. */
export async function outstandingBills(D, env, sid, body) {
  const st = await statement(D, sid);
  const ledger = String(body.ledger || "").trim();
  if (!ledger) throw new BankError(400, "Choose a party ledger first");
  const master = await D.first("SELECT name,primary_group,parent FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND UPPER(name)=UPPER(?)", st.company_id, ledger);
  if (!master) throw new BankError(400, "Ledger was not found in the imported Tally masters");
  const group = /sundry debtors/i.test(master.primary_group || master.parent || "") ? "Sundry Debtors"
    : /sundry creditors/i.test(master.primary_group || master.parent || "") ? "Sundry Creditors" : null;
  if (!group) throw new BankError(400, "Bill-wise allocation only applies to a Sundry Debtor or Sundry Creditor ledger");
  if (!env.TALLY?.readOnly) throw new BankError(503, "Tally read-only connection is unavailable");
  const c = await getCompany(D, st.company_id);
  const xml = await env.TALLY.readOnly(T.outstandingBillsRequest(c.tally_company || c.name, group));
  const bills = TL.outstandingBillRows(xml).filter((b) => b.ledger.trim().toUpperCase() === master.name.trim().toUpperCase());
  return { ledger: master.name, bills,
    notice: "Freshly read from Tally just now. Not yet validated against a real Tally company — check a bill's amount there before relying on it." };
}

/** Allocates one ready/failed transaction against specific open bills of a party ledger; any part of the
 *  amount not covered goes On Account (bankVoucher() already builds the Agst Ref + On Account split). */
export async function allocateBills(D, sid, body) {
  const st = await statement(D, sid);
  const id = String(body.id || "");
  const ledger = String(body.ledger || "").trim();
  const bills = Array.isArray(body.bills) ? body.bills.slice(0, 40) : [];
  if (!id || !ledger) throw new BankError(400, "Choose a transaction and a party ledger");
  const line = must(await D.first("SELECT id,debit,credit,status FROM bank_lines WHERE statement_id=? AND id=?", sid, id), "Statement transaction not found");
  if (!["ready", "failed"].includes(line.status)) throw new BankError(409, "Only a ready or safely failed statement row can be allocated");
  const master = await D.first("SELECT name,primary_group,parent FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND UPPER(name)=UPPER(?)", st.company_id, ledger);
  if (!master) throw new BankError(400, "Ledger was not found in the imported Tally masters");
  if (!/^(sundry debtors|sundry creditors)$/i.test(String(master.primary_group || master.parent || "").trim()))
    throw new BankError(400, "Bill-wise allocation only applies to a Sundry Debtor or Sundry Creditor ledger");
  const amount = r2(line.credit || line.debit);
  const cleaned = [];
  let sum = 0;
  for (const b of bills) {
    const name = String(b?.name || "").trim().slice(0, 60);
    const amt = r2(Math.abs(+b?.amount || 0));
    if (!name || amt < 0.005) continue;
    cleaned.push({ name, amount: amt });
    sum = r2(sum + amt);
  }
  if (!cleaned.length) throw new BankError(400, "Allocate at least one bill, or use On Account instead");
  if (sum > amount + 0.01) throw new BankError(400, "Allocated bills add up to more than the transaction amount");
  await D.update("bank_lines", id, { ledger: master.name, method: "manual", confidence: 100, bills: JSON.stringify(cleaned),
    note: "Allocated against " + cleaned.length + " open bill" + (cleaned.length > 1 ? "s" : "") + (sum < amount - 0.004 ? "; remainder On Account" : "") });
  return { ok: true, ledger: master.name, allocated: sum, residual: r2(amount - sum) };
}

/** Post the chosen rows (default: every Ready row) to Tally: Receipt for money in, Payment for money out. */
export async function push(D, sid, body) {
  const st = await statement(D, sid);
  if (st.stage !== "review") throw new BankError(400, "The statement is not ready yet");
  const c = await getCompany(D, st.company_id);
  const masters=await D.all("SELECT name FROM masters WHERE company_id=? AND kind='ledger' AND pending=0",c.id);
  const known = new Set(masters.map(r=>r.name));
  if(!known.has(st.bank_ledger))throw new BankError(400,"The bank ledger is not available in imported Tally masters");
  let lines = await D.all("SELECT * FROM bank_lines WHERE statement_id=? AND status IN ('ready','failed') ORDER BY seq", sid);
  if (Array.isArray(body.ids) && body.ids.length) { const want = new Set(body.ids); lines = lines.filter((l) => want.has(l.id)); }
  for(const l of lines){
    const chosen=l.ledger||st.suspense_ledger;
    if(!known.has(chosen))throw new BankError(400,"Ledger "+chosen+" is not available in Tally. Import masters again.");
    if(l.check_ok===0)throw new BankError(400,"A selected bank entry has a balance mismatch. Review the source before posting.");
  }
  const tc = c.tally_company || c.name;
  let t = now();
  const stmts = [];
  for (const l of lines) {
    const chosen=l.ledger||st.suspense_ledger;
    const selected=await D.first("SELECT primary_group,parent FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND name=?",c.id,chosen);
    const party=selected&&/^(sundry creditors|sundry debtors)$/i.test(String(selected.primary_group||selected.parent||"").trim());
    if(party&&l.method!=="manual")throw new BankError(409,"Party ledger needs explicit allocation or On Account approval");
    const xml = T.bankVoucher(tc, { vtype:l.credit?"Receipt":"Payment",date:l.date,
      bankLedger:st.bank_ledger,ledger:chosen,amount:l.credit||l.debit,moneyIn:l.credit>0,
      narration:narrationOf(l),bills:party?jload(l.bills,[]):[],onAccount:!!party });
    stmts.push(D.stmt("DELETE FROM jobs WHERE invoice_id=? AND kind='import_bank' AND status='pending'", l.id));
    stmts.push(D.insertStmt("jobs", { id: newId(), company_id: c.id, kind: "import_bank", invoice_id: l.id, payload: xml, status: "pending", created_at: (t += 0.001), updated_at: t }));
    stmts.push(D.updateStmt("bank_lines", l.id, { status: "queued", sync_error: null, vtype: l.credit ? "Receipt" : "Payment", ledger: l.ledger || st.suspense_ledger }));
  }
  for (let i = 0; i < stmts.length; i += 90) await D.batch(stmts.slice(i, i + 90));
  return { queued: lines.length };
}

export async function remove(D, sid) {
  await statement(D, sid);
  // posted entries stay in Tally; only this app's copy goes (their keys go too, so a re-upload would show them as new)
  await D.batch([
    D.stmt("DELETE FROM jobs WHERE status='pending' AND kind='import_bank' AND invoice_id IN (SELECT id FROM bank_lines WHERE statement_id=?)", sid),
    D.stmt("DELETE FROM bank_lines WHERE statement_id=?", sid),
    D.stmt("DELETE FROM bank_statements WHERE id=?", sid)]);
  return { ok: true };
}

export function bankRoutes(route, { useCredit, requirePosting, authorizeCompany }) {
  const secured=(method,path,handler)=>route(method,path,async ctx=>{
    const cid=ctx.p.cid||(await DUMMY(ctx));
    if(authorizeCompany)await authorizeCompany(ctx.D,ctx.env,cid);
    return handler(ctx);
  });
  async function DUMMY(ctx){
    const st=await ctx.D.first("SELECT company_id FROM bank_statements WHERE id=?",ctx.p.sid);
    if(!st)throw new BankError(404,"Bank statement not found");
    return st.company_id;
  }
  secured("GET", "/api/companies/:cid/bank", async ({ D, p }) => json(await list(D, p.cid)));
  secured("POST", "/api/companies/:cid/bank", async ({ D, p, body }) => json(await create(D, p.cid, body)));
  secured("POST", "/api/bank/:sid/rows", async ({ D, p, body }) => json(await addRows(D, p.sid, body)));
  secured("POST", "/api/bank/:sid/start", async ({ env, D, p }) => {
    const st = await statement(D, p.sid);
    if (st.stage === "uploading") {
      const n = (await D.first("SELECT count(*) n FROM bank_lines WHERE statement_id=?", p.sid)).n;
      if (!n) throw new BankError(400, "No transactions were found in this statement");
      await useCredit(env, D, st, n); // one statement credit
      await finish(D, p.sid);
    }
    return json({ ok: true });
  });
  secured("GET", "/api/bank/:sid", async ({ D, p }) => json(await view(D, p.sid)));
  secured("GET", "/api/bank/:sid/suggestions", async ({ D, p }) => json(await suggestedLedger(D,p.sid)));
  secured("GET", "/api/bank/:sid/party-suggestions", async ({ D, p }) => json(await partySuggestions(D,p.sid)));
  secured("GET", "/api/bank/:sid/patterns", async ({ D, p }) => json(await patternGroups(D,p.sid)));
  secured("POST", "/api/bank/:sid/outstanding-bills", async ({ env, D, p, body }) => json(await outstandingBills(D,env,p.sid,body)));
  secured("POST", "/api/bank/:sid/allocate-bills", async ({ D, p, body }) => json(await allocateBills(D,p.sid,body)));
  secured("POST", "/api/bank/:sid/assign", async ({ D, p, body }) => json(await assignLedger(D,p.sid,body)));
  secured("POST", "/api/bank/:sid/suspense", async ({ D, p, body }) => json(await setSuspense(D, p.sid, body)));
  secured("POST", "/api/bank/:sid/mark", async ({ D, p, body }) => json(await mark(D, p.sid, body)));
  secured("POST", "/api/bank/:sid/push", async ({ env, D, p, body }) => { await requirePosting(env); return json(await push(D, p.sid, body)); });
  secured("DELETE", "/api/bank/:sid", async ({ D, p }) => json(await remove(D, p.sid)));
}
