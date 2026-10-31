// Bank statement reading without AI, shared by the browser and the server.
//
// Works on a table of cells (Excel/CSV rows, or PDF text rebuilt into columns):
// finds the header row, maps the columns (date, narration, cheque/ref, debit,
// credit or amount + Dr/Cr, balance), joins narrations that wrap onto the next
// line, and checks every row against the running balance. A statement whose
// rows add up is trusted; anything else goes to the AI reader.

const KEYS = {
  date: [/^(txn|tran|transaction|trans|post(ing|ed)?|book(ing)?)?\s*\.?\s*(posted\s*)?date$/, /^date$/, /^(txn|tran|transaction)\s*dt\.?$/, /^dt\.?$/,
    /^date\s*(of\s*)?(txn|tran|transaction)$/, /^(txn|tran|transaction)\s*(posted|post|value)?\s*date\b/],
  vdate: [/^value\s*(date|dt\.?)$/],
  narration: [/narrat/, /description/, /particular/, /remark/, /details/, /^transaction$/, /^naration$/, /^beneficiary|^remitter/],
  ref: [/ch(e)?q(ue)?\.?\s*(\/|&|and)?\s*(ref)?/, /ref(erence)?\.?\s*(no|number|id)?/, /instrument/, /^instr\.?(\s*no\.?)?$/, /utr/],
  debit: [/withdrawal/, /^debits?(\s*amount|\s*amt\.?)?(\s*\(.*\))?$/, /^dr\.?(\s*(amount|amt\.?))?(\s*\(.*\))?$/, /paid\s*out/, /^debit\b/, /money\s*out/, /outflow/, /^amount\s*debited/],
  credit: [/deposits?/, /^credits?(\s*amount|\s*amt\.?)?(\s*\(.*\))?$/, /^cr\.?(\s*(amount|amt\.?))?(\s*\(.*\))?$/, /paid\s*in/, /^credit\b/, /money\s*in/, /inflow/, /^amount\s*credited/],
  amount: [/^(txn|tran|transaction)?\s*amount(\s*\(.*\))?$/, /^amt\.?$/, /^amount\s*(in\s*)?(rs|inr)\.?$/],
  drcr: [/^(dr|cr)\s*\/\s*(cr|dr)$/, /^type$/, /^d\/c$/, /^c\/d$/, /^(txn|tran|transaction)\s*type$/, /^(dr|cr)\s*\/?\s*(cr|dr)?\s*indicator$/, /^debit\s*\/\s*credit$/, /^credit\s*\/\s*debit$/],
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
  // any other heading with "date" in it ("Txn Posted Date", "Date of Transaction") — after everything else
  if (/\bdate\b/.test(t) && !/value/.test(t)) return "date";
  return null;
}

/**
 * Finds the header row and which column holds what. A heading split over two rows ("Amount" above "Withdrawals |
 * Deposits", or "Date" above a blank) is read as one: the lower row's word wins where it has one.
 */
export function findHeader(rows) {
  let best = null;
  const mapOf = (cells) => {
    const map = {};
    cells.forEach((c, j) => {
      const k = kindOf(c);
      if (k && map[k] == null) map[k] = j;
      else if (k === "date" && map.date != null && map.vdate == null) map.vdate = j;
    });
    if (map.date == null && map.vdate != null) { map.date = map.vdate; delete map.vdate; }
    if (map.debit != null && map.credit != null) delete map.amount;
    return map;
  };
  const scoreOf = (map) => {
    const money = (map.debit != null && map.credit != null) || map.amount != null;
    // separate debit and credit columns say more than one "Amount" column (a two-row heading's lower row names them)
    const score = (map.date != null) * 3 + (map.narration != null) * 2 + money * 3 + (map.balance != null) * 2 + (map.ref != null) +
      (map.debit != null && map.credit != null) * 0.5;
    return map.date != null && money && score >= 8 ? score : 0;
  };
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const row = rows[i] || [];
    const map = mapOf(row), score = scoreOf(map);
    if (score && (!best || score > best.score)) best = { row: i, map, score };
    const next = rows[i + 1];
    if (next && next.some((c) => kindOf(c)) && !next.some((c) => date(c))) {
      const width = Math.max(row.length, next.length);
      const merged = Array.from({ length: width }, (_, j) => (kindOf(next[j]) ? next[j] : row[j] ?? ""));
      const m2 = mapOf(merged), s2 = scoreOf(m2);
      if (s2 && (!best || s2 > best.score)) best = { row: i + 1, map: m2, score: s2 };
    }
  }
  return best;
}

const OPEN_RE = /opening\s*bal|balance\s*(b\/?f|brought\s*forward)|^b\/?f$|bal(ance)?\s*forward/i;
const CLOSE_RE = /closing\s*bal|balance\s*(c\/?f|carried)|^c\/?f$/i;
const TOTAL_RE = /^(grand\s*)?totals?\b|^page\s*total|^transaction\s*total/i;
// "No Of Transaction(s) : 9 11" — how many debits and credits the bank counted
const COUNT_RE = /\b(no\.?\s*of|number\s*of|count\s*of)\s*tr?an?s?a?c?tion|\btxn\s*count/i;
// "Page No :- 1 Of 3", "Page 2 of 5", "End of statement", "computer generated…" — never transactions
const FOOTER_RE = /\bpage\s*(no\.?)?\s*[:.\-]*\s*\d+\s*(of|\/)\s*\d+|^\s*page\s*(no\.?)?\s*[:.\-]*\s*\d+\s*[-\u2013]?\s*$|end\s*of\s*(the\s*)?statement|computer(ised|ized)?\s*generated|computeri[sz]ed\s*statement|does\s*not\s*require\s*(a\s*)?signature/i;
const MONEY = /\d\.\d{2}\b/; // amounts on a statement always have paise
const isDateText = (t) => !!date(t);


/**
 * Joins two pieces of one narration that a statement wrapped onto separate lines. Banks cut text anywhere, so the pieces are
 * glued without a space where the cut was clearly inside a word: a UPI handle ("vijtexkvb@a" + "xl/Pa"), after a dash or
 * slash ("IMPS-" + "OUT/…"), or inside a long number ("…4526020000041" + "1").
 */
export function joinNarration(a, b) {
  a = clean(a); b = clean(b);
  if (!a) return b;
  if (!b) return a;
  const glue = (/[a-z0-9._-]$/.test(a) && /^[a-z0-9._-]*@[a-z]/.test(b))
    || (/@[a-z]{0,6}$/i.test(a) && /^[a-z]{1,8}(\/|$)/i.test(b))
    || /[A-Za-z0-9][-/]$/.test(a)
    || (/\d{9,}$/.test(a) && /^\d{1,4}$/.test(b));
  return clean(a + (glue ? "" : " ") + b);
}

/**
 * Rows of cells → transactions.
 * Many banks print the date only on the first transaction of a day and the balance only on the last one; such rows
 * take the date from the row above, and are checked through the next balance that is printed.
 */
export function parseTable(rows, header = findHeader(rows)) {
  if (!header) return { rows: [], error: "Could not find the column headings (Date, Narration, Debit/Credit, Balance)" };
  const m = header.map;
  const out = [];
  let opening = null, closing = null, counts = null, totals = null, lastDate = null;
  let summary = false; // after a total, closing or page-end line, loose text is not part of the last narration
  const headerSig = rows[header.row].map(low).join("|");
  // "Opening Balance: 50,000.00 Cr" printed above the table
  for (let i = 0; i < header.row; i++) {
    const t = clean(rows[i].join(" "));
    if (!OPEN_RE.test(t)) continue;
    const m = [...t.matchAll(/(-?[\d,]*\d\.\d{2})\s*(cr|dr)?\b/gi)].pop();
    if (m) opening = balance(m[1] + (m[2] ? " " + m[2] : ""));
  }
  // Lines of a narration that the PDF printed ABOVE the line carrying the date and amounts (rows whose text is centred or
  // bottom-aligned): fromPdfPages marks them `lead`, and they are put in front of the next transaction's narration.
  let lead = [], leadRef = "";
  for (let i = header.row + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.lead) {
      const n = m.narration == null ? "" : clean(r[m.narration]);
      if (n) lead.push(n);
      if (m.ref != null && r[m.ref]) leadRef = clean(leadRef + " " + clean(r[m.ref]));
      continue;
    }
    if (r.map(low).join("|") === headerSig) continue; // header repeated on the next page
    const cell = (k) => (m[k] == null ? "" : clean(r[m[k]]));
    const text = clean(r.join(" "));
    if (!text) continue;
    if (FOOTER_RE.test(text)) { summary = true; continue; }
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
    if (COUNT_RE.test(text)) {
      // "No Of Transaction(s) : 9 11" → 9 debits, 11 credits
      const nums = (text.split(/:/).pop().match(/\b\d+\b/g) || []).map(Number);
      if (debit != null || credit != null) counts = { debit: debit ?? 0, credit: credit ?? 0 };
      else if (nums.length >= 2) counts = { debit: nums[0], credit: nums[1] };
      summary = true; continue;
    }
    if (OPEN_RE.test(narr) || (!d && OPEN_RE.test(text))) {
      // "Balance B/F" at the top of each page repeats the running balance: only the first one is the opening
      if (!out.length && opening == null) { if (bal != null) opening = bal; else if (credit ?? debit) opening = credit ?? -debit; }
      summary = false; continue;
    }
    if (CLOSE_RE.test(narr) || (!d && CLOSE_RE.test(text))) { if (bal != null) closing = bal; summary = true; continue; }
    if (TOTAL_RE.test(clean(r[0])) || TOTAL_RE.test(narr) || /^totals?\s*:/i.test(text)) {
      if (debit != null || credit != null) totals = { debit: debit || 0, credit: credit || 0 };
      summary = true; continue;
    }
    // the cheque column sometimes shares its place with the value date: keep only the cheque/reference number
    const ref = cell("ref").split(" ").filter((t) => !isDateText(t)).join(" ");
    const moneyCells = [cell("debit"), cell("credit"), cell("amount"), cell("balance")].join(" ");
    if ((debit || credit) && (d || (lastDate && MONEY.test(moneyCells)))) {
      const full = lead.length ? [...lead, narr].reduce((a, b) => joinNarration(a, b), "") : narr;
      const cheque = leadRef ? clean(leadRef + " " + ref) : ref;
      lead = []; leadRef = "";
      out.push({ date: d || lastDate, narration: full, ref: cheque, debit: debit || 0, credit: credit || 0, balance: bal });
      if (d) lastDate = d;
      summary = false;
    } else if (!d && out.length && !summary && narr && !debit && !credit && bal == null) {
      lead = []; leadRef = "";
      // narration wrapped onto the next line (also across a page break)
      const last = out[out.length - 1];
      last.narration = joinNarration(last.narration, narr);
      if (m.ref != null && ref && !last.ref.endsWith(ref)) last.ref = clean(last.ref + ref);
    }
  }
  return { rows: out, opening, closing, counts, totals, columns: Object.keys(m) };
}

const r2 = (x) => Math.round(x * 100) / 100;
/**
 * Checks each row against the running balance. Rows without a printed balance are checked together with the next row
 * that has one (and the last ones against the closing balance). Statements listed newest-first are turned round.
 * Returns the rows in date order with ok=true/false on each (null: nothing to check against).
 */
export function checkBalances(rows, opening = null, closing = null) {
  const run = (list) => {
    const res = list.map((x) => ({ ...x }));
    let base = opening, acc = 0, pend = [], bad = 0, checked = 0;
    const mark = (ok) => { for (const j of pend) { res[j].ok = ok; checked++; if (!ok) bad++; } pend = []; acc = 0; };
    res.forEach((x, i) => {
      acc = r2(acc + x.credit - x.debit);
      pend.push(i);
      if (x.balance == null) { x.ok = null; return; }
      if (base == null) base = r2(x.balance - acc);
      const want = r2(base + acc);
      const ok = Math.abs(want - x.balance) < 0.011;
      if (!ok) x.expected = want;
      mark(ok);
      base = x.balance;
    });
    if (pend.length && base != null && closing != null) mark(Math.abs(r2(base + acc) - closing) < 0.011);
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
  const c = checkBalances(p.rows, p.opening, p.closing);
  const okShare = c.checked ? (c.checked - c.bad) / c.checked : 0;
  const datesInOrder = c.rows.every((x, i) => i === 0 || x.date >= c.rows[i - 1].date);
  // the bank's own count and totals at the end of the statement, when it prints them
  const warnings = [];
  const nd = c.rows.filter((x) => x.debit).length, nc = c.rows.filter((x) => x.credit).length;
  if (p.counts && (p.counts.debit !== nd || p.counts.credit !== nc))
    warnings.push(`The statement says ${p.counts.debit} withdrawals and ${p.counts.credit} deposits; ${nd} and ${nc} were read.`);
  const sum = (k) => r2(c.rows.reduce((a, x) => a + x[k], 0));
  const totalsOk = !p.totals || (Math.abs(sum("debit") - p.totals.debit) < 0.011 && Math.abs(sum("credit") - p.totals.credit) < 0.011);
  return { ...p, rows: c.rows, bad: c.bad, checked: c.checked, reversed: c.reversed, warnings,
    // Trusted only when every row is covered by a printed balance, nearly all add up, and the bank's count agrees.
    ok: c.checked === c.rows.length && okShare >= 0.98 && datesInOrder && !warnings.length, totals_match: p.totals ? totalsOk : null };
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


/**
 * Horizontal rules (table row borders) of a PDF page, from pdf.js's operator list: [{ y, x1, x2 }] with y from the top of the
 * page like the text items. Stroked lines, the top and bottom edges of stroked boxes, and thin filled bars all count.
 * `ops` is { fnArray, argsArray }, `OPS` pdf.js's operator numbers, `height` the page height.
 */
export function horizontalRules(ops, OPS, height) {
  const out = [];
  if (!ops || !OPS) return out;
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const pt = (x, y) => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
  const add = (a, b) => { // a, b: page-space points
    if (Math.abs(a[1] - b[1]) <= 0.6 && Math.abs(a[0] - b[0]) >= 12) out.push({ y: height - (a[1] + b[1]) / 2, x1: Math.min(a[0], b[0]), x2: Math.max(a[0], b[0]) });
  };
  const paints = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter((x) => x != null));
  const filled = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter((x) => x != null));
  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i], a = ops.argsArray[i];
    if (f === OPS.save) stack.push(ctm);
    else if (f === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === OPS.transform && Array.isArray(a) && a.length >= 6) ctm = mul(a.slice(0, 6), ctm);
    else if (f === OPS.constructPath && Array.isArray(a) && paints.has(a[0]) && a[1] && a[1][0]) {
      // path data: 0 = moveTo x y, 1 = lineTo x y, 4 = closePath (curves 2 and 3 are skipped over)
      const d = Array.from(a[1][0]), shape = [];
      let k = 0, start = null, prev = null;
      const flush = () => {
        if (shape.length === 2 && !filled.has(a[0])) add(shape[0], shape[1]); // a single stroked line
        // a closed box 4 points wide: a thin filled bar is one rule; a stroked box gives its top and bottom edges
        if (shape.length >= 4 && shape.length <= 5) {
          const ys = shape.map((q) => q[1]), xs = shape.map((q) => q[0]);
          const h = Math.max(...ys) - Math.min(...ys), w = Math.max(...xs) - Math.min(...xs);
          if (filled.has(a[0]) && h <= 2.5 && w >= 12) out.push({ y: height - (Math.max(...ys) + Math.min(...ys)) / 2, x1: Math.min(...xs), x2: Math.max(...xs) });
          else if (h > 2.5 && w >= 12) { out.push({ y: height - Math.max(...ys), x1: Math.min(...xs), x2: Math.max(...xs) }, { y: height - Math.min(...ys), x1: Math.min(...xs), x2: Math.max(...xs) }); }
        }
        shape.length = 0;
      };
      while (k < d.length) {
        const c = d[k];
        if (c === 0) { flush(); prev = pt(d[k + 1], d[k + 2]); start = prev; shape.push(prev); k += 3; }
        else if (c === 1) { const q = pt(d[k + 1], d[k + 2]); shape.push(q); prev = q; k += 3; }
        else if (c === 2) { prev = pt(d[k + 5], d[k + 6]); k += 7; }
        else if (c === 3) { prev = pt(d[k + 3], d[k + 4]); k += 5; }
        else if (c === 4) { if (start) shape.push(start); k += 1; }
        else break;
      }
      flush();
    }
  }
  return out;
}

/** Row borders of one page, tidied: close together = one, and only rules that cross most of the table count. */
function pageRules(rules, left, right) {
  const span = Math.max(1, right - left), ys = [];
  for (const r of (rules || []).slice().sort((a, b) => a.y - b.y)) {
    if (r.x2 - r.x1 < span * 0.6 || r.x1 > left + span * 0.4 || r.x2 < left + span * 0.6) continue;
    if (!ys.length || r.y - ys[ys.length - 1] > 1.2) ys.push(r.y);
  }
  return ys;
}


/**
 * A narration longer than one line is printed over several lines, and the date and amounts may sit on any of them (middle,
 * last…). Lines printed above the date/amount line belong to THAT transaction, not to the one above it. Which transaction a
 * narration-only line belongs to is decided by the table's own row borders when the PDF has them; otherwise by the larger
 * gap at a row boundary (lines inside one cell are evenly spaced, the cell padding makes the gap between cells bigger).
 * Marks such lines `lead` (rows[i].lead = true) so parseTable puts them in front of the next transaction's narration.
 */
function markLeadLines(lines, rows, map, pages, headSig, left, right) {
  const col = (r, k) => (map[k] == null ? "" : clean(r[map[k]]));
  const kind = rows.map((r, i) => {
    const text = clean(r.join(" "));
    if (!text) return "blank";
    if (r.map((x) => x.toLowerCase().replace(/[:#*]/g, "").trim()).join("|") === headSig) return "head";
    if (FOOTER_RE.test(text) || OPEN_RE.test(text) || CLOSE_RE.test(text) || TOTAL_RE.test(clean(r[0])) || COUNT_RE.test(text)) return "other";
    const money = amount(col(r, "debit")) || amount(col(r, "credit")) || (map.amount != null && amount(col(r, "amount")));
    if (date(col(r, "date")) && money) return "txn";
    if (!date(col(r, "date")) && !money && !col(r, "balance") && (col(r, "narration") || col(r, "ref"))) return "narr";
    return "other";
  });
  const lead = new Array(rows.length).fill(false);
  const byPage = new Map();
  lines.forEach((l, i) => { if (!byPage.has(l.page)) byPage.set(l.page, []); byPage.get(l.page).push(i); });
  let evidence = false;
  const pending = []; // pages without usable borders: handled by spacing
  for (const [pg, idx] of byPage) {
    const txns = idx.filter((i) => kind[i] === "txn");
    if (!txns.length) continue;
    const ys = pageRules(pages[pg]?.rules, left, right);
    const band = (y) => ys.filter((v) => v < y - 0.5).length;
    const bands = txns.map((i) => band(lines[i].y));
    // borders are trusted when every transaction has a band of its own, with a border between each pair
    if (ys.length >= txns.length && new Set(bands).size === bands.length) {
      for (const i of idx) {
        if (kind[i] !== "narr") continue;
        const t = txns.find((j) => band(lines[j].y) === band(lines[i].y));
        if (t != null && lines[i].y < lines[t].y - 1) { lead[i] = true; evidence = true; }
      }
    } else pending.push([pg, idx, txns]);
  }
  for (const [, idx, txns] of pending) {
    for (let t = 0; t + 1 < txns.length; t++) {
      const a = txns[t], b = txns[t + 1];
      const mid = idx.filter((i) => i > a && i < b);
      if (!mid.length || mid.some((i) => kind[i] !== "narr")) continue;
      const ys = [lines[a].y, ...mid.map((i) => lines[i].y), lines[b].y];
      const gaps = ys.slice(1).map((y, k) => y - ys[k]);
      const sorted = gaps.slice().sort((x, y) => y - x);
      if (sorted[0] - sorted[1] < 2.5 || sorted[0] < sorted[1] * 1.25) continue; // an even column of lines: all belong to the transaction above
      const cut = gaps.indexOf(sorted[0]); // lines at positions > cut start the next transaction
      mid.slice(cut).forEach((i) => { lead[i] = true; evidence = true; });
    }
  }
  // once the layout is known to print lines above the amounts, those after a page's heading line belong to its first transaction
  for (const [, idx, txns] of pending) {
    const first = txns[0];
    if (evidence) {
      const heads = idx.filter((i) => kind[i] === "head" && i < first);
      {
        const from = heads.length ? heads[heads.length - 1] : idx[0] === 0 ? -1 : null; // the first page's heading is above the body
        if (from != null) idx.filter((i) => i > from && i < first && kind[i] === "narr").forEach((i) => { lead[i] = true; });
      }
    }
  }
  rows.forEach((r, i) => { if (lead[i]) r.lead = true; });
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
  const body = [];
  for (let i = best.line + 1; i < allLines.length; i++) { const row = toCells(allLines[i]); body.push(row); rows.push(row); }
  markLeadLines(allLines.slice(best.line + 1), body, best.h.map, pages, cols.map((c) => c.s.toLowerCase().replace(/[:#*]/g, "").trim()).join("|"), cols[0].x, cols[cols.length - 1].x + cols[cols.length - 1].w);
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

// ---------------------------------------------------------------- who is on the other side of a statement line
const BANKISH = /\b(BANK|BRANCH|BR|SEQ|CHQ|CHEQUE|MICR|CTS|CLEARING|CLG|PHONEPE|GPAY|PAYTM|GOOGLE|BHIM|TFR|TRF|DEBIT|CREDIT|UPI|NEFT|RTGS|IMPS|PAYMENT|FROM|REF)\b/;
/**
 * Names that could be the other party in a narration, best first. Understands cheque clearing
 * ("By-Clearing SAMPLE PARTY ONE, Chq : 100003, Seq : …, Bank : …"), UPI
 * ("UPI/356…/DEBIT/VIJAYALAXMI TEXTILES/PUNB…/vpa@bank/…") and NEFT / RTGS / IMPS style lines.
 * Only suggestions: the app never assigns a party from these on its own.
 */
export function partyNamesFrom(narration) {
  const s = clean(narration).toUpperCase();
  const out = [];
  const add = (n) => {
    n = String(n || "").replace(/\s+/g, " ").replace(/^[\s,.\-:;/]+|[\s,.\-:;/]+$/g, "").trim();
    if (n.replace(/[^A-Z]/g, "").length >= 3 && !/@/.test(n) && !IFSC.test(n) && !out.includes(n)) out.push(n);
  };
  let m = s.match(/(?:CLEARING|CLG|CHQ DEP(?:OSIT)?|CHEQUE DEP(?:OSIT)?)\s*[-:/ ]+\s*([A-Z][A-Z .&'()\-]*?)\s*(?:,|;|\bCHQ\b|\bCHEQUE\b|\bSEQ\b|\bBANK\b|\bBR\b|\bINST\b|$)/);
  if (m) add(m[1]);
  m = s.match(/UPI[\/\-][^\/]*?\d{6,}[\/\-](?:DEBIT|CREDIT|DR|CR)[\/\-]([A-Z][A-Z .&']+?)[\/\-]/) || s.match(/UPI[\/\-](?:DR|CR)[\/\-]\d{6,}[\/\-]([A-Z][A-Z .&']+?)[\/\-]/);
  if (m) add(m[1]);
  for (const seg of s.split(/[\/\-,:*|;]+/)) {
    const words = seg.split(/\s+/).filter(Boolean);
    if (!words.length || words.some((w) => /\d/.test(w) || IFSC.test(w) || /@/.test(w))) continue;
    const kept = words.filter((w) => /^[A-Z.&']+$/.test(w) && !KIND_WORDS.test(w) && !NOISE.has(w));
    if (kept.length < words.length - 1 || BANKISH.test(seg)) continue;
    add(kept.join(" "));
  }
  return out.slice(0, 4);
}
/** The cheque number in a clearing narration ("Chq : 100003"), or "". */
export function chequeNo(narration) {
  const m = /\bCH(?:Q|EQUE)\s*(?:NO\.?)?\s*[:.#-]?\s*(\d{4,9})/i.exec(clean(narration));
  return m ? m[1] : "";
}
/** Bill / invoice numbers written in a narration ("INV 123", "Bill no. A/45"), to pre-select matching open bills. */
export function billHints(narration) {
  const out = new Set();
  const re = /\b(?:INV(?:OICE)?|BILL|BL)\s*(?:NO\.?|NUMBER|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\/\-]{1,19})/gi;
  let m;
  while ((m = re.exec(clean(narration)))) if (/\d/.test(m[1])) out.add(m[1].toUpperCase());
  return [...out];
}
