// Purchase-bill clean-up that runs on what the reader returned, before anything is saved:
//   1. Dozen → pieces. The company keeps every item in PCS, suppliers sometimes bill in DOZ/DZ/DZN.
//      120 dz @ 85 becomes 1440 pcs @ 7.0833; the line amount (what the supplier billed) never changes.
//   2. A discount printed as its own line ("Less: Discount", "Discount 1%") is removed and spread over every item line
//      as a discount %, with the line amounts reduced to match, so taxable value, GST and total stay exact.
// Pure functions only (no database), so they are easy to test. Everything uncertain is reported in `review`.
const r2 = (v) => Math.round((+v + Number.EPSILON) * 100) / 100;
const r4 = (v) => Math.round((+v + Number.EPSILON) * 10000) / 10000;
const num = (v) => (v == null || v === "" || Number.isNaN(+v) ? null : +v);
const cleanUnit = (u) => String(u || "").trim().toLowerCase().replace(/[\s.]+$/g, "").replace(/^[\s.]+/g, "");

export const isDozen = (u) => /^(dz|dzn|dzs|doz|dozs|dozen|dozens)$/.test(cleanUnit(u));
export const isPieces = (u) => { const c = cleanUnit(u); return c === "" || /^(pc|pcs|piece|pieces|nos|no|number|numbers|unit|units|ea|each)$/.test(c); };
const near = (a, b, abs = 0.6, rel = 0.002) => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));

/** What a line's amount should be for a given quantity (in the unit the rate is for) and rate, after the line's discount %. */
const expected = (qty, rate, disc) => qty * rate * (1 - (disc || 0) / 100);

/**
 * One item line. Returns { line, note?, review? } — `line` is a copy with unit PCS when a dozen was found.
 * The line amount is kept exactly as the supplier billed it.
 */
export function dozenToPieces(l) {
  const qty = num(l.qty), alt = num(l.alt_qty), rate = num(l.rate), disc = num(l.discount_pct) || 0, amount = num(l.amount);
  const unitDz = isDozen(l.unit), altDz = isDozen(l.alt_unit);
  if (!unitDz && !altDz) {
    // Pieces only. One thing is still suspicious: the item name says "20 DOZ", the quantity is 20, but the unit reads PCS.
    const m = /(\d+(?:\.\d+)?)\s*(?:dz|dzn|doz|dozen)\b/i.exec(String(l.description || ""));
    if (m && isPieces(l.unit) && qty != null && Math.abs(qty - +m[1]) < 1e-9 && qty !== +m[1] * 12)
      return { line: l, review: `"${l.description}": the name says ${m[1]} dozen but the quantity ${qty} is marked PCS — if it is dozens, change it to ${r2(qty * 12)} pcs and the rate to ₹${rate != null ? r4(rate / 12) : "…"} per pc.` };
    return { line: l };
  }
  const out = { ...l };
  const pcsOf = (dz) => Math.round(dz * 12 * 1e6) / 1e6;

  // How many dozens and how many pieces the bill says, when both are printed they must agree.
  let dz = null, pcs = null, source = "";
  if (unitDz && qty != null) { dz = qty; source = "dozen column"; }
  else if (altDz && alt != null) { dz = alt; source = "dozen shown beside the pieces"; }
  if (isPieces(l.unit) && qty != null && altDz) pcs = qty;
  if (isPieces(l.alt_unit) && alt != null && unitDz) pcs = alt;
  if (dz == null) return { line: l, review: `Unit says dozen but no quantity could be read — check "${l.description || "this line"}".` };
  if (pcs != null && !near(pcs, pcsOf(dz), 0.5, 0.0005))
    return { line: l, review: `"${l.description || "line"}": ${dz} dozen is ${pcsOf(dz)} pcs but the bill also shows ${pcs} pcs — please check the quantity.` };
  const finalPcs = pcs != null ? pcs : pcsOf(dz);

  // Which quantity was the rate for? Whichever one reproduces the printed amount.
  let rateIsPerDozen = true;
  if (rate != null && amount != null && amount > 0) {
    const perDz = near(expected(dz, rate, disc), amount) || near(expected(dz, rate, 0), amount);
    const perPc = near(expected(finalPcs, rate, disc), amount) || near(expected(finalPcs, rate, 0), amount);
    if (perDz && !perPc) rateIsPerDozen = true;
    else if (perPc && !perDz) rateIsPerDozen = false;
    else if (!perDz && !perPc) {
      return { line: l, review: `"${l.description || "line"}": ${dz} dozen × ₹${rate} does not give ₹${amount} either per dozen or per piece — please check the rate and amount.` };
    }
  }
  const newRate = rate == null ? null : r4(rateIsPerDozen ? rate / 12 : rate);
  out.qty = finalPcs; out.unit = "PCS"; out.alt_qty = null; out.alt_unit = ""; out.rate = newRate;
  if (!(amount > 0) && newRate != null) out.amount = r2(expected(finalPcs, newRate, disc));
  const note = `${l.description || "Line"}: ${dz} dozen${rate != null ? ` @ ₹${rate}${rateIsPerDozen ? " per dozen" : " (already per piece)"}` : ""} → ${finalPcs} pcs${newRate != null ? ` @ ₹${newRate} per pc` : ""} (${source}; amount unchanged ₹${out.amount})`;
  return { line: out, note };
}

const DISCOUNT_DESC = /^\s*(less\s*[:\-]?\s*)?((trade|cash|special|additional|extra|bulk|scheme|quantity|qty)\s+)?(discount|disc\b\.?|rebate|scheme)/i;
const pctIn = (s) => { const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(s || "")); return m ? +m[1] : null; };
/** A line that is only a discount (not an item): described as discount, and negative or "less". */
export const isDiscountLine = (l) => DISCOUNT_DESC.test(String(l.description || "")) && !num(l.qty) && (num(l.amount) != null || pctIn(l.description) != null);

/**
 * Spread separate discount line(s) over the item lines.
 * items / others: the reader's item lines and charge lines. Returns { items, others, notes, review }.
 */
export function spreadDiscount(items, others) {
  const all = [...items.map((l) => ({ l, src: "items" })), ...others.map((l) => ({ l, src: "others" }))];
  const disc = all.filter((x) => isDiscountLine(x.l));
  if (!disc.length) return { items, others, notes: [], review: [] };
  const keepItems = items.filter((l) => !isDiscountLine(l)), keepOthers = others.filter((l) => !isDiscountLine(l));
  const review = [], notes = [];
  const itemLines = keepItems.filter((l) => num(l.amount) != null);
  const gross = r2(itemLines.reduce((a, l) => a + (num(l.amount) || 0), 0));
  const label = disc.map((d) => String(d.l.description || "Discount").trim()).join(" + ");
  if (!itemLines.length || gross <= 0) return { items, others, notes: [], review: [`A separate discount line "${label}" was found but there are no item amounts to apply it to — check the invoice.`] };
  if (itemLines.some((l) => (num(l.discount_pct) || 0) > 0))
    return { items, others, notes: [], review: [`This invoice has item-wise discount % and a separate discount line "${label}" — please check how the discount should apply.`] };

  const amountSum = r2(disc.reduce((a, d) => a + Math.abs(num(d.l.amount) || 0), 0));
  const descPct = disc.length === 1 ? pctIn(disc[0].l.description) : null;
  let total = amountSum, pct;
  if (amountSum > 0) {
    pct = (total / gross) * 100;
    if (descPct != null && Math.abs(descPct - pct) <= 0.05) { pct = descPct; total = r2(gross * descPct / 100); }
    else if (descPct != null) review.push(`The discount line says ${descPct}% but ₹${amountSum} of ₹${gross} is ${r4(pct)}% — the amount was used; please check.`);
  } else { pct = descPct; total = r2(gross * descPct / 100); }
  if (!(pct > 0) || pct >= 100) return { items, others, notes: [], review: [`Could not work out a sensible discount % from "${label}" — check the invoice.`] };

  // Each line gets the same % and its share in rupees; paise left over go to the largest line so the total is exact.
  const shares = itemLines.map((l) => r2((num(l.amount) * total) / gross));
  const diff = r2(total - shares.reduce((a, b) => a + b, 0));
  if (diff) { const big = itemLines.reduce((bi, l, i) => (num(l.amount) > num(itemLines[bi].amount) ? i : bi), 0); shares[big] = r2(shares[big] + diff); }
  const shown = r4(pct);
  let k = 0;
  const outItems = keepItems.map((l) => {
    if (num(l.amount) == null) return l;
    const share = shares[k++];
    return { ...l, discount_pct: shown, amount: r2(num(l.amount) - share) };
  });
  notes.push(`Discount "${label}" ₹${total} removed as a separate line and applied as ${shown}% on every item (taxable value ₹${r2(gross - total)}).`);
  return { items: outItems, others: keepOthers, notes, review };
}

/**
 * Both clean-ups on one extraction. `data` is what the reader returned.
 * Returns { lines, charges, notes, review } — same shapes the reader uses.
 */
export function normalizePurchase(data) {
  const notes = [], review = [];
  const converted = (data.lines || []).map((l) => {
    const r = dozenToPieces(l);
    if (r.note) notes.push(r.note);
    if (r.review) review.push(r.review);
    return r.line;
  });
  const spread = spreadDiscount(converted, data.charges || []);
  notes.push(...spread.notes); review.push(...spread.review);
  return { lines: spread.items, charges: spread.others, notes, review };
}
