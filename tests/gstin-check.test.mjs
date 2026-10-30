// The GSTIN check shown next to every invoice read from an image/PDF. Made-up GSTINs with valid check digits.
import test from "node:test";
import assert from "node:assert/strict";
import { checkGstin, gstinContext } from "../engine/gstin-check.js";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";

const IN_TALLY = "27ACKPS3168H1Z6", IN_2B = "27BAYPG0715M1Z9", NEW = "29AACCF0683K1ZD";
const ctx = { tally: new Map([[IN_TALLY, "KANAKRAJ TEXTILES"]]), byLedger: new Map([["KANAKRAJ TEXTILES", IN_TALLY], ["OTHER LEDGER", IN_2B]]), portal: new Set([IN_2B]) };

test("same GSTIN as a Tally ledger or in GSTR-2B: verified", () => {
  assert.equal(checkGstin(IN_TALLY, ctx).status, "verified");
  assert.match(checkGstin(IN_TALLY, ctx).detail, /KANAKRAJ TEXTILES/);
  assert.equal(checkGstin(IN_2B, ctx).status, "verified");
  assert.match(checkGstin(IN_2B, ctx).detail, /GSTR-2B/);
});

test("correct check digit but never seen: valid and new", () => {
  const r = checkGstin(NEW, ctx);
  assert.equal(r.status, "valid");
  assert.match(r.label, /new/);
});

test("one character misread: the check digit fails, and the GSTIN you already have is suggested", () => {
  const misread = IN_TALLY.replace("3168", "3I68"); // 1 read as I
  const r = checkGstin(misread, ctx);
  assert.equal(r.status, "invalid");
  assert.deepEqual(r.suggestions, [{ gstin: IN_TALLY, ledger: "KANAKRAJ TEXTILES" }]);
  const o = checkGstin(IN_2B.replace("0715", "O715"), ctx); // 0 read as O
  assert.equal(o.status, "invalid");
  assert.equal(o.suggestions[0].gstin, IN_2B);
  assert.equal(checkGstin("27ACKPS3168H1Z", ctx).status, "invalid", "14 characters");
  assert.equal(checkGstin("", ctx).status, "missing");
});

test("valid, but the matched Tally party has another GSTIN; or the invoice's state disagrees with the GSTIN", () => {
  assert.equal(checkGstin(IN_TALLY, ctx, { partyLedger: "OTHER LEDGER" }).status, "mismatch");
  const s = checkGstin(IN_TALLY, ctx, { partyState: "Karnataka" });
  assert.equal(s.status, "valid");
  assert.match(s.detail, /Karnataka.*Maharashtra/);
});

test("context comes from the company's Tally masters and GSTR-2B uploads", async () => {
  const D = db({ DB: makeD1() });
  await D.insert("masters", { company_id: "c", kind: "ledger", name: "KANAKRAJ TEXTILES", uname: "K", parent: "Sundry Creditors", primary_group: "Sundry Creditors", gstin: IN_TALLY, pending: 0 });
  await D.insert("gst_docs", { id: "d1", return_id: "r", company_id: "c", seq: 0, sec: "B2B", ctin: IN_2B, num: "1" });
  const c = await gstinContext(D, "c");
  assert.equal(checkGstin(IN_TALLY, c).status, "verified");
  assert.equal(checkGstin(IN_2B, c).status, "verified");
});
