// GSTR-2B ↔ Tally purchase register. Runs in the browser (and in tests).
//
// Tally side: the app reads inward vouchers from Tally with their ledger lines; here the GST
// ledgers (from the masters: Duties & Taxes + IGST/CGST/SGST/Cess in the name) turn
// those lines into IGST / CGST / SGST / cess, taxable value and invoice value.
//
// Matching, per supplier GSTIN, best evidence first:
//   1. same invoice number                       (exact, then written differently: "INV/0045/26-27" = "45")
//   2. same supplier, same tax and value, close date, but a different number → "check the number"
// Within tolerance (₹1 by default) → Matched; otherwise Mismatch with every difference listed.
// 2B documents left over → Not in Tally. Tally vouchers of the month left over → Not in 2B.

import { sameInvoice, invoiceKey, totals, periodRange } from "./gstr2b.js";

const r2 = (x) => Math.round((+x || 0) * 100) / 100;
const HEADS = ["igst", "cgst", "sgst", "cess"];
export const HEAD_LABEL = { igst: "IGST", cgst: "CGST", sgst: "SGST", cess: "Cess", val: "Invoice value", txval: "Taxable value", dt: "Date", num: "Invoice no." };

export function taxHead(name) {
  const n = String(name || "").toLowerCase();
  if (/\bcess\b/.test(n)) return "cess";
  if (/igst|integrated/.test(n)) return "igst";
  if (/cgst|central/.test(n)) return "cgst";
  if (/sgst|utgst|state|\but\b/.test(n)) return "sgst";
  return null;
}

/** ledgers: masters rows [{name, parent, primary_group, gstin}] → helpers to read Tally vouchers. */
const normLedger = s => String(s || "").toLowerCase().replace(/\s+/g," ").trim();
const adjustmentKind = name => {
  const n=normLedger(name);
  if(/round[ -]?off|rounding/.test(n))return "round_off";
  if(/discount|rebate|cash disc|trade disc/.test(n))return "discount";
  if(/freight|cartage|carriage|transport|shipping|courier|delivery charge|forwarding/.test(n))return "freight";
  if(/packing|handling|loading|hamali|insurance charge/.test(n))return "other_charge";
  return null;
};
/** Read Tally purchase vouchers without counting item amounts again in the purchase ledger. */
export function buildBooks(rows, ledgers = [], rulesInput = []) {
  const rules=new Map(rulesInput.map(r=>[normLedger(r.ledger_name),r.role]));
  const byName = new Map(ledgers.map(l => [normLedger(l.name),l]));
  const head = new Map();
  const isTax = (name) => {
    const key=normLedger(name);
    if(head.has(key))return head.get(key);
    const l=byName.get(key);
    const group=`${l?.primary_group||""} ${l?.parent||""}`;
    const role=rules.get(key)||"auto";
    const h=["igst","cgst","sgst","cess"].includes(role)?role:taxHead(name);
    const ok=role!=="ignore"&&h&&(["igst","cgst","sgst","cess"].includes(role)||(l?/duties|tax/i.test(group):/gst|tax|cess/i.test(name)))&&!/tds|tcs/i.test(name);
    head.set(key,ok?h:null);
    return ok?h:null;
  };
  const out=[];
  for(const v of rows){
    const e=Array.isArray(v.e)?v.e:[];
    // The debit side of a purchase is negative in Tally XML; returns reverse it.
    const sign=v.kind==="dn"?1:-1;
    const t={igst:0,cgst:0,sgst:0,cess:0};
    let party=v.party||"",value=0,purchaseLedger=0,unmappedBase=0,adjustments=0,roundOff=0;
    const adjustmentLines=[],unclassified=[];
    for(const [name,raw] of e){
      const amount=Number(raw)||0,signed=amount*sign;
      if(Math.abs(amount)<0.005)continue;
      const role=rules.get(normLedger(name))||"auto";
      if(role==="ignore")continue;
      const h=isTax(name);
      if(h){if(signed>0)t[h]+=signed;continue;}
      if(party&&normLedger(name)===normLedger(party)){value+=Math.abs(amount);continue;}
      const m=byName.get(normLedger(name));
      const group=normLedger(m?.primary_group||m?.parent);
      const kind=role==="auto"?adjustmentKind(name):role;
      if(kind==="round_off"){roundOff+=signed;continue;}
      // A freight / discount ledger can itself be under Purchase Accounts.
      // Classify it before handling the ordinary purchase allocation.
      if((!kind&&group==="purchase accounts")||kind==="base"){purchaseLedger+=signed;continue;}
      // Explicit voucher-level discount/freight/packing lines are the only extra
      // amounts added to a stock invoice; unknown accounting allocations are not
      // silently added over the inventory value.
      if(kind){
        adjustments+=signed;
        adjustmentLines.push({name,amount:r2(signed),kind});
        continue;
      }
      if(signed>0){
        unmappedBase+=signed;
        unclassified.push({name,amount:r2(signed)});
      }
    }
    if(!party||!value){
      const cand=e.filter(([n,a])=>!isTax(n)&&Number(a)*sign<0)
        .sort((a,b)=>Math.abs(Number(b[1]))-Math.abs(Number(a[1])))[0];
      if(cand){party=party||cand[0];value=value||Math.abs(Number(cand[1]));}
    }
    const inventory=r2(Math.abs(Number(v.inv)||0));
    const hasInventory=inventory>0.005;
    const base=hasInventory?inventory:Math.abs(purchaseLedger)>0.005?purchaseLedger:unmappedBase;
    const source=hasInventory?"inventory":Math.abs(purchaseLedger)>0.005?"purchase_ledger":"other_debit_ledgers";
    const taxable=r2(base+adjustments);
    const gstin=String(v.gstin||byName.get(normLedger(party))?.gstin||"").toUpperCase();
    for(const k of HEADS)t[k]=r2(t[k]);
    const tax=r2(t.igst+t.cgst+t.sgst+t.cess);
    out.push({
      id:String(v.mid||`${v.date}|${v.number}`),mid:v.mid,date:v.date,number:v.number,vtype:v.vtype,kind:v.kind||"inv",
      num:String(v.ref||v.number||"").trim(),refFromNumber:!v.ref,dt:v.refdate||v.date,party,gstin,
      ...t,tax,txval:taxable,val:r2(value||taxable+tax),
      breakdown:{base:r2(base),source,inventory,purchase_ledger:r2(purchaseLedger),
        adjustments:r2(adjustments),round_off:r2(roundOff),taxable,
        adjustment_lines:adjustmentLines,unclassified:hasInventory?unclassified:[]}
    });
  }
  return out;
}
const days = (a, b) => (a && b ? Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 864e5) : 0);
const normName = (s) => String(s || "").toLowerCase().replace(/\b(m\/s|the|pvt|private|ltd|limited|llp|co|company|and|&)\b|[^a-z0-9]/g, "");

// which Tally voucher kinds can carry each 2B document
function kindsFor(d) {
  if (d.note === "C") return ["dn"];
  if (d.note === "D") return ["inv", "cn", "jv", "pay"];
  return ["inv", "jv", "pay"];
}

/** Compare one 2B document with one Tally voucher → { level, diffs, ok, score, dateGap }. */
export function compare(d, b, tol = 1) {
  const level = Math.max(sameInvoice(d.num, b.num), d.onum ? sameInvoice(d.onum, b.num) : 0);
  const diffs = [];
  for (const h of HEADS) if (Math.abs((d[h] || 0) - (b[h] || 0)) > tol) diffs.push({ field: h, b2b: d[h] || 0, books: b[h] || 0 });
  const taxGap = Math.abs(totals(d) - b.tax);
  if(Number.isFinite(Number(d.txval))&&Number.isFinite(Number(b.txval))&&
    Math.abs(Number(d.txval)-Number(b.txval))>tol)
    diffs.push({field:"txval",b2b:r2(d.txval),books:r2(b.txval)});
  // invoice value: 2B "val" is the full invoice; small round-off is normal
  if (d.val && b.val && Math.abs(d.val - b.val) > Math.max(tol, 1)) diffs.push({ field: "val", b2b: d.val, books: b.val });
  // tax put under the wrong head (IGST in 2B, CGST+SGST in Tally)
  const wrongHead = taxGap <= tol && diffs.some((x) => HEADS.includes(x.field));
  const dateGap = days(d.dt, b.dt);
  const ok = !diffs.some(x=>HEADS.includes(x.field)||x.field==="txval") && !diffs.some((x) => x.field === "val" && Math.abs(x.b2b - x.books) > Math.max(tol, 10));
  const score = level * 1000 - taxGap - Math.min(60, dateGap) / 10;
  return { level, diffs, ok, wrongHead, score, taxGap, dateGap };
}

/**
 * docs: 2B documents (with id; manual links in d.mid with d.method === "manual"),
 * books: buildBooks() output, opts: { tol, period, usedElsewhere:Set(mid) }.
 * → { results: Map(docId → {status, mid, level, diffs, notes, method}), booksOnly: [book], byMid: Map }
 */
// GST journals the app posts from GSTR-2B (reverse-charge tax, ISD, import IGST) are numbered "G2BJ-…".
export const isGstr2bJournal = (b) => b.kind === "jv" && /^G2BJ-/i.test(String(b.number || ""));

export function reconcile(docs, books0, { tol = 1, period = "", usedElsewhere = new Set() } = {}) {
  const results = new Map();
  const used = new Set();
  // Reverse charge: the purchase carries no GST (the supplier didn't charge it); the GST is in the
  // app's RCM journal for the same supplier invoice. Together they are the 2B document.
  const rcmJournals = new Map();
  for (const b of books0) if (isGstr2bJournal(b)) rcmJournals.set(invoiceKey(b.num), b);
  const books = books0.filter((b) => !isGstr2bJournal(b));
  const withRcm = (d, b) => {
    if (!d.rev || b.tax > 0.005) return b;
    const j = rcmJournals.get(invoiceKey(d.num));
    if (!j) return b;
    return { ...b, igst: j.igst, cgst: j.cgst, sgst: j.sgst, cess: j.cess, tax: j.tax, val: d.val, rcmJournal: j.number };
  };
  const byMid = new Map(books.map((b) => [b.id, b]));
  const byGstin = new Map();
  for (const b of books) {
    const k = b.gstin || "~" + normName(b.party);
    if (!byGstin.has(k)) byGstin.set(k, []);
    byGstin.get(k).push(b);
  }
  const active = docs.filter((d) => d.compare !== false);
  const notesFor = (d, b, c) => {
    const n = [];
    if (d.itc === "N") n.push(`ITC not available as per 2B${d.rsn ? ` (${d.rsn})` : ""}`);
    if (d.rev) n.push(b?.rcmJournal ? `Reverse charge — GST booked by journal ${b.rcmJournal}` : "Reverse charge");
    if (d.sec.endsWith("A")) n.push(`Amended by the supplier${d.onum ? ` (was ${d.onum})` : ""}`);
    if (b && c) {
      if (c.level === 1) n.push(`Invoice no. written differently in Tally: ${b.num}`);
      if (c.level === 0) n.push(`Invoice no. differs — 2B: ${d.num}, Tally: ${b.num || "—"}`);
      if (c.dateGap > 3) n.push(`Dates differ by ${c.dateGap} days`);
      if (c.wrongHead) n.push("Tax entered under a different head (IGST vs CGST+SGST)");
      if (!b.gstin) n.push("Party in Tally has no GSTIN — matched by name");
    }
    return n;
  };
  const settle = (d, b, c, method) => {
    used.add(b.id);
    if (b.rcmJournal) byMid.set(b.id, b);
    const status = c.level === 0 ? (c.ok ? "probable" : "mismatch") : c.ok ? "matched" : "mismatch";
    results.set(d.id, { status, mid: b.id, level: c.level, diffs: c.diffs, notes: notesFor(d, b, c), method });
  };

  // manual links stay as they are
  for (const d of active) {
    if (d.method === "manual" && d.mid && byMid.has(d.mid)) { const b = withRcm(d, byMid.get(d.mid)); settle(d, b, compare(d, b, tol), "manual"); }
    else if (d.method === "manual" && d.status === "missing") { results.set(d.id, { status: "missing", mid: null, level: 0, diffs: [], notes: notesFor(d), method: "manual" }); }
  }
  const candidates = (d) => {
    const pool = [...(byGstin.get(d.ctin) || []), ...(byGstin.get("~" + normName(d.name)) || [])];
    const kinds = kindsFor(d);
    return pool.filter((b) => !used.has(b.id) && kinds.includes(b.kind));
  };
  // every pair, strongest first: number match, then closeness of tax, then date
  const pairs = [];
  for (const d of active) {
    if (results.has(d.id)) continue;
    for (const b0 of candidates(d)) {
      const b = withRcm(d, b0);
      const c = compare(d, b, tol);
      if (c.level > 0) pairs.push({ d, b, c });
      else if (c.ok && c.taxGap <= tol && c.dateGap <= 31 && totals(d) > 0) pairs.push({ d, b, c, amountOnly: true });
    }
  }
  pairs.sort((x, y) => y.c.score - x.c.score);
  for (const p of pairs) {
    if (results.has(p.d.id) || used.has(p.b.id)) continue;
    if (p.amountOnly) {
      // only when it's the one voucher of that supplier with this amount
      const rivals = pairs.filter((q) => q.amountOnly && !used.has(q.b.id) && !results.has(q.d.id) && (q.d === p.d || q.b === p.b));
      if (rivals.length > 1) continue;
    }
    settle(p.d, p.b, p.c, p.amountOnly ? "amount" : "number");
  }
  for (const d of active) if (!results.has(d.id)) results.set(d.id, { status: "missing", mid: null, level: 0, diffs: [], notes: notesFor(d), method: "" });
  for (const d of docs) if (d.compare === false) results.set(d.id, { status: "info", mid: null, level: 0, diffs: [], notes: [d.sec === "IMPG" ? "Import of goods (ICEGATE) — not compared with Tally" : "Input Service Distributor credit — not compared with Tally"], method: "" });

  // Tally vouchers of this month (by supplier invoice date) that no 2B document claimed
  const range = periodRange(period);
  const booksOnly = books.filter((b) => !used.has(b.id) && !usedElsewhere.has(b.id) && b.tax > 0 &&
    (!range || (b.dt >= range.from && b.dt <= range.to)));
  // the same supplier invoice entered twice in Tally shows up here as the leftover copy
  const claimed = new Map();
  for (const b of books) if (used.has(b.id) || usedElsewhere.has(b.id)) claimed.set(`${b.gstin}|${invoiceKey(b.num)}`, b);
  for (const b of booksOnly) {
    const twin = claimed.get(`${b.gstin}|${invoiceKey(b.num)}`);
    b.why = twin ? `Same invoice no. as voucher ${twin.number || ""} dated ${twin.date} — entered twice?` : b.gstin ? "Not in GSTR-2B — supplier may not have filed it yet" : "Party has no GSTIN in Tally";
  }
  return { results, booksOnly, byMid };
}

/** Totals for the summary cards. ITC from credit notes counts negative. */
export function summarize(docs, results, booksOnly, byMid) {
  const z = () => ({ n: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 });
  const add = (acc, x, sign = 1) => { acc.n++; for (const h of HEADS) acc[h] = r2(acc[h] + sign * (x[h] || 0)); acc.tax = r2(acc.igst + acc.cgst + acc.sgst + acc.cess); };
  const s = { b2b: z(), itcNo: z(), matched: z(), mismatch: z(), probable: z(), missing: z(), booksOnly: z(), info: z(), books: z(), accepted: z(), ignored: z() };
  for (const d of docs) {
    const sign = d.note === "C" ? -1 : 1;
    const r = results.get(d.id) || { status: "missing" };
    const st = d.status === "accepted" ? "accepted" : d.status === "ignored" ? "ignored" : r.status;
    if (d.compare === false) { add(s.info, d, sign); continue; }
    if (d.itc === "N") add(s.itcNo, d, sign); else add(s.b2b, d, sign);
    if (s[st]) add(s[st], d, sign);
    if (r.mid && byMid?.get(r.mid)) add(s.books, byMid.get(r.mid), byMid.get(r.mid).kind === "dn" ? -1 : 1);
  }
  for (const b of booksOnly) { add(s.booksOnly, b, b.kind === "dn" ? -1 : 1); add(s.books, b, b.kind === "dn" ? -1 : 1); }
  s.calculation_version=2;
  return s;
}

/** Text for the supplier: invoices in our books that aren't in GSTR-2B yet, or that differ. */
export function supplierMessage({ company, period, party, items }) {
  const lines = items.map((x, i) => `${i + 1}. ${x.num} dated ${x.dt} — value ₹${x.val.toFixed(2)}, GST ₹${x.tax.toFixed(2)}${x.why ? ` (${x.why})` : ""}`);
  return `Dear ${party},\n\nWhile matching our purchase register with GSTR-2B for ${period}, the following invoice${items.length === 1 ? "" : "s"} from you ${items.length === 1 ? "needs" : "need"} attention:\n\n${lines.join("\n")}\n\nPlease file / correct ${items.length === 1 ? "it" : "them"} in your GSTR-1 (or IFF) so that the input tax credit reflects for us.\n\nThank you,\n${company}`;
}

export { invoiceKey };
