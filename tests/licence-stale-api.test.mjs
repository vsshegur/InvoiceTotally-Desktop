// Past the offline limit the app refuses to work until the licence is verified online.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetLicenceCheck } from "../engine/api.js";
import { makeD1 } from "../desktop/d1.mjs";

const stale = { email: "a@b.c", active: true, can_post: true, company_limit: 9, stale: true, issued_at: 1 };
const get = async (env) => { const r = await worker.fetch(new Request("http://x/api/companies"), env, {}); return { status: r.status, ...(await r.json()) }; };

test("stale licence but the service answers: the fresh licence is used and the call works", async () => {
  const fresh = { ...stale, stale: false, issued_at: Math.floor(Date.now() / 1000) };
  const env = { DB: makeD1(), LIC: { current: async () => stale, refresh: async () => fresh, online: true } };
  const r = await worker.fetch(new Request("http://x/api/companies"), env, {});
  assert.equal(r.status, 200);
});

test("stale licence and no internet: every call is refused with a clear message", async () => {
  resetLicenceCheck();
  const env = { DB: makeD1(), LIC: { current: async () => stale, refresh: async () => { throw new Error("offline"); }, online: false } };
  const r = await get(env);
  assert.equal(r.status, 403);
  assert.equal(r.code, "stale");
  assert.match(r.error, /internet/);
});
