// Fixes from the full-app review (4.6.0). Made-up data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normalizeInvoiceDate, indiaDate } from "../engine/invoice-period.js";
import { ecommerceExistingRequest } from "../engine/ecommerce-tally.js";
import { applyGstCheck } from "../engine/gst-preflight.js";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as P from "../engine/pipeline.js";

test("invoice dates written with month names, slashes or dots are understood; impossible ones are not", () => {
  for (const [x, want] of [["15-Sep-2026", "2026-09-15"], ["15 Sept 26", "2026-09-15"], ["15th September, 2026", "2026-09-15"], ["Sep 15, 2026", "2026-09-15"],
    ["2026/09/15", "2026-09-15"], ["15.09.2026", "2026-09-15"], ["15/9/26", "2026-09-15"], ["31-Feb-2026", null], ["15 Foo 2026", null]])
    assert.equal(normalizeInvoiceDate(x), want, x);
});

test("'today' is India's date, not UTC's (between midnight and 5:30 am UTC is still yesterday)", () => {
  assert.equal(indiaDate(new Date("2026-10-31T19:00:00Z")), "2026-11-01");
  assert.equal(indiaDate(new Date("2026-10-31T18:00:00Z")), "2026-10-31");
});

test("this month / last month on screen use the PC's own calendar (not UTC, and not setMonth on the 31st)", () => {
  const src = fs.readFileSync(new URL("../public/ui.js", import.meta.url), "utf8");
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [2026, 9, 31, 1, 0])); } static now() { return new RealDate(2026, 9, 31, 1, 0).getTime(); } }
  const ctx = { Date: FakeDate, HTMLInputElement: undefined }; vm.createContext(ctx);
  vm.runInContext(src + ";globalThis.localMonth=localMonth;globalThis.localDate=localDate;", ctx);
  assert.equal(ctx.localMonth(0), "2026-10");
  assert.equal(ctx.localMonth(-1), "2026-09", "31 October → September, not October");
  assert.equal(ctx.localDate(), "2026-10-31");
  for (const f of ["gst-tools.js", "gst.js", "accounting-workplace.js", "control-center.js"])
    assert.doesNotMatch(fs.readFileSync(new URL("../public/" + f, import.meta.url), "utf8"), /setMonth\(\w+\.getMonth\(\)\s*-\s*1\);\s*\S*toISOString/, f);
});

test("a hand-typed bill is looked for 45 days either side of the bill date", () => {
  const r = ecommerceExistingRequest("Demo", "2026-09-10", "2026-10-25");
  assert.match(r, /<SVFROMDATE TYPE="Date">20260910<\/SVFROMDATE><SVTODATE TYPE="Date">20261025</);
  assert.match(r, /\$Date >= ##SVFromDate AND \$Date <= ##SVToDate/);
  assert.match(ecommerceExistingRequest("Demo", "2026-09-10"), /\$Date = ##SVFromDate/, "one day stays one day");
});

test("'Clean for GSTR-3B' is shown only once the party is picked and GST is worked out", () => {
  const ctx = { company: { gstin: "27ACKPS3168H1Z6", state_code: "27" }, ledgers: new Map(), stock: new Map() };
  const inv = { status: "review", voucher_type: "Purchase", party_ledger: null, data: {}, lines: [{ kind: "ledger", ledger: "X", amount: 1 }], tax_lines: null, steps: { blockers: [], ready: false } };
  applyGstCheck(inv, ctx);
  assert.equal(inv.gst_check.clean, false);
  assert.equal(inv.gst_check.pending, true);
});

test("invoice tax: the closest standard rate from the printed GST, and the party's state from its Tally ledger", async () => {
  const D = db({ DB: makeD1() });
  await D.insert("companies", { id: "c", name: "Demo", tally_company: "Demo", gstin: "27ACKPS3168H1Z6", state_code: "27", bridge_token: "t", settings: "{}" });
  await D.insert("masters", { company_id: "c", kind: "ledger", name: "Karnataka Supplier", uname: "K", parent: "Sundry Creditors", primary_group: "Sundry Creditors", gstin: "29AACCF0683K1ZD", state: "Karnataka", pending: 0 });
  await D.insert("batches", { id: "b", company_id: "c", name: "B", voucher_type: "Purchase", stage: "review", created_at: 1 });
  // the bill's own GSTIN reading is a Maharashtra one (misread); Tally's ledger says Karnataka → IGST
  await D.insert("invoices", { id: "i", batch_id: "b", company_id: "c", status: "review", party_ledger: "Karnataka Supplier", created_at: 1,
    data: JSON.stringify({ number: "1", date: "2026-09-01", party_gstin: "27BAYPG0715M1Z9", igst: 0.2, total: 100.2 }) });
  await D.insert("lines", { id: "l", invoice_id: "i", idx: 0, kind: "ledger", description: "x", amount: 100, ledger: "P", ledger_state: "resolved" });
  const heads = await P.calculateTax(D, "i");
  assert.deepEqual(heads.filter((h) => h.head !== "ROUND").map((h) => [h.head, h.rate]), [["IGST", 0.25]], "0.2% → 0.25% (closest), and IGST from the ledger's state");
});
