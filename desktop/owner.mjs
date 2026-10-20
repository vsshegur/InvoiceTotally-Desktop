// Owner mode: the admin's own PC works without the InvoiceTotally service.
//
// The admin signs in with Google right here (the ID token is checked on this PC against Google's public keys, and
// must be for the admin's email), and the AI keys are kept on this PC, so invoices are read straight from here.
// Nothing about other users changes: their sign-in, limits and credits stay with the service.
import crypto from "node:crypto";

export const OWNER_EMAIL = "vipulshegur@gmail.com";
const SESSION_DAYS = 30;
const ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLIENT_RE = /^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;
export const KEY_NAMES = ["GEMINI_API_KEY", "GEMINI_PAID_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY"];

export function ownerMode({ D, fetchImpl = fetch, jwksUrl = "https://www.googleapis.com/oauth2/v3/certs", ownerEmail = process.env.IT_OWNER_EMAIL || OWNER_EMAIL }) {
  const get = async (k) => (await D.first("SELECT value FROM app_config WHERE key=?", k))?.value ?? null;
  const set = (k, v) => v == null || v === "" ? D.run("DELETE FROM app_config WHERE key=?", k)
    : D.run("INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", k, String(v), Date.now() / 1000);
  let jwks = null, jwksAt = 0;

  async function keysFromGoogle(fresh) {
    if (jwks && !fresh && Date.now() - jwksAt < 6 * 3600e3) return jwks;
    const r = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("Could not reach Google to check the sign-in");
    jwks = (await r.json()).keys || [];
    jwksAt = Date.now();
    return jwks;
  }

  /** Checks a Google ID token (signature, issuer, audience, expiry, verified email) for the owner's email. */
  async function verify(credential, clientId) {
    const bad = (m = "Google sign-in could not be checked — please try again.") => Object.assign(new Error(m), { status: 401 });
    const parts = String(credential || "").split(".");
    if (parts.length !== 3) throw bad();
    let head, claims;
    try { head = JSON.parse(Buffer.from(parts[0], "base64url")); claims = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { throw bad(); }
    if (head.alg !== "RS256" || !head.kid) throw bad();
    let jwk = (await keysFromGoogle()).find((k) => k.kid === head.kid) || (await keysFromGoogle(true)).find((k) => k.kid === head.kid);
    if (!jwk) throw bad();
    const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    const t = Date.now() / 1000;
    if (!ok || !ISS.has(claims.iss) || claims.aud !== clientId || !(claims.exp > t - 60) || !claims.sub) throw bad();
    if (claims.email_verified !== true && claims.email_verified !== "true") throw bad("This Google account's email is not verified.");
    const email = String(claims.email || "").toLowerCase();
    if (email !== ownerEmail) throw Object.assign(new Error(`Owner sign-in is only for ${ownerEmail}. Other accounts sign in with the normal button.`), { status: 403 });
    return { email, name: String(claims.name || "").slice(0, 80) };
  }

  const api = {
    ownerEmail,
    async clientId() { return (await get("owner_client_id")) || process.env.IT_GOOGLE_CLIENT_ID || ""; },
    async setClientId(id) {
      id = String(id || "").trim();
      if (!CLIENT_RE.test(id)) throw Object.assign(new Error("That doesn't look like a Google Web client ID (it ends in .apps.googleusercontent.com)."), { status: 400 });
      await set("owner_client_id", id);
    },
    async signIn(credential) {
      const clientId = await api.clientId();
      if (!clientId) throw Object.assign(new Error("Enter the Google Web client ID first."), { status: 400 });
      const who = await verify(credential, clientId);
      await set("owner_session", JSON.stringify({ ...who, at: Date.now() / 1000, until: Date.now() / 1000 + SESSION_DAYS * 86400 }));
      return who;
    },
    async session() {
      let s = null;
      try { s = JSON.parse((await get("owner_session")) || "null"); } catch {}
      return s && s.email === ownerEmail && s.until > Date.now() / 1000 ? s : null;
    },
    signOut: () => set("owner_session", null),
    /** The licence the app uses while the owner is signed in this way: no limits, no credits. */
    async licence(aiChoices) {
      const s = await api.session();
      if (!s) return null;
      const keys = await api.keys();
      const ai = aiChoices.filter((a) => (a === "gemini_lite" && keys.GEMINI_API_KEY) || (a === "gemini" && keys.GEMINI_PAID_API_KEY)
        || (a === "groq" && keys.GROQ_API_KEY) || (a === "claude" && keys.ANTHROPIC_API_KEY));
      return { v: 1, email: s.email, name: s.name || "", admin: true, owner: true, active: true, company_limit: 999, can_post: true,
        invoice_credits: 0, statement_credits: 0, ai_options: ai.length ? ai : aiChoices, issued_at: Math.floor(s.at) };
    },
    async keys() {
      const out = {};
      for (const k of KEY_NAMES) { const v = await get("owner_" + k); if (v) out[k] = v; }
      return out;
    },
    async setKeys(body) {
      for (const k of KEY_NAMES) if (k in body) {
        const v = String(body[k] || "").trim();
        if (v && !/^[\w.-]{20,300}$/.test(v)) throw Object.assign(new Error(`${k} doesn't look like an API key.`), { status: 400 });
        await set("owner_" + k, v || null);
      }
    },
    /** What the AI module needs, from the keys kept on this PC. */
    async aiEnv() {
      return { ...(await api.keys()), ANTHROPIC_MODEL: "claude-sonnet-5-5", ANTHROPIC_MODEL_RECHECK: "claude-opus-5-5", GEMINI_MODEL: "gemini-3.8-flash",
        GEMINI_LITE_MODEL: "gemini-3.5-flash-lite", GROQ_MODEL: "qwen/qwen3.8-27b", GEMINI_PAID: (await get("owner_GEMINI_PAID_API_KEY")) ? "1" : "",
        // stand-in AI servers for tests
        ...Object.fromEntries(["GEMINI_API_URL", "GROQ_API_URL", "ANTHROPIC_API_URL"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
    },
  };
  return api;
}
