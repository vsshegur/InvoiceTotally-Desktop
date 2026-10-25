// An upload can cover several months; invoices outside all of them still go to Have a look.
import test from "node:test";
import assert from "node:assert/strict";
import { invoiceDateReview, expectedMonths, expectedPeriod } from "../engine/invoice-period.js";
import { makeD1 } from "../desktop/d1.mjs";
import api from "../engine/api.js";

const inv = (period, date) => ({ period_mode: "month", expected_period: period, created_at: 1790000000, data: { date, date_verified_at: null } });

test("several chosen months: any of them is fine, any other month is flagged", () => {
  assert.deepEqual(expectedMonths({ period_mode: "month", expected_period: "2026-05,2026-04" }), ["2026-04", "2026-05"]);
  assert.equal(expectedPeriod({ period_mode: "month", expected_period: "2026-04" }), "2026-04", "one month reads as before");
  assert.equal(invoiceDateReview(inv("2026-04,2026-05", "2026-05-12")).hard_mismatch, false);
  const bad = invoiceDateReview(inv("2026-04,2026-05", "2026-06-01"));
  assert.equal(bad.hard_mismatch, true);
  assert.match(bad.reasons[0], /2026-04 to 2026-05 \(2 months\)/);
  assert.equal(expectedMonths({ period_mode: "month", expected_period: "2026-04,junk" }).length, 0);
});

test("a batch can be created for several months, and a bad month list is refused", async () => {
  const DB = makeD1();
  const env = { DB, EXTRACTOR: "mock", TEST_LICENCE: { email: "t@x.test", active: true, admin: true, can_post: true } };
  const call = async (m, p, body) => { const r = await api.fetch(new Request("http://127.0.0.1/api" + p, { method: m, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env); return { status: r.status, data: await r.json() }; };
  const c = await call("POST", "/companies", { name: "Multi Co", tally_company: "Multi Co" });
  const ok = await call("POST", `/companies/${c.data.id}/batches`, { voucher_type: "Purchase", period_mode: "month", expected_period: "2026-06,2026-04,2026-05", files: [{ filename: "a.pdf", pages: 1 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.data.name, /PURCHASE_2026-04_TO_2026-06_UPLOAD/);
  const list = await call("GET", `/companies/${c.data.id}/batches`);
  assert.equal(list.data[0].expected_period, "2026-04,2026-05,2026-06");
  for (const bad of ["", "2026-13", "2026-04,x", "1999-01"]) {
    const r = await call("POST", `/companies/${c.data.id}/batches`, { voucher_type: "Purchase", period_mode: "month", expected_period: bad, files: [{ filename: "a.pdf", pages: 1 }] });
    assert.equal(r.status, 400, bad);
  }
});
