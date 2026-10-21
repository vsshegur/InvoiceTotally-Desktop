// Bank statements: reading without AI, balance checks, narration keys.
import test from "node:test";
import assert from "node:assert/strict";
import * as B from "../public/bankparse.js";

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

test("amounts and dates as banks print them", () => {
  assert.equal(B.amount("1,23,456.78"), 123456.78);
  assert.equal(B.amount("₹ 500.00"), 500);
  assert.equal(B.amount("(250.50)"), -250.5);
  assert.equal(B.amount("250.50-"), -250.5);
  assert.equal(B.amount(""), null);
  assert.equal(B.amount("--"), null);
  assert.equal(B.balance("12,345.00 Cr"), 12345);
  assert.equal(B.balance("500.00 Dr"), -500);
  assert.equal(B.date("05/10/26"), "2026-10-05");
  assert.equal(B.date("05-10-2026"), "2026-10-05");
  assert.equal(B.date("5 Oct 2026"), "2026-10-05");
  assert.equal(B.date("05-OCT-26"), "2026-10-05");
  assert.equal(B.date("Oct 5, 2026"), "2026-10-05");
  assert.equal(B.date("2026-10-05"), "2026-10-05");
  assert.equal(B.date("05.10.2026 10:42:11"), "2026-10-05");
  assert.equal(B.date("31/02/2026"), null);
  assert.equal(B.date("Narration"), null);
});

test("HDFC-style Excel: separate withdrawal/deposit, wrapped narration", () => {
  const text = tsv([
    ["HDFC BANK Ltd.", "", "", "", "", "", ""],
    ["Statement of account", "", "", "", "", "", ""],
    ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
    ["01/10/26", "NEFT CR-SBIN0001234-SHREE GANESH TRADERS-INV 245", "SBIN126274", "01/10/26", "", "42,212.00", "1,42,212.00"],
    ["02/10/26", "UPI-RAMESH KUMAR-ramesh@okaxis-SBIN0001-627412345678", "0000627412345678", "02/10/26", "1,500.00", "", "1,40,712.00"],
    ["", "-PAYMENT FOR CARTONS", "", "", "", "", ""],
    ["03/10/26", "CHQ PAID-MICR CTS-SHRINIWAS SHANKAR ADAM", "000123", "03/10/26", "20,000.00", "", "1,20,712.00"],
    ["", "", "", "", "", "", ""],
    ["Opening Balance", "Dr Count", "Cr Count", "Debits", "Credits", "Closing Bal", ""],
  ]);
  const r = B.fromSheetText(text);
  assert.equal(r.rows.length, 3);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.rows[0].credit, 42212);
  assert.equal(r.rows[1].debit, 1500);
  assert.equal(r.rows[1].narration, "UPI-RAMESH KUMAR-ramesh@okaxis-SBIN0001-627412345678 -PAYMENT FOR CARTONS");
  assert.equal(r.rows[2].ref, "000123");
  assert.ok(r.rows.every((x) => x.ok));
});

test("SBI-style: Txn Date + Value Date, Debit/Credit, opening balance row", () => {
  const text = tsv([
    ["Account Name", "VIPUL TEXTILES"], ["Account Number", "00000012345678901"],
    ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
    ["", "", "Balance B/F", "", "", "", "10,000.00"],
    ["1 Oct 2026", "1 Oct 2026", "BY TRANSFER-NEFT*HDFC0000123*SHREE GANESH", "TRANSFER FROM 1234", "", "5,000.00", "15,000.00"],
    ["2 Oct 2026", "2 Oct 2026", "TO TRANSFER-INB IMPS/P2A/627400001/RAMESH", "TRANSFER TO 99", "2,000.00", "", "13,000.00"],
    ["3 Oct 2026", "3 Oct 2026", "CASH DEPOSIT SELF", "", "", "7,000.00", "20,000.00"],
  ]);
  const r = B.fromSheetText(text);
  assert.equal(r.opening, 10000);
  assert.equal(r.rows.length, 3);
  assert.ok(r.ok);
  assert.equal(r.rows[0].date, "2026-10-01");
});

test("co-operative bank: single Amount column with Dr/Cr and Cr/Dr balances", () => {
  const text = tsv([
    ["THE XYZ SAHAKARI BANK LTD"],
    ["Date", "Particulars", "Chq No", "Amount", "Dr/Cr", "Balance"],
    ["01-10-2026", "By Clg Shree Ganesh Traders", "456789", "12,000.00", "Cr", "62,000.00 Cr"],
    ["02-10-2026", "To Chq 100234 Self", "100234", "5,000.00", "Dr", "57,000.00 Cr"],
    ["03-10-2026", "SMS Charges", "", "17.70", "Dr", "56,982.30 Cr"],
  ]);
  const r = B.fromSheetText(text);
  assert.equal(r.rows.length, 3);
  assert.ok(r.ok, JSON.stringify(r.rows));
  assert.deepEqual(r.rows.map((x) => [x.debit, x.credit]), [[0, 12000], [5000, 0], [17.7, 0]]);
});

test("overdraft (Dr balance) and newest-first statements", () => {
  const text = tsv([
    ["Tran Date", "Particulars", "Withdrawals", "Deposits", "Balance"],
    ["03/10/2026", "INT CHARGED ON CC", "1,000.00", "", "11,000.00 Dr"],
    ["02/10/2026", "NEFT RECEIVED ABC", "", "5,000.00", "10,000.00 Dr"],
    ["01/10/2026", "RTGS PAID XYZ", "15,000.00", "", "15,000.00 Dr"],
  ]);
  const r = B.fromSheetText(text);
  assert.ok(r.reversed);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.rows[0].date, "2026-10-01");
  assert.equal(r.rows[2].balance, -11000);
});

test("a misread amount is caught by the running balance", () => {
  const text = tsv([
    ["Date", "Narration", "Debit", "Credit", "Balance"],
    ["01/10/2026", "A", "", "1,000.00", "11,000.00"],
    ["02/10/2026", "B", "500.00", "", "10,050.00"],
    ["03/10/2026", "C", "50.00", "", "10,000.00"],
  ]);
  const r = B.fromSheetText(text);
  assert.ok(!r.ok);
  assert.equal(r.bad, 1);
  assert.equal(r.rows[1].ok, false);
  assert.equal(r.rows[1].expected, 10500);
});

test("no usable headings → not trusted (goes to the AI)", () => {
  const r = B.fromSheetText(tsv([["foo", "bar"], ["1", "2"]]));
  assert.ok(!r.ok);
  assert.equal(r.rows.length, 0);
});

// PDF: items with x/y from the top, like pdf.js text content.
function pdfPage(lines, cols) {
  const items = [];
  lines.forEach((cells, li) => cells.forEach((s, ci) => {
    if (!s) return;
    const right = ["Withdrawal Amt.", "Deposit Amt.", "Closing Balance"].includes(cols[ci].h) || /^[\d,.]+$/.test(s);
    const w = s.length * 4.5;
    items.push({ s, x: right ? cols[ci].x + cols[ci].w - w : cols[ci].x, y: 100 + li * 12, w });
  }));
  return { items };
}

test("digital PDF: columns rebuilt from text positions, header repeated on page 2", () => {
  const cols = [{ h: "Date", x: 30, w: 40 }, { h: "Narration", x: 80, w: 200 }, { h: "Chq./Ref.No.", x: 290, w: 70 },
    { h: "Withdrawal Amt.", x: 370, w: 70 }, { h: "Deposit Amt.", x: 450, w: 70 }, { h: "Closing Balance", x: 530, w: 70 }];
  const head = cols.map((c) => c.h);
  const p1 = pdfPage([head,
    ["01/10/26", "NEFT CR-SHREE GANESH TRADERS-INV 245", "SBIN1262", "", "42,212.00", "1,42,212.00"],
    ["02/10/26", "UPI-RAMESH KUMAR-ramesh@okaxis", "6274123", "1,500.00", "", "1,40,712.00"],
    ["", "PAYMENT FOR CARTONS", "", "", "", ""]], cols);
  const p2 = pdfPage([head,
    ["03/10/26", "CHQ PAID-SHRINIWAS SHANKAR ADAM", "000123", "20,000.00", "", "1,20,712.00"]], cols);
  const r = B.fromPdfPages([p1, p2]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[1].narration, "UPI-RAMESH KUMAR-ramesh@okaxis PAYMENT FOR CARTONS");
  assert.equal(r.rows[2].debit, 20000);
  assert.match(B.pageText(p1.items), /Withdrawal Amt\.\s+Deposit Amt\./);
});

test("narration keys group the same payer", () => {
  assert.equal(B.narrationKey("UPI/627412345678/RAMESH KUMAR/ramesh@okaxis/Payment"), "UPI:RAMESH@OKAXIS");
  assert.equal(B.narrationKey("UPI-RAMESH KUMAR-ramesh@okaxis-SBIN0001-627412345678"), "UPI:RAMESH@OKAXIS");
  assert.equal(B.narrationKey("NEFT/SBIN126274123/SHREE GANESH TRADERS/INV 245"), "NEFT:SHREE GANESH TRADERS");
  assert.equal(B.narrationKey("By Clg Shree Ganesh Traders"), "TXT:SHREE GANESH TRADERS");
  assert.equal(B.narrationKey("SMS CHARGES 1234"), "TXT:SMS CHARGES");
  assert.equal(B.narrationKey("NEFT CR-SBIN0001234-ABCABC-INV-11"), "NEFT:ABCABC");
  assert.equal(B.narrationKey("NEFT CR-SBIN0001234-ABCABC-INV-15"), "NEFT:ABCABC");
  assert.equal(B.narrationKey("IMPS-627412345-ACCUAL SOFTWARE PVT-AS/77"), "IMPS:ACCUAL SOFTWARE PVT");
  assert.equal(B.narrationKey("BY TRANSFER-NEFT*HDFC0000123*SHREE GANESH"), "NEFT:SHREE GANESH");
  assert.equal(B.narrationKey("TO TRANSFER-INB IMPS/P2A/627400001/RAMESH"), "IMPS:RAMESH");
  assert.equal(B.narrationKey("CHQ PAID-MICR CTS-SHRINIWAS SHANKAR ADAM"), "TXT:SHRINIWAS SHANKAR ADAM");
});


test("co-operative bank headings: Tran Dt, Particulars, Instr, Dr Amt, Cr Amt, Bal Amt (balance with Cr)", () => {
  const text = ["Sahakari Bank Ltd", "A/c 001234", "Tran Dt\tParticulars\tInstr\tDr Amt\tCr Amt\tBal Amt",
    "11-10-2026\tTO CLG SHREE TRADERS\t4411\t2500.00\t\t7500.00 Cr", "12-10-2026\tBY CASH\t\t\t1000.00\t8500.00 Cr"].join("\n");
  const r = B.fromSheetText(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => [x.date, x.ref, x.debit, x.credit, x.balance, x.ok]),
    [["2026-10-11", "4411", 2500, 0, 7500, true], ["2026-10-12", "", 0, 1000, 8500, true]]);
});

// A made-up statement laid out like a co-operative bank's PDF: the date is printed only on a day's first transaction
// and the balance only on its last; the cheque column also carries a value date; each page repeats the bank's heading,
// starts with "Balance B/F" and ends with "Balance C/F" and a page number; the last page has the bank's totals and
// its count of debits and credits.
test("co-operative bank PDF: date only on a day's first row, balance only on its last, B/F and C/F per page", () => {
  const W = (s) => s.length * 4.6;
  const it = (y, x, s, w = W(s)) => ({ s, x, y, w });
  const right = (y, edge, s) => it(y, edge - W(s), s); // amounts are right-aligned
  const head = (y) => [it(y, 38.5, "Date", 16.9), it(y, 83.5, "Particulars", 40.3), it(y, 226.2, "Chq No.", 29.9), it(y, 256, "Value Date", 39.9),
    it(y, 322.6, "Tran ID", 26.9), it(y, 398, "Debit", 19.5), it(y, 469.9, "Credit", 22.5), it(y, 537.7, "Balance", 29.9)];
  const top = (pg) => [it(40, 30, "Sample Sahakari Bank Limited Main Branch"), it(60, 30, "Customer ID:"), it(60, 90, "12345"),
    it(80, 30, "Current"), it(80, 70, "Balance 1200.50 Cr"), it(100, 30, `Statement Of Accounts Page No: ${pg}`), ...head(130)];
  const txn = (y, { d, narr, chq, vdate, id, dr, cr, bal, more = [] }) => [
    ...(d ? [it(y, 38.6, d, 40.5)] : []), it(y, 85.3, narr), ...(chq ? [it(y, 226.5, chq)] : []), ...(vdate ? [it(y, 256, vdate, 40.5)] : []),
    it(y, 328.5, id), right(y, 420, dr), right(y, 492, cr), ...(bal ? [right(y, 551, bal), it(y, 552, "Cr", 9)] : []),
    ...more.map((m, k) => it(y + 12 * (k + 1), 85.3, m))];
  const page1 = [...top(1),
    it(150, 85.3, "Opening Balance"), right(150, 551, "1000.00"), it(152, 552, "Cr", 9),
    ...txn(170, { d: "01/04/2026", narr: "By-Clearing ALPHA TRADERS,", chq: "100201", id: "501", dr: "0.00", cr: "5000.00", bal: "6000.00", more: ["Chq : 100201, Seq :", "BANK OF SAMPLE"] }),
    ...txn(210, { d: "03/04/2026", narr: "By-Clearing beta stores", chq: "77001", id: "502", dr: "0.00", cr: "2500.00", more: ["Chq : 77001"] }),
    ...txn(240, { narr: "By-Clearing beta stores", chq: "77002", id: "503", dr: "0.00", cr: "1500.00", more: ["Chq : 77002"] }),
    ...txn(270, { narr: "To-S TFR", id: "504", dr: "8000.00", cr: "0.00", bal: "2000.00", more: ["UPI/123456789012/DEBIT/SAMP", "LE CO/PUNB0000000/samplet", "x@axl/Payment"] }),
    it(330, 38.6, "03-04-2026", 40.5), it(330, 85.3, "Balance C/F"), right(330, 420, "8000.00"), right(330, 492, "9000.00"), right(330, 551, "2000.00"), it(330, 552, "Cr", 9),
    it(350, 200, "Page No :-"), it(350, 250, "1"), it(350, 262, "Of"), it(350, 280, "2")];
  const page2 = [...top(2),
    it(150, 38.6, "03-04-2026", 40.5), it(150, 85.3, "Balance B/F"), right(150, 551, "2000.00"), it(150, 552, "Cr", 9),
    ...txn(170, { d: "05/04/2026", narr: "To-Charges Outward Clearing", vdate: "05/04/2026", id: "601", dr: "200.00", cr: "0.00" }),
    ...txn(190, { narr: "By-Outward Return GAMMA", id: "602", dr: "0.00", cr: "800.00", bal: "2600.00" }),
    it(220, 85.3, "Closing Balance"), right(220, 420, "8200.00"), right(220, 492, "0.00"), right(220, 551, "2600.00"), it(220, 552, "Cr", 9),
    it(235, 85.3, "Total :"), right(235, 420, "8200.00"), right(235, 492, "9800.00"),
    it(250, 85.3, "No Of Tranaction(s) :"), right(250, 420, "2"), right(250, 492, "4"),
    it(270, 30, "This is a computerised statement & does not require a signature."), it(285, 30, "***End Of Statement***")];
  const r = B.fromPdfPages([{ items: page1 }, { items: page2 }]);
  assert.equal(r.rows.length, 6, JSON.stringify(r.rows.map((x) => [x.date, x.debit, x.credit])));
  assert.deepEqual(r.rows.map((x) => [x.date, x.debit, x.credit]), [
    ["2026-04-01", 0, 5000], ["2026-04-03", 0, 2500], ["2026-04-03", 0, 1500], ["2026-04-03", 8000, 0], ["2026-04-05", 200, 0], ["2026-04-05", 0, 800]]);
  assert.deepEqual([r.opening, r.closing], [1000, 2600], "the first opening balance, not a later page's B/F");
  assert.deepEqual(r.counts, { debit: 2, credit: 4 });
  assert.equal(r.totals_match, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true, "every row is checked through the next printed balance");
  assert.ok(r.rows.every((x) => x.ok === true));
  assert.equal(r.rows[1].ref, "77001");
  assert.equal(r.rows[4].ref, "", "a value date in the cheque column is not a cheque number");
  assert.equal(r.rows[3].narration, "To-S TFR UPI/123456789012/DEBIT/SAMP LE CO/PUNB0000000/sampletx@axl/Payment", "UPI handle joined across lines");
  assert.doesNotMatch(r.rows.map((x) => x.narration).join(" "), /Page No|Customer ID|Current|computerised/);
  assert.equal(B.narrationKey(r.rows[3].narration), "UPI:SAMPLETX@AXL");
});

test("rows without a balance: a wrong amount is still caught, and a missing row is reported", () => {
  const rows = [["Date", "Particulars", "Debit", "Credit", "Balance"], ["", "Opening Balance", "", "", "1000.00"],
    ["01/04/2026", "A", "", "500.00", ""], ["", "B", "200.00", "", "1300.00"],
    ["02/04/2026", "C", "", "100.00", ""], ["", "D", "50.00", "", "1360.00"], // 1300+100-50 = 1350, not 1360
    ["", "No of transactions :", "2", "3", ""]];
  const r = B.fromSheetText(tsv(rows));
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows.map((x) => x.ok), [true, true, false, false]);
  assert.equal(r.ok, false);
  assert.match(r.warnings[0], /says 2 withdrawals and 3 deposits; 2 and 2 were read/);
});
