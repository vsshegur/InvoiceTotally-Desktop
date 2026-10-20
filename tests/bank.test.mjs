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

