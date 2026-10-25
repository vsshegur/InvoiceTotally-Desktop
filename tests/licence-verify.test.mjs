import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { licenceClient } from "../desktop/licence.mjs";

// A tiny in-memory stand-in for the app_config table.
function fakeD() {
  const m = new Map();
  return { m,
    first: async (_q, k) => (m.has(k) ? { value: m.get(k) } : null),
    run: async (q, ...a) => { if (/DELETE/.test(q)) m.delete(a[0]); else m.set(a[0], a[1]); } };
}
const kp = crypto.generateKeyPairSync("ed25519");
const pub = kp.publicKey.export({ format: "jwk" });
const sign = (payload) => { const p = Buffer.from(JSON.stringify(payload)).toString("base64url"); return { payload: p, sig: crypto.sign(null, Buffer.from(p), kp.privateKey).toString("base64url") }; };
const setup = async (payload) => { const D = fakeD(); D.m.set("lic_pubkey", JSON.stringify(pub)); D.m.set("lic_licence", JSON.stringify(sign(payload))); return { D, c: licenceClient({ D, serviceUrl: () => "https://x.test" }) }; };
const nowS = () => Math.floor(Date.now() / 1000);

test("a licence checked online today is valid; after the user's limit it must be verified", async () => {
  const fresh = (await (await setup({ email: "a@b.c", issued_at: nowS() - 86400, verify_days: 3 })).c.current());
  assert.equal(fresh.stale, false);
  const old = (await (await setup({ email: "a@b.c", issued_at: nowS() - 4 * 86400, verify_days: 3 })).c.current());
  assert.equal(old.stale, true, "4 days since the last online check, limit 3");
  const longer = (await (await setup({ email: "a@b.c", issued_at: nowS() - 4 * 86400, verify_days: 7 })).c.current());
  assert.equal(longer.stale, false, "the admin gave this user 7 days");
  const dflt = (await (await setup({ email: "a@b.c", issued_at: nowS() - 4 * 86400 })).c.current());
  assert.equal(dflt.stale, true, "no value in the licence means 3 days");
});
test("turning the PC clock back to stretch the offline window is caught", async () => {
  const { D, c } = await setup({ email: "a@b.c", issued_at: nowS() - 2 * 86400, verify_days: 3 });
  assert.equal((await c.current()).stale, false);
  D.m.set("lic_clock", String(nowS() + 3 * 86400)); // the PC has seen a time three days from now
  const p = await c.current();
  assert.equal(p.stale, true);
  assert.equal(p.clock_rolled_back, true);
});
