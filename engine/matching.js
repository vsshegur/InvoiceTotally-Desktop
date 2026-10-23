// Matching extracted data to Tally masters, plus learned aliases.
// CPU-light: SQL narrows candidates first, then a cheap similarity score ranks them.
import { cleanGstin } from "./gst.js";

const STOP = new Set(["MS", "THE", "AND", "CO", "PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "M", "S"]);

export const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const normParty = (s) => norm(String(s || "").replace(/^\s*(m\s*\/\s*s|messrs)\.?\s+/i, ""))
  .split(" ").filter((t) => t && !STOP.has(t)).join(" ");

function bigrams(s) {
  const out = new Map();
  const x = s.replace(/ /g, "");
  for (let i = 0; i < x.length - 1; i++) { const b = x.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); }
  return out;
}

/** 0-100. Bigram Dice + token overlap; a matching leading code ("3060 ...") counts extra. */
export function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [k, v] of A) if (B.has(k)) inter += Math.min(v, B.get(k));
  const dice = na + nb ? (2 * inter) / (na + nb) : 0;
  const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const tok = common / Math.max(1, Math.min(ta.size, tb.size));
  const jac = common / (new Set([...ta, ...tb]).size || 1);
  const fa = a.split(" ")[0], fb = b.split(" ")[0];
  const lead = fa === fb && /\d/.test(fa) ? 0.15 : 0;
  return Math.round(Math.min(1, 0.45 * dice + 0.35 * tok + 0.2 * jac + lead) * 100);
}

export const partyGroup = (vt) => (vt === "Purchase" ? "Sundry Creditors" : "Sundry Debtors");
export const accountGroup = (vt) => (vt === "Purchase" ? "Purchase Accounts" : "Sales Accounts");

export async function aliasGet(D, cid, kind, key) {
  if (!key) return null;
  // One query loads every learned alias of the company; it is memoised for the rest of the request.
  const rows = await D.all("SELECT kind, key, value FROM aliases WHERE company_id=?", cid);
  const hit = rows.find((r) => r.kind === kind && r.key === key);
  return hit ? hit.value : null;
}
export function aliasSetStmt(D, cid, kind, key, value) {
  return D.stmt("INSERT OR REPLACE INTO aliases (company_id, kind, key, value) VALUES (?,?,?,?)", cid, kind, key, value);
}
async function exists(D, cid, kind, name) {
  return !!(await D.first("SELECT 1 x FROM masters WHERE company_id=? AND kind=? AND name=?", cid, kind, name));
}

/** Pull plausible candidates with SQL: any meaningful token appears in the name. */
async function candidates(D, cid, kind, text, { groups = null, hsn = null, limit = 300 } = {}) {
  const toks = [...new Set(norm(text).split(" ").filter((t) => t.length >= 3 || /\d/.test(t)))].slice(0, 5);
  const conds = toks.map(() => "uname LIKE ?");
  const args = toks.map((t) => `%${t}%`);
  if (hsn) { conds.push("hsn = ?"); args.push(hsn); }
  let sql = "SELECT name, parent, primary_group, gstin, state, hsn, gst_rate, unit FROM masters WHERE company_id=? AND kind=?";
  const params = [cid, kind];
  if (groups?.length) { sql += ` AND primary_group IN (${groups.map(() => "?").join(",")})`; params.push(...groups); }
  if (conds.length) { sql += ` AND (${conds.join(" OR ")})`; params.push(...args); }
  sql += ` LIMIT ${limit}`;
  return D.all(sql, ...params);
}

// ---------------------------------------------------------------- party
export async function matchParty(D, cid, vt, name, gstin) {
  const g = cleanGstin(gstin);
  for (const key of [g && `gstin:${g}`, name && `name:${normParty(name)}`]) {
    const v = await aliasGet(D, cid, "party", key);
    if (v && (await exists(D, cid, "ledger", v))) return { ledger: v, method: "Remembered from an earlier invoice", state: "resolved" };
  }
  if (g) {
    const hit = await D.first("SELECT name FROM masters WHERE company_id=? AND kind='ledger' AND gstin=?", cid, g);
    if (hit) return { ledger: hit.name, method: "Matched by GST number", state: "resolved" };
  }
  const c = (await partyCandidates(D, cid, vt, name, gstin, 1))[0];
  if (c && c.score >= 92) return { ledger: c.name, method: `Matched by name (${c.score}% similar)`, state: "resolved" };
  if (c && c.score >= 65) return { ledger: c.name, method: `Similar name (${c.score}%)`, state: "proposed" };
  return { ledger: null, method: "No ledger found", state: "suspense" };
}

export async function partyCandidates(D, cid, vt, name, gstin, limit = 8) {
  const g = cleanGstin(gstin);
  const np = normParty(name);
  let pool = await candidates(D, cid, "ledger", np, { groups: [partyGroup(vt)] });
  if (g) pool = pool.concat(await D.all("SELECT name, parent, primary_group, gstin FROM masters WHERE company_id=? AND kind='ledger' AND substr(gstin,3,10)=?", cid, g.slice(2, 12)));
  const seen = new Set();
  const out = [];
  for (const l of pool) {
    if (seen.has(l.name)) continue;
    seen.add(l.name);
    let score = similarity(np, normParty(l.name)), tags = [];
    const lg = cleanGstin(l.gstin);
    if (g && lg === g) { score = 100; tags = ["SAME GSTIN"]; }
    else if (g && lg && lg.slice(2, 12) === g.slice(2, 12)) { score = Math.max(score, 85); tags = ["SAME PAN"]; }
    out.push({ name: l.name, parent: l.parent, gstin: l.gstin, score, tags });
  }
  out.sort((x, y) => y.score - x.score);
  return out.filter((o) => o.score >= 40).slice(0, limit);
}

// ---------------------------------------------------------------- stock
export const stockKey = (d) => norm(d);

/** The same supplier's item: "INDICA TOWELS 30X60" from KANAKRAJ → the stock item picked for it last time. */
export const stockPartyKey = (party, d) => `${norm(party)}|${stockKey(d)}`;
export async function matchStock(D, cid, line, party = null) {
  if (party) {
    const p = await aliasGet(D, cid, "stock_party", stockPartyKey(party, line.description));
    if (p && (await exists(D, cid, "stock_item", p))) return { item: p, state: "resolved", method: "Remembered for this supplier" };
  }
  const v = await aliasGet(D, cid, "stock", stockKey(line.description));
  if (v && (await exists(D, cid, "stock_item", v))) return { item: v, state: "resolved" };
  const c = (await stockCandidates(D, cid, line, 1))[0];
  if (c && c.score >= 97) return { item: c.name, state: "resolved" };
  if (c && c.score >= 55) return { item: c.name, state: "proposed" };
  return { item: null, state: "suspense" };
}

export async function stockCandidates(D, cid, line, limit = 8, query = null) {
  const desc = query || line.description || "";
  const hsn = String(line.hsn || "").replace(/\D/g, "");
  const rate = line.gst_rate;
  let pool = await candidates(D, cid, "stock_item", desc, { hsn: !query && hsn ? hsn : null });
  const out = [];
  for (const s of pool) {
    const sim = similarity(desc, s.name);
    let bonus = 0;
    const tags = [];
    const sh = String(s.hsn || "").replace(/\D/g, "");
    if (hsn && sh) {
      if (sh === hsn || sh.startsWith(hsn) || hsn.startsWith(sh)) { tags.push("SAME HSN"); bonus += 8; } else bonus -= 10;
    }
    if (rate != null && s.gst_rate != null && Math.abs(s.gst_rate - rate) > 0.01) bonus -= 10;
    if (sim >= 90) tags.push(sim === 100 ? "SAME NAME" : "VERY SIMILAR");
    else if (sim >= 50) tags.push("SIMILAR");
    out.push({ ...s, similarity: sim, score: Math.max(0, Math.min(100, sim + bonus)), tags });
  }
  out.sort((x, y) => y.score - x.score);
  return out.filter((o) => o.score >= 30).slice(0, limit);
}

// ---------------------------------------------------------------- value ledgers
export async function matchValueLedger(D, cid, vt, line, partyLedger, settings = {}) {
  if (line.kind === "ledger") {
    const v = await aliasGet(D, cid, "charge", norm(line.description));
    if (v && (await exists(D, cid, "ledger", v))) return { ledger: v, state: "resolved" };
    const pool = await candidates(D, cid, "ledger", line.description,
      { groups: ["Indirect Expenses", "Direct Expenses", "Indirect Incomes", "Direct Incomes", accountGroup(vt)] });
    let best = null, bs = 0;
    for (const l of pool) { const s = similarity(line.description, l.name); if (s > bs) { bs = s; best = l.name; } }
    return bs >= 60 ? { ledger: best, state: "proposed" } : { ledger: null, state: "suspense" };
  }
  for (const key of [partyLedger && line.stock_item && `party_item:${vt}:${partyLedger}:${line.stock_item}`, line.stock_item && `item:${vt}:${line.stock_item}`, partyLedger && `party:${vt}:${partyLedger}`]) {
    const v = await aliasGet(D, cid, "ledger", key);
    if (v && (await exists(D, cid, "ledger", v))) return { ledger: v, state: "resolved" };
  }
  const def = settings[`default_${vt.toLowerCase()}_ledger`];
  if (def && (await exists(D, cid, "ledger", def))) return { ledger: def, state: "resolved" };
  const pool = await D.all("SELECT name FROM masters WHERE company_id=? AND kind='ledger' AND primary_group=? LIMIT 200", cid, accountGroup(vt));
  if (!pool.length) return { ledger: null, state: "suspense" };
  if (line.gst_rate != null) {
    const r = String(+line.gst_rate);
    const re = new RegExp(`(^|[^\\d.])${r.replace(".", "\\.")}\\s*%`);
    const hit = pool.find((l) => re.test(l.name));
    if (hit) return { ledger: hit.name, state: "proposed" };
  }
  const gst = pool.filter((l) => /GST/i.test(l.name) && !/EXEMPT|NIL|INTER/i.test(l.name));
  return { ledger: (gst[0] || pool[0]).name, state: "proposed" };
}

// ---------------------------------------------------------------- tax ledgers
export async function matchTaxLedger(D, cid, head, rate, vt) {
  const v = await aliasGet(D, cid, "tax", `${vt}:${head}:${rate ?? ""}`);
  if (v && (await exists(D, cid, "ledger", v))) return { ledger: v, method: "Remembered" };
  if (head === "ROUND") {
    const hits = await D.all("SELECT name FROM masters WHERE company_id=? AND kind='ledger' AND uname LIKE '%ROUND%' LIMIT 50", cid);
    const word = vt === "Purchase" ? "PURCHASE" : "SALE", other = vt === "Purchase" ? "SALE" : "PURCHASE";
    hits.sort((a, b) => {
      const A = a.name.toUpperCase(), B = b.name.toUpperCase();
      return (!A.includes(word) - !B.includes(word)) || (A.includes(other) - B.includes(other)) || A.length - B.length;
    });
    return hits[0] ? { ledger: hits[0].name, method: "Named for it" } : { ledger: null, method: "Not found" };
  }
  const alt = { SGST: ["SGST", "UTGST"], CGST: ["CGST"], IGST: ["IGST"], CESS: ["CESS"] }[head];
  let pool = await D.all(`SELECT name FROM masters WHERE company_id=? AND kind='ledger' AND (${alt.map(() => "uname LIKE ?").join(" OR ")}) LIMIT 100`,
    cid, ...alt.map((a) => `%${a}%`));
  const dt = await D.all("SELECT name FROM masters WHERE company_id=? AND kind='ledger' AND primary_group='Duties & Taxes' LIMIT 1", cid);
  if (dt.length) {
    const inDT = new Set((await D.all(`SELECT name FROM masters WHERE company_id=? AND kind='ledger' AND primary_group='Duties & Taxes' AND (${alt.map(() => "uname LIKE ?").join(" OR ")})`, cid, ...alt.map((a) => `%${a}%`))).map((r) => r.name));
    if (inDT.size) pool = pool.filter((p) => inDT.has(p.name));
  }
  if (!pool.length) return { ledger: null, method: "Not found" };
  const want = vt === "Purchase" ? "INPUT" : "OUTPUT", other = vt === "Purchase" ? "OUTPUT" : "INPUT";
  const score = (n) => {
    const u = n.toUpperCase();
    let s = 0;
    if (rate != null) {
      const r = String(+rate).replace(".", "\\.");
      if (new RegExp(`(^|[^\\d.])${r}\\s*%?`).test(u)) s += 10; else if (/\d/.test(u)) s -= 5;
    }
    if (u.includes(want)) s += 3;
    if (u.includes(other)) s -= 6;
    return s - u.length / 100;
  };
  pool.sort((a, b) => score(b.name) - score(a.name));
  return { ledger: pool[0].name, method: "Named for it" };
}
