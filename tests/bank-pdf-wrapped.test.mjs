// Narrations that wrap over several lines, where the date and amounts are printed on the middle or last line of the cell
// (so some narration lines sit ABOVE the amounts): each line must go to its own transaction. All data here is made up.
import test from "node:test";
import assert from "node:assert/strict";
import * as B from "../public/bankparse.js";

const COLS = [["Date", 30], ["Cheque No", 100], ["Withdrawal", 160], ["Deposit", 230], ["Balance", 300], ["Narration", 430]];
const LH = 11, PAD = 9;
const it = (y, x, s) => ({ s, x, y, w: s.length * 4.5 });
// rows are listed as the statement prints them (newest first)
const ROWS = [
  { d: "13/10/2026", dr: "20,000.00", bal: "175,239.31", n: ["ATM WDR 0001 SAMPLE \\Test Peth", "\\ Town"] },
  { d: "13/10/2026", cr: "100,000.00", bal: "195,239.31", n: ["UPI/CR/000000000001/TESTPARTY/BANK/test@a", "xl/Pa"] },
  { d: "12/10/2026", cr: "20,225.00", bal: "95,239.31", n: ["SAMPLE ENTERPRISES -186110"] },
  { d: "11/10/2026", dr: "10,602.00", bal: "75,014.31", n: ["IMPS-", "OUT/000000000002/BANK0TEST/4526020000041", "1"] },
  { d: "09/10/2026", cr: "23,990.00", bal: "85,616.31", n: ["UPI/CR/000000000003/NAME ONE", "SHA/BANK/one@okici/"] },
  { d: "09/10/2026", dr: "8,142.00", bal: "61,626.31", n: ["NEFT_OUT:BANK000000000004/Name two ent", "/TEST0000VSB/002008200000231"] },
];
const WANT = [
  "ATM WDR 0001 SAMPLE \\Test Peth \\ Town",
  "UPI/CR/000000000001/TESTPARTY/BANK/test@axl/Pa",
  "SAMPLE ENTERPRISES -186110",
  "IMPS-OUT/000000000002/BANK0TEST/45260200000411",
  "UPI/CR/000000000003/NAME ONE SHA/BANK/one@okici/",
  "NEFT_OUT:BANK000000000004/Name two ent /TEST0000VSB/002008200000231",
];

function page(rows, align, { rules = true, top = 100 } = {}) {
  const items = [], ruleList = [];
  COLS.forEach(([h, x]) => items.push(it(top, x, h)));
  let y = top + 8; // the heading's own border
  ruleList.push({ y, x1: 20, x2: 580 });
  rows.forEach((r) => {
    const n = r.n.length, h = n * LH + 2 * PAD, top0 = y + PAD;
    const lines = r.n.map((_, k) => top0 + LH * (k + 0.5) + 3);
    const own = align === "middle" ? (lines[0] + lines[n - 1]) / 2 : align === "bottom" ? lines[n - 1] : lines[0];
    r.n.forEach((s, k) => items.push(it(lines[k], 430, s)));
    items.push(it(own, 30, r.d));
    if (r.dr) items.push(it(own, 160 + 60 - r.dr.length * 4.5, r.dr));
    if (r.cr) items.push(it(own, 230 + 60 - r.cr.length * 4.5, r.cr));
    items.push(it(own, 300 + 70 - r.bal.length * 4.5, r.bal + " Cr."));
    y += h;
    ruleList.push({ y, x1: 20, x2: 580 });
  });
  return { items, rules: rules ? ruleList : [] };
}

for (const align of ["middle", "bottom", "top"]) {
  for (const rules of [true, false]) {
    test(`wrapped narrations stay with their own transaction (${align}-aligned text, ${rules ? "with" : "without"} row borders)`, () => {
      const r = B.fromPdfPages([page(ROWS.map((x) => ({ ...x })), align, { rules })]);
      assert.equal(r.rows.length, 6, JSON.stringify(r.rows));
      // the statement is newest first; rows come back oldest first
      assert.deepEqual(r.rows.map((x) => x.narration), [...WANT].reverse());
      assert.deepEqual(r.rows.map((x) => x.debit || -x.credit), [8142, -23990, 10602, -20225, -100000, 20000]);
      assert.equal(r.ok, true);
    });
  }
}

test("evenly spaced wrapped lines with no padding still belong to the transaction above (older layouts)", () => {
  const items = [];
  COLS.forEach(([h, x]) => items.push(it(100, x, h)));
  items.push(it(112, 30, "01/10/2026"), it(112, 160 + 60 - 8 * 4.5, "500.00"), it(112, 300 + 70 - 9 * 4.5, "1,500.00 Cr."), it(112, 430, "First part"),
    it(124, 430, "second part"), it(136, 30, "02/10/2026"), it(136, 230 + 60 - 8 * 4.5, "250.00"), it(136, 300 + 70 - 9 * 4.5, "1,750.00 Cr."), it(136, 430, "Other"));
  const r = B.fromPdfPages([{ items }]);
  assert.deepEqual(r.rows.map((x) => x.narration), ["First part second part", "Other"]);
});

test("a bare 'Page No 1' line is not part of a narration", () => {
  const rows = [["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
    ["01/10/2026", "NEFT sample", "", "100.00", "1,100.00"], ["", "Page No 1 -", "", "", ""]].map((r) => r.join("\t")).join("\n");
  assert.equal(B.fromSheetText(rows).rows[0].narration, "NEFT sample");
});

test("joinNarration glues cuts inside words and keeps spaces elsewhere", () => {
  assert.equal(B.joinNarration("x/vijtexkvb@a", "xl/Pa"), "x/vijtexkvb@axl/Pa");
  assert.equal(B.joinNarration("IMPS-", "OUT/1"), "IMPS-OUT/1");
  assert.equal(B.joinNarration("REF 4526020000041", "1"), "REF 45260200000411");
  assert.equal(B.joinNarration("UPI/CR/1/AJAY", "SHA/BARB"), "UPI/CR/1/AJAY SHA/BARB");
  assert.equal(B.joinNarration("Paid 5", "1 day"), "Paid 5 1 day");
});

test("horizontalRules reads stroked lines, boxes and thin bars from a pdf.js operator list", () => {
  const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, stroke: 20, fill: 22 };
  const ops = {
    fnArray: [12, 10, 12, 91, 91, 91, 11, 91],
    argsArray: [[1, 0, 0, 1, 0, 0], null, [1, 0, 0, 1, 50, 400],
      [20, [[0, 0, 100, 1, 300, 100]], null],                          // a line: y 500 in page space
      [20, [[0, 0, 60, 1, 300, 60, 1, 300, 40, 1, 0, 40, 4]], null],  // a stroked box: edges at 460 and 440
      [22, [[0, 0, 20, 1, 300, 20, 1, 300, 21, 1, 0, 21, 4]], null],  // a thin filled bar: 420.5
      null, [20, [[0, 0, 5, 1, 4, 5]], null]],                         // too short, and outside the transform
  };
  const r = B.horizontalRules(ops, OPS, 800).map((x) => Math.round(x.y * 10) / 10).sort((a, b) => a - b);
  assert.deepEqual(r, [300, 340, 360, 379.5]);
});
