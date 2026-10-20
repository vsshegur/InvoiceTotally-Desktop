// Bank statement reading without AI, shared by the browser and the server.
//
// Works on a table of cells (Excel/CSV rows, or PDF text rebuilt into columns):
// finds the header row, maps the columns (date, narration, cheque/ref, debit,
// credit or amount + Dr/Cr, balance), joins narrations that wrap onto the next
// line, and checks every row against the running balance. A statement whose
// rows add up is trusted; anything else goes to the AI reader.

const KEYS = {
  date: [/^(txn|tran|transaction|trans|post(ing)?|book(ing)?)?\s*\.?\s*date$/, /^date$/, /^(txn|tran|transaction)\s*dt\.?$/, /^dt\.?$/],
  vdate: [/^value\s*(date|dt\.?)$/],
  narration: [/narration/, /description/, /particular/, /remark/, /details/, /^transaction$/, /^naration$/],
  ref: [/ch(e)?q(ue)?\.?\s*(\/|&|and)?\s*(ref)?/, /ref(erence)?\.?\s*(no|number)?/, /instrument/, /^instr\.?(\s*no\.?)?$/, /utr/],
  debit: [/withdrawal/, /^debits?(\s*amount)?(\s*\(.*\))?$/, /^dr\.?(\s*(amount|amt\.?))?$/, /paid\s*out/, /^debit\b/],
  credit: [/deposits?/, /^credits?(\s*amount)?(\s*\(.*\))?$/, /^cr\.?(\s*(amount|amt\.?))?$/, /paid\s*in/, /^credit\b/],
  amount: [/^(txn|transaction)?\s*amount(\s*\(.*\))?$/, /^amt\.?$/],
  drcr: [/^(dr|cr)\s*\/\s*(cr|dr)$/, /^type$/, /^d\/c$/, /^c\/d$/, /^txn\s*type$/],
  balance: [/balance/, /^bal\.?(\s*(amount|amt\.?))?$/],
};

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const low = (s) => clean(s).toLowerCase().replace(/[:#*]/g, "").trim();

/** "1,23,456.78", "₹ 500", "(500)", "500-", "-500", "500 Dr" → number (or null). */
export function amount(v) {
  let s = clean(v);
  if (!s || s === "-" || s === "--") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/(^-|-$)/.test(s.replace(/\s/g, ""))) { neg = true; }
  s = s.replace(/(rs\.?|inr|₹)/gi, "").replace(/\b(cr|dr)\.?$/i, "").replace(/[,\s-]/g, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100) / 100;
  return neg ? -n : n;
}
/** Balance with an optional Dr/Cr side: "12,345.00 Cr" → 12345, "500.00 Dr" → -500. */
export function balance(v) {
  const s = clean(v);
  const n = amount(s);
  if (n == null) return null;
  return /\bdr\.?$/i.test(s) ? -Math.abs(n) : n;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const year = (y) => { y = +y; return y < 100 ? (y > 70 ? 1900 + y : 2000 + y) : y; };
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && y >= 1990 && y <= 2100 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Indian statements put the day first. Returns YYYY-MM-DD or null. */
export function date(v) {
  const s = clean(v).replace(/\s*(\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?)$/i, "");
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return valid(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  if ((m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/))) { const y = year(m[3]); return valid(y, +m[2], +m[1]) ? `${y}-${pad(m[2])}-${pad(m[1])}` : null; }
  if ((m = s.match(/^(\d{1,2})[-/. ]?([a-z]{3,4})[a-z]*[-/., ]*(\d{2,4})$/i))) {
    const mo = MON[m[2].toLowerCase()]; const y = year(m[3]);
    return mo && valid(y, mo, +m[1]) ? `${y}-${pad(mo)}-${pad(m[1])}` : null;
  }
  if ((m = s.match(/^([a-z]{3,4})[a-z]*[ -](\d{1,2}),?[ -](\d{2,4})$/i))) {
    const mo = MON[m[1].toLowerCase()]; const y = year(m[3]);
    return mo && valid(y, mo, +m[2]) ? `${y}-${pad(mo)}-${pad(m[2])}` : null;
  }
  if ((m = s.match(/^(\d{1,2})(\d{2})(\d{4})$/)) && s.length === 8) return valid(+m[3], +m[2], +m[1]) ? `${m[3]}-${m[2]}-${pad(m[1])}` : null;
  return null;
}

function kindOf(cell) {
  const t = low(cell);
  if (!t || t.length > 40) return null;
  for (const k of ["vdate", "balance", "date", "drcr", "debit", "credit", "amount", "ref", "narration"]) {
    if (KEYS[k].some((re) => re.test(t))) return k;
  }
  return null;
}

/** Finds the header row and which column holds what. */
export function findHeader(rows) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const map = {};
    rows[i].forEach((c, j) => {
      const k = kindOf(c);
      if (k && map[k] == null) map[k] = j;
      else if (k === "date" && map.date != null && map.vdate == null) map.vdate = j;
    });
    if (map.date == null && map.vdate != null) { map.date = map.vdate; delete map.vdate; }
    const money = (map.debit != null && map.credit != null) || map.amount != null;
    const score = (map.date != null) * 3 + (map.narration != null) * 2 + money * 3 + (map.balance != null) * 2 + (map.ref != null);
    if (map.date != null && money && score >= 8 && (!best || score > best.score)) best = { row: i, map, score };
  }
  return best;
}

const OPEN_RE = /opening\s*bal|balance\s*(b\/?f|brought\s*forward)|^b\/?f$|bal(ance)?\s*forward/i;
const CLOSE_RE = /closing\s*bal|balance\s*(c\/?f|carried)|^c\/?f$/i;
const TOTAL_RE = /^(grand\s*)?totals?\b|^page\s*total|^transaction\s*total/i;

/** Rows of cells → transactions. */
export function parseTable(rows, header = findHeader(rows)) {
  if (!header) return { rows: [], error: "Could not find the column headings (Date, Narration, Debit/Credit, Balance)" };
  const m = header.map;
  const out = [];
  let opening = null, closing = null;
  const headerSig = rows[header.row].map(low).join("|");
  // "Opening Balance: 50,000.00 Cr" printed above the table
  for (let i = 0; i < header.row; i++) {
    const t = clean(rows[i].join(" "));
    if (!OPEN_RE.test(t)) continue;
    const m = [...t.matchAll(/(-?[\d,]*\d\.\d{2})\s*(cr|dr)?\b/gi)].pop();
    if (m) opening = balance(m[1] + (m[2] ? " " + m[2] : ""));
  }
  for (let i = header.row + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.map(low).join("|") === headerSig) continue; // header repeated on the next page
    const cell = (k) => (m[k] == null ? "" : clean(r[m[k]]));
    const text = clean(r.join(" "));
    if (!text) continue;
    const d = date(cell("date"));
    const narr = cell("narration");
    let debit = amount(cell("debit")), credit = amount(cell("credit"));
    if (m.amount != null) {
      const a = amount(cell("amount"));
      const side = low(cell("drcr")) || low(r[m.amount]).match(/\b(dr|cr)\.?$/)?.[1] || "";
      if (a != null) {
        if (/^d|withdraw|debit/.test(side) || (!side && a < 0)) { debit = Math.abs(a); credit = null; }
        else { credit = Math.abs(a); debit = null; }
      }
    }
    if (debit != null && debit < 0) { credit = (credit || 0) + -debit; debit = null; }
    if (credit != null && credit < 0) { debit = (debit || 0) + -credit; credit = null; }
    const bal = m.balance == null ? null : balance(cell("balance"));
    if (OPEN_RE.test(narr) || (!d && OPEN_RE.test(text))) { if (bal != null) opening = bal; else if (credit ?? debit) opening = credit ?? -debit; continue; }
    if (CLOSE_RE.test(narr) || (!d && CLOSE_RE.test(text))) { if (bal != null) closing = bal; continue; }
    if (TOTAL_RE.test(clean(r[0])) || TOTAL_RE.test(narr)) continue;
    if (d && (debit || credit)) {
      out.push({ date: d, narration: narr, ref: cell("ref"), debit: debit || 0, credit: credit || 0, balance: bal });
    } else if (!d && out.length && narr && !debit && !credit && bal == null) {
      // narration wrapped onto the next line
      const last = out[out.length - 1];
      last.narration = clean(last.narration + " " + narr);
      if (m.ref != null && cell("ref") && !last.ref.endsWith(cell("ref"))) last.ref = clean(last.ref + cell("ref"));
    }
  }
  return { rows: out, opening, closing, columns: Object.keys(m) };
}

const r2 = (x) => Math.round(x * 100) / 100;
/**
 * Checks each row against the running balance. Statements listed newest-first are
 * turned round. Returns the rows in date order with ok=true/false on each.
 */
export function checkBalances(rows, opening = null) {
  const run = (list) => {
    let prev = opening, bad = 0, checked = 0;
    const res = list.map((x, i) => {
      if (x.balance == null) return { ...x, ok: null };
      if (prev == null) prev = r2(x.balance - x.credit + x.debit);
      const want = r2(prev + x.credit - x.debit);
      const ok = Math.abs(want - x.balance) < 0.011;
      checked++;
      if (!ok) bad++;
      prev = x.balance;
      return { ...x, ok, expected: ok ? undefined : want };
    });
    return { res, bad, checked };
  };
  const fwd = run(rows);
  if (rows.length > 1 && fwd.bad > 0) {
    const rev = run([...rows].reverse());
    if (rev.bad < fwd.bad && rev.checked) return { rows: rev.res, bad: rev.bad, checked: rev.checked, reversed: true };
  }
  return { rows: fwd.res, bad: fwd.bad, checked: fwd.checked, reversed: false };
}

/** Tab-separated text (from Excel/CSV) → transactions. */
export function fromSheetText(text) {
  const rows = String(text || "").split("\n").map((l) => l.split("\t"));
  return finish(parseTable(rows));
}

function finish(p) {
  if (!p.rows.length) return { ...p, ok: false };
  const c = checkBalances(p.rows, p.opening);
  const okShare = c.checked ? (c.checked - c.bad) / c.checked : 0;
  const datesInOrder = c.rows.every((x, i) => i === 0 || x.date >= c.rows[i - 1].date);
  return { ...p, rows: c.rows, bad: c.bad, checked: c.checked, reversed: c.reversed,
    // Trusted without AI only when every row has a balance and nearly all add up.
    ok: c.checked === c.rows.length && okShare >= 0.98 && datesInOrder };
}

// ---------------------------------------------------------------- PDF text
/**
 * pages: [{ items: [{ s, x, y, w }] }] in PDF units, y measured from the top.
 * Rebuilds lines, finds the heading line, cuts columns at the headings and parses.
 */
export function linesOf(items, tol = 3) {
  const sorted = items.filter((i) => clean(i.s)).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const l = lines.find((L) => Math.abs(L.y - it.y) <= tol);
    if (l) l.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y);
}

/** Text of one page with columns kept apart (used when the AI reads the page). */
export function pageText(items) {
  return linesOf(items).map((l) => {
    let out = "", end = null;
    for (const it of l.items) {
      if (end != null) out += it.x - end > 6 ? "   " : it.x - end > 1.5 ? " " : "";
      out += clean(it.s);
      end = it.x + (it.w || clean(it.s).length * 4);
    }
    return out;
  }).join("\n");
}

function mergeHeadingWords(items) {
  // "Withdrawal" "Amt." on one line are two words of one heading when close together.
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && it.x - (prev.x + prev.w) < 7) { prev.s = clean(prev.s + " " + it.s); prev.w = it.x + it.w - prev.x; }
    else out.push({ ...it, w: it.w || clean(it.s).length * 4 });
  }
  return out;
}

export function fromPdfPages(pages) {
  const allLines = [];
  pages.forEach((p, pi) => linesOf(p.items).forEach((l) => allLines.push({ ...l, page: pi })));
  // heading: the line (optionally with the line just below it) that names the most columns
  let best = null;
  for (let i = 0; i < Math.min(allLines.length, 150); i++) {
    for (const span of [1, 2]) {
      const group = allLines.slice(i, i + span);
      if (span === 2 && (group.length < 2 || group[1].page !== group[0].page || group[1].y - group[0].y > 14)) continue;
      const words = mergeHeadingWords(group.flatMap((l) => l.items).sort((a, b) => a.x - b.x));
      // two-line headings: stack words that overlap horizontally
      const cols = [];
      for (const w of words) {
        const c = cols.find((c) => w.x < c.x + c.w && w.x + w.w > c.x);
        if (c) { c.s = clean(c.s + " " + w.s); const r = Math.max(c.x + c.w, w.x + w.w); c.x = Math.min(c.x, w.x); c.w = r - c.x; }
        else cols.push({ ...w });
      }
      cols.sort((a, b) => a.x - b.x);
      const h = findHeader([cols.map((c) => c.s)]);
      if (h && (!best || h.score > best.h.score)) best = { h, cols, line: i + span - 1, page: group[0].page, span };
    }
  }
  if (!best) return { rows: [], ok: false, error: "No column headings found" };
  const cols = best.cols;
  // Cut points between columns. Amount columns are right-aligned, so cut at the
  // previous heading's right edge rather than the midpoint when headings are far apart.
  const cuts = [];
  for (let i = 1; i < cols.length; i++) cuts.push((cols[i - 1].x + cols[i - 1].w + cols[i].x) / 2);
  const toCells = (l) => {
    const cells = cols.map(() => "");
    for (const it of l.items) {
      const mid = it.x + (it.w || 0) / 2;
      let k = cuts.findIndex((c) => mid < c);
      if (k < 0) k = cols.length - 1;
      cells[k] = clean(cells[k] + " " + it.s);
    }
    return cells;
  };
  const above = allLines.slice(0, best.line - (best.span - 1)).map((l) => [l.items.map((it) => it.s).join(" ")]);
  const rows = [...above, cols.map((c) => c.s)];
  for (let i = best.line + 1; i < allLines.length; i++) rows.push(toCells(allLines[i]));
  const header = { ...best.h, row: above.length };
  return finish(parseTable(rows, header));
}

/** Short key for a narration, used to remember which ledger it goes to. */
const KIND_WORDS = /^(NEFT|RTGS|IMPS|UPI|NFT|RTG|ECS|NACH|ACH|CHQ|CHEQUE|CLG|CLEARING|INB|MB|NETBANKING|BIL|BILLPAY|POS|ATM)$/;
const NOISE = new Set(("CR DR BY TO TRF TRANSFER FROM THE FOR AND OF REF NO NUMBER INV INVOICE BILL BILLS PAYMENT PAY PAYMT PYMT RECEIVED " +
  "RECD RECEIPT SENT ADV ADVANCE AGAINST TOWARDS P2A P2M P2P IFSC AC A C ACCT ACCOUNT SB CA OD CC TXN TRAN OTHERS OTHER " +
  "NET BANKING MOBILE MICR CTS INWARD OUTWARD SELF PAID ISSUED DEPOSIT DEP WITHDRAWAL WDL CREDIT DEBIT CASH RETURN RTN").split(" "));
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/**
 * Short key for who is on the other side of a narration, used to remember its ledger:
 * "UPI:ramesh@okaxis", "NEFT:SHREE GANESH TRADERS", "TXT:SMS CHARGES".
 */
export function narrationKey(narration) {
  const s = clean(narration).toUpperCase();
  let m = s.match(/(?:^|[\/\- :*])([A-Z0-9._]{2,}@[A-Z]{2,})/);
  if (m) return `UPI:${m[1]}`;
  const kind = (s.match(/\b(NEFT|RTGS|IMPS|UPI|NFT|RTG|ECS|NACH|ACH)\b/) || [])[1];
  const segments = s.split(/[\/\-:*|]+|\s{2,}/).map((x) => x.trim()).filter(Boolean);
  for (const seg of segments) {
    const w = seg.split(/\s+/).filter((t) => !/\d/.test(t) && !IFSC.test(t) && !KIND_WORDS.test(t) && !NOISE.has(t) && /^[A-Z.&']+$/.test(t));
    const name = w.join(" ").replace(/\s+/g, " ").trim();
    if (name.replace(/[^A-Z]/g, "").length >= 3) return `${kind ? kind.replace("NFT", "NEFT").replace("RTG", "RTGS") : "TXT"}:${w.slice(0, 5).join(" ")}`;
  }
  return "";
}
