// Outstanding bills (receivable and payable), read live from Tally and ready to age, filter and share.
//
// Three reads, tried in order. Each step is recorded so the screen can show exactly what Tally did:
//   A. Tally's own Bills Receivable / Bills Payable report  (bill, party, pending amount, due date, overdue days)
//   B. each Sundry Debtor / Creditor ledger's bill allocations (the older read; opening bills only on some setups)
//   C. ledger closing balances (always works; one "on account" line per party, no bill detail)
// Read-only: nothing here can post to or change Tally.
import { indiaDate } from "./invoice-period.js";
import * as T from "./tally.js";
import * as TL from "../desktop/tally.mjs";
import * as DASH from "./dashboard.js";
import { now } from "./db.js";

const json = (x) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;
const DAY = 86400000;
const SIDES = [["receivable", "Sundry Debtors"], ["payable", "Sundry Creditors"]];

async function company(D, cid) {
  const c = await D.first("SELECT id,name,tally_company FROM companies WHERE id=?", cid);
  if (!c) bad("Company not found", 404);
  return c;
}
const tallyName = (c) => c.tally_company || c.name;
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && Number.isFinite(Date.parse(s + "T00:00:00Z"));
const daysBetween = (fromIso, toIso) => {
  const a = Date.parse(fromIso + "T00:00:00Z"), b = Date.parse(toIso + "T00:00:00Z");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY) : null;
};
/** Indian financial year start (1 April) for a date. */
export function fyStart(asOf) {
  const y = +asOf.slice(0, 4), m = +asOf.slice(5, 7);
  return `${m >= 4 ? y : y - 1}-04-01`;
}
export function bucketOf(days) {
  if (days == null) return "undated";
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}
const inr = (n) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const keyOf = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Turn raw rows ({ledger,name,date,amount(+/-),due,overdue_days,credit_days}) into bills for one side.
 * Tally prints debit as negative. The side's usual direction (the one carrying most of the money) counts as
 * "owed"; the opposite direction (advances, credit/debit notes, unallocated receipts) is kept as a negative line so
 * a party's total is the true net.
 */
export function normaliseSide(rows, asOf) {
  let pos = 0, neg = 0;
  for (const r of rows) { if (r.amount >= 0) pos += r.amount; else neg += -r.amount; }
  const dominant = pos >= neg ? 1 : -1;
  return rows.map((r) => {
    const sign = r.amount >= 0 ? 1 : -1;
    const amount = r2(Math.abs(r.amount) * (sign === dominant ? 1 : -1));
    const days_old = r.date ? daysBetween(r.date, asOf) : null;
    let overdue_days = null;
    if (amount > 0) {
      if (r.due) overdue_days = Math.max(0, daysBetween(r.due, asOf) ?? 0);
      else if (r.overdue_days != null) overdue_days = Math.max(0, r.overdue_days);
      else if (days_old != null && r.credit_days != null) overdue_days = Math.max(0, days_old - r.credit_days);
    }
    const kind = amount < 0 ? "advance" : r.onaccount ? "balance" : "bill";
    return { ledger: r.ledger, name: r.name, date: r.date || "", due: r.due || "", amount, credit_days: r.credit_days ?? null,
      days_old: days_old != null ? Math.max(0, days_old) : null, overdue_days, kind,
      bucket: amount > 0 ? bucketOf(days_old != null ? Math.max(0, days_old) : null) : "advance",
      id: `${keyOf(r.ledger)}|${keyOf(r.name)}|${r.date || ""}|${i0(r)}` };
  });
}
// Two bills of one party can share a reference and date; keep their ids distinct.
const seen = new Map();
function i0(r) { const k = keyOf(r.ledger) + "|" + keyOf(r.name) + "|" + (r.date || ""); const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n; }

/** Party roll-up: totals, oldest bill, overdue amount, and the bills themselves. */
export function groupParties(bills, groupOf, phones) {
  const map = new Map();
  for (const b of bills) {
    const k = keyOf(b.ledger);
    let p = map.get(k);
    if (!p) {
      p = { ledger: b.ledger, group: groupOf(b.ledger), phone: phones.get(k) || "", total: 0, owed: 0, advances: 0, overdue: 0, count: 0, oldest_days: null, bills: [] };
      map.set(k, p);
    }
    p.bills.push(b);
    p.total = r2(p.total + b.amount);
    if (b.amount > 0) {
      p.owed = r2(p.owed + b.amount); p.count++;
      if (b.overdue_days > 0) p.overdue = r2(p.overdue + b.amount);
      if (b.days_old != null && (p.oldest_days == null || b.days_old > p.oldest_days)) p.oldest_days = b.days_old;
    } else p.advances = r2(p.advances + b.amount);
  }
  const parties = [...map.values()];
  for (const p of parties) p.bills.sort((a, b) => (b.days_old ?? -1) - (a.days_old ?? -1));
  parties.sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.ledger.localeCompare(b.ledger));
  return parties.filter((p) => Math.abs(p.total) >= 0.005 || p.count);
}

const memo = new Map();
/** A bank-statement review asks for the same company's bills once per transaction; a minute-old answer is fine for that. */
export async function readOutstandingCached(D, env, cid, ttlMs = 60_000) {
  const hit = memo.get(cid);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await readOutstanding(D, env, cid);
  memo.set(cid, { at: Date.now(), value });
  return value;
}
export function forgetOutstanding(cid) { memo.delete(cid); }

export async function readOutstanding(D, env, cid, opts = {}) {
  const c = await company(D, cid);
  const read = env.TALLY?.readOnly;
  if (!read) bad("Tally read-only connection is unavailable", 503);
  const asOf = validDate(opts.asOf) ? opts.asOf : indiaDate();
  const name = tallyName(c);
  const diag = [];
  const step = async (label, fn) => {
    const t0 = Date.now();
    try { const v = await fn(); diag.push({ step: label, ok: true, detail: v.detail, ms: Date.now() - t0 }); return v.value; }
    catch (e) { diag.push({ step: label, ok: false, detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 }); return null; }
  };

  // Ledger balances: the cross-check, and the last-resort source.
  const balances = (await step("Ledger closing balances", async () => {
    const rows = DASH.parseBalances(await read(DASH.balancesRequest(name)));
    return { value: rows, detail: `${rows.length} ledgers` };
  })) || [];
  const partyLedgers = { receivable: new Set(), payable: new Set() };
  const balanceOf = new Map();
  for (const b of balances) {
    const g = keyOf(b.parent);
    const side = g === "sundry debtors" ? "receivable" : g === "sundry creditors" ? "payable" : "";
    if (side) { partyLedgers[side].add(keyOf(b.name)); balanceOf.set(keyOf(b.name), { side, amount: b.amount }); }
  }

  const raw = { receivable: [], payable: [] };
  let source = "";
  // A. the Bills Receivable / Payable reports
  const fromA = { receivable: [], payable: [] };
  for (const [side] of SIDES) {
    const rows = await step(side === "receivable" ? "Bills Receivable report" : "Bills Payable report", async () => {
      const reply = await read(T.billsReportRequest(name, side, asOf, fyStart(asOf)));
      const out = TL.billsReportRows(reply);
      return { value: out, detail: `${out.length} pending bills` };
    });
    if (rows) fromA[side] = rows;
  }
  if (fromA.receivable.length || fromA.payable.length) { Object.assign(raw, fromA); source = "report"; }

  // B. bill allocations on each ledger
  if (!source) {
    for (const [side, group] of SIDES) {
      const rows = await step(`${group} bill allocations`, async () => {
        const out = TL.outstandingBillRows(await read(T.outstandingBillsRequest(name, group)));
        return { value: out, detail: `${out.length} bills` };
      });
      // This read has no debit/credit sign; every bill counts in the side's own direction.
      if (rows) raw[side] = rows.map((r) => ({ ...r, amount: r.amount }));
    }
    if (raw.receivable.length || raw.payable.length) source = "ledger-bills";
  }

  // C. one line per party from the closing balance
  if (!source && balances.length) {
    for (const b of balances) {
      const info = balanceOf.get(keyOf(b.name));
      if (!info || Math.abs(b.amount) < 0.005) continue;
      raw[info.side].push({ ledger: b.name, name: "Balance on account", date: "", amount: b.amount, onaccount: true });
    }
    source = "balances";
  }

  const masters = await D.all("SELECT name,parent FROM masters WHERE company_id=? AND kind='ledger'", cid);
  const parentOf = new Map(masters.map((m) => [keyOf(m.name), m.parent || ""]));
  const contacts = await D.all("SELECT ledger,phone FROM party_contacts WHERE company_id=?", cid);
  const phones = new Map(contacts.map((p) => [keyOf(p.ledger), p.phone || ""]));

  const warnings = [];
  const sides = {};
  for (const [side, group] of SIDES) {
    // Ledger-balances rows already carry Tally's own sign convention (debit negative); the receivable side's
    // dominant direction is debit, the payable side's is credit, and normaliseSide() finds that from the data itself.
    seen.clear();
    const bills = normaliseSide(raw[side], asOf);
    const groupOf = (l) => parentOf.get(keyOf(l)) || balances.find((b) => keyOf(b.name) === keyOf(l))?.parent || group;
    const parties = groupParties(bills, groupOf, phones);
    const total = r2(parties.reduce((s, p) => s + p.total, 0));
    sides[side] = { group, total, bill_count: bills.filter((b) => b.amount > 0).length, parties };
    // Does the bill list agree with what the ledgers say? A gap usually means unallocated entries or bills settled after the cut-off.
    if (source !== "balances") {
      for (const p of parties) {
        const bal = balanceOf.get(keyOf(p.ledger));
        if (!bal) continue;
        const expected = r2(Math.abs(bal.amount));
        if (Math.abs(Math.abs(p.total) - expected) > 1) {
          warnings.push(`${p.ledger}: bills add up to ₹${inr(Math.abs(p.total))} but the ledger balance in Tally is ₹${inr(expected)}.`);
          p.mismatch = expected;
        }
      }
    }
  }
  if (source === "balances") warnings.unshift("Tally did not give bill-by-bill details, so each party shows only its ledger balance. In Tally, check that Bill-wise details is on for these ledgers.");
  if (!source) warnings.push("Tally returned no outstanding bills and no ledger balances. Check that the right company is open in Tally.");
  return { as_of: asOf, fetched_at: now(), source, sides, warnings: warnings.slice(0, 40), diagnostics: diag,
    notice: source === "report" ? "Read from Tally's Bills Receivable / Bills Payable reports just now." :
      source === "ledger-bills" ? "Read from each party's bill allocations in Tally just now." :
      source === "balances" ? "Ledger balances only (no bill detail available from Tally)." : "Nothing came back from Tally." };
}

/** The old flat list, kept so existing callers keep working. */
export async function legacyBillAgeing(D, env, cid) {
  const o = await readOutstanding(D, env, cid);
  const bills = [];
  for (const side of Object.values(o.sides)) for (const p of side.parties) for (const b of p.bills) bills.push({ ...b, group: side.group });
  bills.sort((a, b) => (b.overdue_days ?? b.days_old ?? -1) - (a.overdue_days ?? a.days_old ?? -1));
  return { as_of: o.as_of, bills, source: o.source, diagnostics: o.diagnostics, warnings: o.warnings, notice: o.notice };
}

export function normalisePhone(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  let d = digits.replace(/^00/, "");
  if (d.length === 10) d = "91" + d;
  else if (d.length === 11 && d.startsWith("0")) d = "91" + d.slice(1);
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

export function outstandingRoutes(route, authorize) {
  route("GET", "/api/companies/:cid/outstanding", async (ctx) => {
    await authorize(ctx.D, ctx.env, ctx.p.cid);
    const asOf = ctx.url.searchParams.get("as_of") || "";
    return json(await readOutstanding(ctx.D, ctx.env, ctx.p.cid, { asOf }));
  });
  route("PUT", "/api/companies/:cid/party-contacts", async (ctx) => {
    await authorize(ctx.D, ctx.env, ctx.p.cid);
    const b = ctx.body || {};
    const ledger = String(b.ledger || "").trim();
    if (!ledger) bad("Which party?");
    const raw = String(b.phone || "").trim();
    if (!raw) {
      await ctx.D.run("DELETE FROM party_contacts WHERE company_id=? AND ledger=?", ctx.p.cid, ledger);
      return json({ ok: true, phone: "" });
    }
    const phone = normalisePhone(raw);
    if (!phone) bad("That does not look like a phone number. Use 10 digits, or the country code followed by the number.");
    await ctx.D.run("INSERT INTO party_contacts(company_id,ledger,phone,updated_at) VALUES(?,?,?,?) ON CONFLICT(company_id,ledger) DO UPDATE SET phone=excluded.phone,updated_at=excluded.updated_at",
      ctx.p.cid, ledger, phone, now());
    return json({ ok: true, phone });
  });
}
