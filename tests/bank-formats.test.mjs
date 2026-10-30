// Bank statements in the formats banks actually hand out: old Excel 97–2003 (.xls), "xls" files that are really
// HTML tables or tab-separated text, CSV, and the many ways banks name their columns. All data here is made up.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as B from "../public/bankparse.js";

const ctx = { TextDecoder };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("../public/xls.js", import.meta.url), "utf8"), ctx);
vm.runInContext(fs.readFileSync(new URL("../public/ingest.js", import.meta.url), "utf8") + ";globalThis.Ingest=Ingest;", ctx);
const XLS = ctx.XLS, csvRows = ctx.Ingest.csvRows;
const text = (sheets) => sheets.flatMap((s) => s.rows).filter((r) => r.some((x) => x)).map((r) => r.join("\t")).join("\n");

test("a real Excel 97–2003 .xls statement (400 rows, shared strings across records, Unicode, dates) is read exactly", () => {
  const sheets = XLS.read(new Uint8Array(fs.readFileSync(new URL("./fixtures/bank-sample-97.xls", import.meta.url))));
  assert.equal(sheets.length, 1);
  const csv = csvRows(fs.readFileSync(new URL("./fixtures/bank-sample-97.csv", import.meta.url), "utf8"));
  const rows = sheets[0].rows.filter((r) => r.some((x) => x));
  assert.equal(rows.length, csv.length);
  const n = (x) => (/^-?\d+(\.\d+)?$/.test(x) ? String(+x) : x);
  for (let i = 0; i < csv.length; i++) assert.deepEqual(rows[i].map(n), csv[i].map(n), "row " + i);
  const r = B.fromSheetText(text(sheets));
  assert.equal(r.rows.length, 400);
  assert.equal(r.rows[0].date, "2026-09-01");
  assert.equal(r.rows[49].narration, "UPI/SAMPLE PARTY 050 नमस्ते/612300000050/Payment for order 350");
  assert.equal(r.rows[0].ref, "UPI-612300000001");
  const checked = B.checkBalances(r.rows, r.opening, r.closing);
  assert.ok(checked.rows.slice(1).every((x) => x.ok === true), "every row adds up to the printed balance");
});

test("an .xls that is really an HTML table (net-banking download) is read", () => {
  const html = `<html><body><table><tr><td colspan="4">Sample Bank — Statement</td></tr>
    <tr><th>Txn Date</th><th>Narration</th><th>Withdrawal Amt.</th><th>Deposit Amt.</th><th>Closing Balance</th></tr>
    <tr><td>01/10/2026</td><td>NEFT SAMPLE TRADERS</td><td></td><td>1,000.00</td><td>11,000.00</td></tr>
    <tr><td>02/10/2026</td><td>UPI/ALPHA/612300000001</td><td>250.50</td><td></td><td>10,749.50</td></tr></table></body></html>`;
  const parseHtml = (t) => {
    // a tiny DOM for the test: tables → rows → cells
    const table = { getElementsByTagName: () => [...t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => ({
      children: [...m[1].matchAll(/<(t[dh])([^>]*)>([\s\S]*?)<\/t[dh]>/g)].map((c) => ({ tagName: c[1].toUpperCase(), textContent: c[3],
        getAttribute: (a) => (new RegExp(a + '="(\\d+)"').exec(c[2]) || [])[1] || null })) })) };
    return { getElementsByTagName: () => [table] };
  };
  const sheets = XLS.read(new TextEncoder().encode(html), { csvRows, parseHtml });
  const r = B.fromSheetText(text(sheets));
  assert.deepEqual(r.rows.map((x) => [x.date, x.debit, x.credit, x.balance]), [["2026-10-01", 0, 1000, 11000], ["2026-10-02", 250.5, 0, 10749.5]]);
});

test("an .xls that is really tab-separated text is read", () => {
  const t = "Date\tDescription\tRef No./Cheque No.\tDebit\tCredit\tBalance\n03 Oct 2026\tBY TRANSFER-NEFT SAMPLE\tN298260000001\t\t500.00\t1,500.00\n";
  const sheets = XLS.read(new TextEncoder().encode(t), { csvRows });
  const r = B.fromSheetText(text(sheets));
  assert.deepEqual(r.rows.map((x) => [x.date, x.credit, x.ref]), [["2026-10-03", 500, "N298260000001"]]);
});

test("column names the way different banks write them", () => {
  const cases = [
    [["Txn Posted Date", "Transaction Remarks", "Cheque. No./Ref. No.", "Withdrawal Amt (INR)", "Deposit Amt (INR)", "Balance (INR)"], ["date", "narration", "ref", "debit", "credit", "balance"]],
    [["Date of Transaction", "Narrative", "Money Out", "Money In", "Running Balance"], ["date", "narration", "debit", "credit", "balance"]],
    [["Tran Date", "Particulars", "Amount in Rs", "Transaction Type", "Balance"], ["date", "narration", "amount", "drcr", "balance"]],
    [["Posting Date", "Value Date", "Description", "Debit Amount", "Credit Amount", "Available Balance"], ["date", "vdate", "narration", "debit", "credit", "balance"]],
    [["Date", "Details", "Amount", "Debit/Credit", "Balance"], ["date", "narration", "amount", "drcr", "balance"]],
  ];
  for (const [head, kinds] of cases) {
    const h = B.findHeader([head]);
    assert.ok(h, head.join(" | "));
    assert.deepEqual(Object.entries(h.map).sort((a, b) => a[1] - b[1]).map(([k]) => k), kinds, head.join(" | "));
  }
});

test("a heading split over two rows (Amount above Withdrawals | Deposits) is one heading", () => {
  const rows = [
    ["Date", "Particulars", "Chq No", "Amount (Rs.)", "", "Balance"],
    ["", "", "", "Withdrawals", "Deposits", ""],
    ["01-10-2026", "OPENING BALANCE", "", "", "", "1000.00"],
    ["02-10-2026", "CASH DEPOSIT", "", "", "500.00", "1500.00"],
    ["03-10-2026", "ATM WDL", "", "200.00", "", "1300.00"],
  ];
  const r = B.parseTable(rows);
  assert.deepEqual(r.rows.map((x) => [x.date, x.debit, x.credit, x.balance]), [["2026-10-02", 0, 500, 1500], ["2026-10-03", 200, 0, 1300]]);
  assert.equal(r.opening, 1000);
});

test("a single Amount column with Cr/Dr written in it, or a sign", () => {
  const r = B.parseTable([
    ["Date", "Narration", "Amount", "Balance"],
    ["01/10/2026", "UPI IN", "1,000.00 Cr", "2,000.00 Cr"],
    ["02/10/2026", "UPI OUT", "-250.00", "1,750.00 Cr"],
    ["03/10/2026", "CHARGES", "50.00 Dr", "1,700.00 Cr"],
  ]);
  assert.deepEqual(r.rows.map((x) => [x.debit, x.credit]), [[0, 1000], [250, 0], [50, 0]]);
});
