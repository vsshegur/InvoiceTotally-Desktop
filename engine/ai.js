// Reading invoices with Claude (vision) + an arithmetic self-check that triggers a careful second read.
import { cleanGstin, gstinValid } from "./gst.js";

const API = "https://api.anthropic.com/v1/messages";

export class AIError extends Error { constructor(msg, retryable = false) { super(msg); this.retryable = retryable; } }

const PARTY = {
  type: "object",
  properties: {
    name: { type: "string" },
    gstin: { type: "string", description: "15-character GSTIN exactly as printed, or empty." },
    address: { type: "string" }, state: { type: "string" }, phone: { type: "string" },
  },
};

export const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    number: { type: "string", description: "Invoice / bill number" },
    date: { type: "string", description: "Invoice date as YYYY-MM-DD" },
    seller: PARTY, buyer: PARTY,
    place_of_supply: { type: "string" },
    lines: {
      type: "array",
      description: "Every goods / service row of the item table, in order. Not tax rows, not totals.",
      items: {
        type: "object",
        properties: {
          description: { type: "string", description: "Item description exactly as written" },
          hsn: { type: "string" },
          qty: { type: ["number", "null"], description: "Billed quantity" },
          unit: { type: "string", description: "Unit of the billed quantity: PCS, DOZ, KG, MTR, NOS, BOX…" },
          alt_qty: { type: ["number", "null"], description: "Second quantity if shown, e.g. 320 for '3840 PCS (320 DOZ)'" },
          alt_unit: { type: "string" },
          rate: { type: ["number", "null"], description: "Rate per billed unit, before discount" },
          discount_pct: { type: ["number", "null"], description: "Discount % on this item. If the invoice gives one discount % for all items (e.g. 'Less 1% discount' below the table), put that % on every item line here." },
          amount: { type: "number", description: "Taxable value of the row AFTER its discount, before GST (qty × rate × (1 − discount%/100))" },
          gst_rate: { type: ["number", "null"], description: "Total GST % for the row (CGST+SGST, or IGST)" },
        },
        required: ["description", "amount"],
      },
    },
    charges: {
      type: "array",
      description: "Extra charges outside the item table: freight, packing, cartage, insurance, or a fixed-rupee discount that is NOT a percentage of the items (negative). Never put a percentage item discount here — it goes on each line's discount_pct. Not GST, not round off.",
      items: { type: "object", properties: { description: { type: "string" }, amount: { type: "number" }, gst_rate: { type: ["number", "null"] } }, required: ["description", "amount"] },
    },
    cgst: { type: ["number", "null"] }, sgst: { type: ["number", "null"] }, igst: { type: ["number", "null"] }, cess: { type: ["number", "null"] },
    round_off: { type: ["number", "null"], description: "Signed, e.g. -0.02" },
    total: { type: "number", description: "Grand total payable" },
    handwritten: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" }, description: "Anything unreadable, ambiguous, or that does not add up." },
  },
  required: ["number", "date", "seller", "buyer", "lines", "total"],
};

const SYSTEM =
  "You are an expert Indian GST accountant reading invoices for entry into Tally. Invoices may be printed, " +
  "Tally-generated, Excel-made, scanned, photographed at an angle, or fully handwritten. Read every digit carefully; " +
  "prefer the reading that makes the arithmetic work (qty × rate − discount = amount; sum of amounts + charges + taxes " +
  "+ round off = total). Indian number grouping: 1,23,456.78. Never invent data: leave a field empty if it is not on the " +
  "page and add a warning. GSTIN = 2-digit state code + 10-character PAN + entity digit + 'Z' + check character. Dates " +
  "are Indian DD/MM/YYYY unless clearly otherwise; output YYYY-MM-DD. Item discounts belong on the item lines (discount_pct, " +
  "with amount after discount) exactly as Tally records them — not as a separate discount row.";

function context(company, vt) {
  const us = company.name + (company.gstin ? ` (GSTIN ${company.gstin})` : "");
  return `Our company is ${us}; on this ${vt.toLowerCase()} invoice we are the ${vt === "Purchase" ? "buyer" : "seller"}. Record both parties exactly as printed.`;
}

/** Structured Outputs needs every object closed and every property listed as required (optional values use null / ""). */
export function strict(schema) {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strict(pv)])) : strict(v);
  if (out.type === "object" && out.properties) { out.required = Object.keys(out.properties); out.additionalProperties = false; }
  return out;
}

/** content parts: {text} | {b64} (JPEG base64). Base64 is spliced in as raw text to keep CPU near zero.
 *  The answer is forced into the tool's JSON schema with Structured Outputs (output_config.format). */
async function callTool(env, parts, tool, { model, maxTokens = 8000, meter, system = SYSTEM } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new AIError("ANTHROPIC_API_KEY is not set (Cloudflare → your Worker → Settings → Variables and Secrets), or switch this company to Gemini in Settings.");
  const images = [];
  const content = parts.map((p) => {
    if (p.b64 != null) { images.push(p.b64); return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: `@@IMG${images.length - 1}@@` } }; }
    return { type: "text", text: p.text };
  });
  content.push({ type: "text", text: `Task: ${tool.description} Answer only with the JSON object.` });
  let body = JSON.stringify({
    model: model || env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: maxTokens, system,
    output_config: { format: { type: "json_schema", schema: strict(tool.input_schema) } },
    messages: [{ role: "user", content }],
  });
  if (images.length) {
    const chunks = body.split(/@@IMG(\d+)@@/);
    for (let i = 1; i < chunks.length; i += 2) chunks[i] = images[+chunks[i]];
    body = chunks.join("");
  }
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await fetch(env.ANTHROPIC_API_URL || API, {
        method: "POST", body,
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      });
    } catch (e) { last = String(e); await sleep(1500 * (attempt + 1)); continue; }
    if ([429, 500, 502, 503, 529].includes(r.status)) { last = `${r.status}`; await sleep(3000 * (attempt + 1)); continue; }
    if (r.status === 401) throw new AIError("The Anthropic API key was rejected — check the ANTHROPIC_API_KEY secret in Cloudflare (it may have expired).");
    if (r.status === 400 && /credit balance/i.test(await r.clone().text())) throw new AIError("Your Anthropic credit has run out — add credit at platform.claude.com → Settings → Billing, then press Retry.");
    if (r.status === 403) {
      // Usually the Cloudflare data centre that ran this request is in a location Anthropic doesn't serve.
      last = "403 (request location not allowed)";
      throw new AIError("Anthropic refused the request from the Cloudflare location that ran it (403)", true);
    }
    if (!r.ok) throw new AIError(`AI service error ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    meter?.add(model || env.ANTHROPIC_MODEL || "claude-sonnet-5-5", j.usage?.input_tokens || 0, j.usage?.output_tokens || 0);
    if (j.stop_reason === "max_tokens") throw new AIError("The answer was too long to finish — split this file into smaller ones and upload again.");
    if (j.stop_reason === "refusal") throw new AIError("The AI declined to read this file.");
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    try { return parseLoose(text); }
    catch { throw new AIError(`Claude's answer could not be read (it began: "${text.slice(0, 80).replace(/\s+/g, " ")}"); it will retry.`, true); }
  }
  throw new AIError(`AI service busy (${last}). It will retry automatically.`, true);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The answer should be bare JSON; accept it inside ```json fences or with a sentence around it too. */
export function parseLoose(text) {
  text = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try { return JSON.parse(text); } catch {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  throw new SyntaxError("not JSON");
}

// ------------------------------------------------------------ Gemini (Interactions API)
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/interactions";

async function callGemini(env, parts, tool, { model, maxTokens = 16000, meter, system = SYSTEM, key } = {}) {
  key = key || env.GEMINI_API_KEY;
  if (!key) throw new AIError("GEMINI_API_KEY is not set (Cloudflare → your Worker → Settings → Variables and Secrets), or switch this company to Claude in Settings.");
  model = model || env.GEMINI_MODEL || "gemini-3.8-flash";
  const images = [];
  const input = parts.map((p) => {
    if (p.b64 != null) { images.push(p.b64); return { type: "image", mime_type: "image/jpeg", data: `@@IMG${images.length - 1}@@` }; }
    return { type: "text", text: p.text };
  });
  input.push({ type: "text", text: `Task: ${tool.description} Answer only with the JSON object.` });
  const cfg = { max_output_tokens: maxTokens };
  if (env.GEMINI_THINKING) cfg.thinking_level = env.GEMINI_THINKING;
  let body = JSON.stringify({
    model, system_instruction: system, input, store: false, generation_config: cfg,
    response_format: { type: "text", mime_type: "application/json", schema: strict(tool.input_schema) },
  });
  if (images.length) {
    const chunks = body.split(/@@IMG(\d+)@@/);
    for (let i = 1; i < chunks.length; i += 2) chunks[i] = images[+chunks[i]];
    body = chunks.join("");
  }
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await fetch(env.GEMINI_API_URL || GEMINI_API, { method: "POST", body,
        headers: { "x-goog-api-key": key, "content-type": "application/json" } });
    } catch (e) { last = String(e); await sleep(1500 * (attempt + 1)); continue; }
    if (r.status === 429) {
      // Google says which limit was hit. A quota of 0 (the free tier has none for this model) or a daily limit will not
      // clear by waiting a minute, so say so plainly instead of retrying; a per-minute limit is waited out.
      const q = geminiQuota(await r.text());
      if (q.none) throw quotaError(`Gemini has no quota for ${model} on this API key — Google's free tier allows none for it. Turn on billing for the key's Google Cloud project (aistudio.google.com → API keys → Set up billing), or switch this company to Claude in Settings.`);
      if (q.daily) throw quotaError(`Gemini's daily limit for this API key is used up (it resets once a day). Turn on billing for the key's Google Cloud project for higher limits, or switch this company to Claude in Settings.`);
      last = `429${q.message ? ": " + q.message.slice(0, 120) : ""}`;
      await sleep(Math.min(30, q.retryAfter || 5 * (attempt + 1)) * 1000);
      continue;
    }
    if ([500, 502, 503, 504].includes(r.status)) { last = `${r.status}`; await sleep(3000 * (attempt + 1)); continue; }
    const txt = await r.text();
    if (r.status === 401 || r.status === 403 || /API_KEY_INVALID|API key not valid/i.test(txt))
      throw new AIError("The Gemini API key was rejected — check the GEMINI_API_KEY secret in Cloudflare.");
    if (!r.ok) throw new AIError(`Gemini error ${r.status}: ${txt.slice(0, 300)}`);
    let j;
    try { j = JSON.parse(txt); } catch { throw new AIError("Gemini returned an unreadable reply; it will retry.", true); }
    const u = j.usage || {};
    meter?.add(model, u.total_input_tokens || 0, (u.total_output_tokens || 0) + (u.total_thought_tokens || 0));
    if (j.status === "failed") throw new AIError(`Gemini failed: ${(j.errors || []).map((e) => e.message).join("; ") || "unknown reason"}`, true);
    if (j.status === "incomplete") throw new AIError("The answer was too long to finish — split this file into smaller ones and upload again.");
    const text = (j.steps || []).filter((st) => st.type === "model_output")
      .flatMap((st) => st.content || []).filter((c) => c.type === "text").map((c) => c.text).join("") ||
      (j.outputs || []).filter((o) => o.type === "text").map((o) => o.text).join("");
    try { return parseLoose(text); }
    catch { throw new AIError(`Gemini's answer could not be read (it began: "${text.slice(0, 80).replace(/\s+/g, " ")}"); it will retry.`, true); }
  }
  const busy = new AIError(`Gemini busy (${last}). It will retry automatically.`, true);
  busy.gemini = true;
  throw busy;
}

/** Reads Google's 429 reply: { error: { message, details: [{ violations: [{ quotaId, quotaMetric }] }, { retryDelay: "39s" }] } } */
export function geminiQuota(text) {
  let e = {};
  try { e = JSON.parse(text).error || {}; } catch {}
  const msg = String(e.message || "");
  const details = JSON.stringify(e.details || []);
  const none = /limit:\s*0\b/.test(msg) || /"quotaValue":"0"/.test(details);
  const daily = /PerDay|per day|daily/i.test(details + " " + msg);
  const m = /"retryDelay":"(\d+)(?:\.\d+)?s"/.exec(details) || /retry in (\d+(?:\.\d+)?)s/i.exec(msg);
  return { none, daily: !none && daily, retryAfter: m ? Math.ceil(+m[1]) : 0, message: msg.split("\n")[0] };
}
function quotaError(msg) { const e = new AIError(msg, false); e.gemini = true; e.quota = true; return e; }

// ------------------------------------------------------------ Groq (OpenAI-style API, free tier)
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MAX_IMAGES = 3, GROQ_MAX_B64 = 3_800_000; // Groq takes at most 3 images and ~4 MB of base64 per request

async function callGroq(env, parts, tool, { model, maxTokens = 8000, meter, system = SYSTEM } = {}) {
  if (!env.GROQ_API_KEY) throw groqError("GROQ_API_KEY is not set on the service (Cloudflare → your Worker → Settings → Variables and Secrets).");
  model = model || env.GROQ_MODEL || "qwen/qwen3.8-27b";
  const images = [];
  const content = parts.map((p) => {
    if (p.b64 != null) { images.push(p.b64); return { type: "image_url", image_url: { url: `data:image/jpeg;base64,@@IMG${images.length - 1}@@` } }; }
    return { type: "text", text: p.text };
  });
  if (images.length > GROQ_MAX_IMAGES) throw groqError(`Groq reads at most ${GROQ_MAX_IMAGES} pages at a time (this has ${images.length}).`);
  if (images.reduce((a, b) => a + b.length, 0) > GROQ_MAX_B64) throw groqError("These pages are too large for Groq in one request.");
  content.push({ type: "text", text: `Task: ${tool.description} Answer only with one JSON object that follows this JSON Schema:\n${JSON.stringify(strict(tool.input_schema))}` });
  let body = JSON.stringify({ model, temperature: 0, max_completion_tokens: maxTokens, response_format: { type: "json_object" },
    messages: [{ role: "system", content: system + " Reply with JSON only." }, { role: "user", content }] });
  if (images.length) {
    const chunks = body.split(/@@IMG(\d+)@@/);
    for (let i = 1; i < chunks.length; i += 2) chunks[i] = images[+chunks[i]];
    body = chunks.join("");
  }
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try { r = await fetch(env.GROQ_API_URL || GROQ_API, { method: "POST", body, headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" } }); }
    catch (e) { last = String(e); await sleep(1500 * (attempt + 1)); continue; }
    const txt = await r.text();
    if (r.status === 429) {
      const msg = (() => { try { return JSON.parse(txt).error?.message || ""; } catch { return txt; } })();
      if (/per day|\(TPD\)|\(RPD\)/i.test(msg)) throw groqError("Groq's free daily limit is used up (it resets once a day).", true);
      const wait = +(r.headers.get("retry-after") || 0) || +(/try again in ([\d.]+)s/i.exec(msg)?.[1] || 0) || 6 * (attempt + 1);
      last = "429"; await sleep(Math.min(30, wait) * 1000); continue;
    }
    if ([500, 502, 503].includes(r.status)) { last = `${r.status}`; await sleep(3000 * (attempt + 1)); continue; }
    if (r.status === 401) throw groqError("The Groq API key was rejected — check the GROQ_API_KEY secret in Cloudflare.");
    if (r.status === 413) throw groqError("These pages are too large for Groq's free tier (too many tokens at once).");
    if (!r.ok) throw groqError(`Groq error ${r.status}: ${txt.slice(0, 300)}`);
    let j;
    try { j = JSON.parse(txt); } catch { throw new AIError("Groq returned an unreadable reply; it will retry.", true); }
    meter?.add(model, j.usage?.prompt_tokens || 0, j.usage?.completion_tokens || 0);
    const choice = j.choices?.[0] || {};
    if (choice.finish_reason === "length") throw new AIError("The answer was too long to finish — split this file into smaller ones and upload again.");
    const text = choice.message?.content || "";
    try { return parseLoose(text); }
    catch { throw new AIError(`Groq's answer could not be read (it began: "${text.slice(0, 80).replace(/\s+/g, " ")}"); it will retry.`, true); }
  }
  const busy = new AIError(`Groq busy (${last}). It will retry automatically.`, true);
  busy.groq = true;
  throw busy;
}
function groqError(msg, quota = false) { const e = new AIError(msg, false); e.groq = true; e.quota = quota; return e; }

// ------------------------------------------------------------ choosing the AI per company
/** claude | gemini | gemini_then_claude | gemini_lite (free) | groq (free) */
export const AI_MODES = ["claude", "gemini", "gemini_then_claude", "gemini_lite", "groq"];
export function aiMode(env, company) {
  const m = company?.settings?.ai_mode || env.AI_MODE || "claude";
  return AI_MODES.includes(m) ? m : "claude";
}
const liteModel = (env) => env.GEMINI_LITE_MODEL || "gemini-3.5-flash-lite";
const groqModel = (env) => env.GROQ_MODEL || "qwen/qwen3.8-27b";
/** Which AI keys the service holds (shown to the admin). Paid Gemini needs its own key: the free key has no Flash quota. */
export const aiKeys = (env) => ({ gemini_lite: !!env.GEMINI_API_KEY, gemini: !!(env.GEMINI_PAID_API_KEY || env.GEMINI_PAID === "1"),
  groq: !!env.GROQ_API_KEY, claude: !!env.ANTHROPIC_API_KEY });

/** provider: claude | gemini (paid Flash) | gemini_lite (free Flash-Lite) | groq (free).
 *  When a free AI is out of quota or busy, the other free one reads instead (if its key is set); paid Gemini falls back
 *  to Claude. opts.info.fallback tells the caller. */
async function ask(env, provider, parts, tool, opts = {}) {
  const run = (p, o) => p === "claude" ? callTool(env, parts, tool, o)
    : p === "groq" ? callGroq(env, parts, tool, { ...o, model: /\//.test(o.model || "") ? o.model : groqModel(env) })
    : p === "gemini_lite" ? callGemini(env, parts, tool, { ...o, model: /lite/.test(o.model || "") ? o.model : liteModel(env), key: env.GEMINI_API_KEY })
    : callGemini(env, parts, tool, { ...o, key: env.GEMINI_PAID_API_KEY || env.GEMINI_API_KEY });
  try { return await run(provider, opts); }
  catch (e) {
    if (!(e instanceof AIError) || opts.noFallback || !(e.gemini || e.groq)) throw e;
    const next = provider === "gemini_lite" && env.GROQ_API_KEY ? "groq" : provider === "groq" && env.GEMINI_API_KEY ? "gemini_lite"
      : provider === "gemini" && env.ANTHROPIC_API_KEY ? "claude" : null;
    if (!next) throw e;
    if (opts.info) { opts.info.fallback = e.message; opts.info.by = next; }
    const model = next === "claude" ? (/^claude-/.test(opts.model || "") ? opts.model : env.ANTHROPIC_MODEL || "claude-sonnet-5-5") : undefined;
    return run(next, { ...opts, model });
  }
}
const providerOf = (mode) => mode === "claude" ? "claude" : mode === "gemini_lite" ? "gemini_lite" : mode === "groq" ? "groq" : "gemini";
const modelOf = (env, p) => p === "claude" ? env.ANTHROPIC_MODEL || "claude-sonnet-5-5" : p === "gemini_lite" ? liteModel(env) : p === "groq" ? groqModel(env) : env.GEMINI_MODEL || "gemini-3.8-flash";

/** Settings → "Test the AI": one tiny request (no invoice), so a wrong key, model, location or credit shows at once. */
const TEST_TOOL = { name: "record_check", description: "Reply with ok set to true.", input_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };
export async function testAI(env, provider) {
  const model = modelOf(env, provider);
  const t = Date.now();
  const res = await ask(env, provider, [{ text: "This is a connection check." }], TEST_TOOL, { maxTokens: 50, noFallback: true, model });
  if (res?.ok !== true) throw new AIError("The AI answered, but not as expected.");
  return { model: modelLabel(model), ms: Date.now() - t };
}

// USD per million tokens [input, output] — used for the cost shown per batch (an estimate).
const PRICES = {
  "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-haiku-5-5": [0.1, 0.5],
  "gemini-3.8-flash": [0.75, 3.75], "gemini-3.5-flash-lite": [0.3, 2.5], "gemini-3.1-flash-lite": [0.25, 1.5],
  "qwen/qwen3.8-27b": [0, 0],
};
export function modelLabel(m) {
  m = m || "";
  let x = m.match(/^claude-([a-z]+)-(\d+)-(\d+)$/);
  if (x) return `Claude ${x[1][0].toUpperCase() + x[1].slice(1)} ${x[2]}.${x[3]}`;
  if (/^qwen\//.test(m)) return `Groq ${m.split("/")[1]}`;
  x = m.match(/^gemini-([\d.]+)-(.+)$/);
  if (x) return `Gemini ${x[1]} ${x[2].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("-")}`;
  return m;
}
export function makeMeter(env) {
  let extra = {};
  try { extra = env.PRICES_JSON ? JSON.parse(env.PRICES_JSON) : {}; } catch {}
  const m = { usd: 0, calls: [] };
  m.add = (model, inTok, outTok) => {
    const p = extra[model] || PRICES[model] || [0, 0];
    m.usd += (inTok * p[0] + outTok * p[1]) / 1e6;
    m.calls.push({ model, in: inTok, out: outTok });
  };
  return m;
}

// ------------------------------------------------------------ split
const SPLIT_TOOL = {
  name: "record_split", description: "Group consecutive pages into separate invoices.",
  input_schema: {
    type: "object",
    properties: {
      invoices: { type: "array", description: "Each entry is the list of 1-based page numbers making up one invoice, in order.", items: { type: "array", items: { type: "integer" } } },
      skip: { type: "array", items: { type: "integer" }, description: "Pages that are not invoices (blank, cover letters) or are Duplicate/Triplicate copies of an invoice already listed." },
    },
    required: ["invoices"],
  },
};

export async function splitPages(env, thumbs, company = null, meter = null) {
  const n = thumbs.length;
  if (n <= 1) return n ? [[0]] : [];
  if (env.EXTRACTOR === "mock") return thumbs.map((_, i) => [i]);
  const parts = [];
  thumbs.forEach((t, i) => { parts.push({ text: `Page ${i + 1}:` }); parts.push({ b64: t }); });
  parts.push({ text: "These pages were scanned together. Decide where each invoice starts and ends. A continuation page has no new invoice number, says 'continued', or carries on the item table. For Original/Duplicate/Triplicate copies of the same invoice keep only the first and skip the rest." });
  let p = providerOf(aiMode(env, company));
  if (p === "groq" && n > GROQ_MAX_IMAGES) {
    if (env.GEMINI_API_KEY) p = "gemini_lite";
    else return thumbs.map((_, i) => [i]); // each page read as its own invoice
  }
  const res = await ask(env, p, parts, SPLIT_TOOL, { maxTokens: 4000, meter, model: modelOf(env, p) });
  const seen = new Set(), skipped = new Set((res.skip || []).map((p) => p - 1)), groups = [];
  for (const g of res.invoices || []) {
    const gg = g.map((p) => p - 1).filter((p) => p >= 0 && p < n && !seen.has(p));
    gg.forEach((p) => seen.add(p));
    if (gg.length) groups.push(gg);
  }
  for (let i = 0; i < n; i++) if (!seen.has(i) && !skipped.has(i)) groups.push([i]); // never silently drop a page
  return groups;
}

// ------------------------------------------------------------ checks
const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);

export function checkInvoice(d) {
  const issues = [];
  const lines = d.lines || [], charges = d.charges || [];
  if (!d.number) issues.push("Invoice number is missing.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || "")) issues.push(`Date '${d.date || ""}' is not a valid YYYY-MM-DD date.`);
  if (!lines.length) issues.push("No item lines were found.");
  lines.forEach((l, i) => {
    const q = num(l.qty), r = num(l.rate), a = num(l.amount);
    if (q && r && a != null) {
      const exp = q * r * (1 - (num(l.discount_pct) || 0) / 100);
      if (Math.abs(exp - a) > Math.max(1, Math.abs(a) * 0.005))
        issues.push(`Line ${i + 1} (${l.description}): ${q} × ${r}${l.discount_pct ? ` − ${l.discount_pct}%` : ""} = ${exp.toFixed(2)}, but amount is ${a.toFixed(2)}.`);
    }
  });
  const sum = lines.reduce((s, l) => s + (num(l.amount) || 0), 0) + charges.reduce((s, c) => s + (num(c.amount) || 0), 0) +
    ["cgst", "sgst", "igst", "cess", "round_off"].reduce((s, k) => s + (num(d[k]) || 0), 0);
  if (num(d.total) == null) issues.push("Grand total is missing.");
  else if (Math.abs(sum - d.total) > 1) issues.push(`Lines + charges + taxes + round off = ${sum.toFixed(2)}, but the total is ${(+d.total).toFixed(2)}.`);
  if (num(d.cgst) && num(d.sgst) && Math.abs(d.cgst - d.sgst) > 0.05) issues.push(`CGST (${d.cgst}) and SGST (${d.sgst}) should be equal.`);
  for (const who of ["seller", "buyer"]) {
    const g = cleanGstin(d[who]?.gstin);
    if (g && !gstinValid(g)) issues.push(`The ${who}'s GSTIN ${g} fails the GSTIN checksum, so at least one character is misread.`);
  }
  // tax should be close to rate × taxable
  const byRate = {};
  lines.forEach((l) => { if (num(l.gst_rate)) byRate[l.gst_rate] = (byRate[l.gst_rate] || 0) + (num(l.amount) || 0); });
  const expTax = Object.entries(byRate).reduce((s, [r, t]) => s + (t * r) / 100, 0);
  const gotTax = ["cgst", "sgst", "igst"].reduce((s, k) => s + (num(d[k]) || 0), 0);
  if (expTax && gotTax && Math.abs(expTax - gotTax) > Math.max(2, expTax * 0.02))
    issues.push(`GST at the line rates should be about ${expTax.toFixed(2)}, but the invoice shows ${gotTax.toFixed(2)} — check the GST % of each line.`);
  return issues;
}

// ------------------------------------------------------------ discount normalisation
const r2 = (x) => Math.round(x * 100) / 100;
const isDisc = (c) => /dis(c|count)|less|rebate|cd\b/i.test(c.description || "") && +c.amount < 0;

/** Round-off is often printed as "(-) 0.02" or "Less: Round off" and read with the wrong sign. Use the sign that makes the bill add up. */
export function normaliseRoundOff(d) {
  const total = +d.total;
  if (!isFinite(total) || !total) return d;
  const base = (d.lines || []).reduce((s, l) => s + (+l.amount || 0), 0) + (d.charges || []).reduce((s, c) => s + (+c.amount || 0), 0) +
    ["cgst", "sgst", "igst", "cess"].reduce((s, k) => s + (+d[k] || 0), 0);
  const ro = +d.round_off || 0;
  const off = (x) => Math.abs(base + x - total);
  if (ro && off(ro) > 0.009 && off(-ro) <= 0.009) d.round_off = -ro;               // sign was lost
  else if (!ro && Math.abs(total - base) > 0.004 && Math.abs(total - base) < 1) d.round_off = r2(total - base); // not printed
  return d;
}

/** Make discounts look like Tally's: a % on each item line, amount after discount. */
export function normaliseDiscounts(d) {
  const lines = d.lines || [];
  // 1. Lines whose amount is still the gross (qty × rate) although a discount % is given → apply it.
  for (const l of lines) {
    const q = +l.qty, r = +l.rate, p = +l.discount_pct;
    if (q && r && p && Math.abs(q * r - (+l.amount || 0)) < 0.02) l.amount = r2(q * r * (1 - p / 100));
  }
  // 2. A separate negative "discount" charge that equals a clean % of the items → move it onto the lines.
  const charges = d.charges || [];
  const disc = charges.filter(isDisc);
  if (disc.length === 1 && lines.length && lines.every((l) => !+l.discount_pct)) {
    const gross = lines.reduce((s, l) => s + (+l.amount || 0), 0);
    const pct = gross ? (-disc[0].amount / gross) * 100 : 0;
    const clean = Math.round(pct * 100) / 100;
    if (pct > 0 && pct < 100 && Math.abs(pct - clean) < 0.005 && Math.abs(r2(gross * clean / 100) + +disc[0].amount) <= 0.05) {
      for (const l of lines) {
        l.discount_pct = clean;
        l.amount = l.qty && l.rate ? r2(+l.qty * +l.rate * (1 - clean / 100)) : r2((+l.amount || 0) * (1 - clean / 100));
      }
      d.charges = charges.filter((c) => c !== disc[0]);
    } else if (disc[0].gst_rate == null) {
      // Fixed-rupee discount: it still reduces the taxable value, at the items' GST rate.
      const rates = [...new Set(lines.map((l) => l.gst_rate).filter((x) => x != null))];
      if (rates.length === 1) disc[0].gst_rate = rates[0];
    }
  }
  return normaliseRoundOff(d);
}

// ------------------------------------------------------------ read
const INVOICE_TOOL = { name: "record_invoice", description: "Record the invoice's data.", input_schema: INVOICE_SCHEMA };

export async function readInvoice(env, images, company, vt) {
  if (env.EXTRACTOR === "mock") return mockInvoice();
  const mode = aiMode(env, company);
  const meter = makeMeter(env);
  const p0 = providerOf(mode);
  const first = { p: p0, model: modelOf(env, p0) };
  const second = mode === "gemini" ? { p: "gemini", model: env.GEMINI_MODEL_RECHECK || env.GEMINI_MODEL || "gemini-3.8-flash" }
    : mode === "gemini_lite" || mode === "groq" ? first // the free AIs check their own reading
    : { p: "claude", model: env.ANTHROPIC_MODEL_RECHECK || "claude-opus-5-5" };
  const parts = [];
  images.forEach((b64, i) => { if (images.length > 1) parts.push({ text: `Page ${i + 1} of ${images.length}:` }); parts.push({ b64 }); });
  parts.push({ text: context(company, vt) + " Extract this invoice." });
  const info = {};
  let data = normaliseDiscounts(await ask(env, first.p, parts, INVOICE_TOOL, { model: first.model, meter, info }));
  let issues = checkInvoice(data);
  const ai = { mode, read_by: info.fallback ? `${modelLabel(modelOf(env, info.by || "claude"))} (${first.p === "groq" ? "Groq" : "Gemini"} was unavailable)` : modelLabel(first.model), rechecked_by: null };
  if (info.fallback) ai.gemini_problem = info.fallback.slice(0, 300);
  if (issues.length && env.SECOND_READ !== "off") {
    // A careful second read, told exactly what did not add up.
    const parts2 = parts.slice(0, -1);
    parts2.push({ text: context(company, vt) + "\n\nA first reading of this invoice gave:\n" + JSON.stringify(data) +
      "\n\nThese checks failed:\n- " + issues.join("\n- ") +
      "\n\nRe-read the invoice image digit by digit and return the corrected data. Change only what the image supports; if the invoice itself is wrong, keep what is printed and explain in warnings." });
    try {
      const d2 = normaliseDiscounts(await ask(env, second.p, parts2, INVOICE_TOOL, { model: second.model, meter }));
      const i2 = checkInvoice(d2);
      ai.rechecked_by = modelLabel(second.model);
      if (i2.length <= issues.length) { data = d2; issues = i2; data._rechecked = true; }
    } catch (e) { ai.recheck_error = String(e.message || e).slice(0, 200); }
  }
  ai.cost_usd = Math.round(meter.usd * 1e5) / 1e5;
  data._issues = issues;
  data._ai = ai;
  return data;
}

const SHEET_TOOL = {
  name: "record_invoices", description: "Record every invoice found in the register.",
  input_schema: { type: "object", properties: { invoices: { type: "array", items: INVOICE_SCHEMA } }, required: ["invoices"] },
};

export async function readSheet(env, text, company, vt) {
  if (env.EXTRACTOR === "mock") return [mockInvoice()];
  const meter = makeMeter(env);
  const mode = aiMode(env, company);
  const pr = providerOf(mode), model = modelOf(env, pr);
  const res = await ask(env, pr, [{ text: context(company, vt) +
    " Below is a tab-separated invoice register exported from Excel. Rows with the same invoice number belong to one invoice. Map the columns yourself.\n\n" + text }],
  SHEET_TOOL, { maxTokens: 32000, model, meter });
  const list = res.invoices || [];
  const each = list.length ? meter.usd / list.length : 0;
  return list.map((d) => { normaliseDiscounts(d); return { ...d, _issues: checkInvoice(d), _ai: { mode, read_by: modelLabel(model), cost_usd: Math.round(each * 1e5) / 1e5 } }; });
}

export function mockInvoice() {
  return {
    number: "180", date: "2026-10-02",
    seller: { name: "SHRINIWAS SHANKAR ADAM", gstin: "27ABCPA1234C1ZL", state: "Maharashtra", address: "Solapur" },
    buyer: { name: "VIPUL TEXTILES", gstin: "", state: "Maharashtra" },
    lines: [
      { description: "3060 WHITE 20 DOZ", hsn: "6302", qty: 240, unit: "PCS", alt_qty: 20, alt_unit: "DOZ", rate: 86, discount_pct: 1, amount: 20433.6, gst_rate: 5 },
      { description: "11*11 WHITE 320 DOZ", hsn: "6302", qty: 3840, unit: "PCS", alt_qty: 320, alt_unit: "DOZ", rate: 5.2, discount_pct: 1, amount: 19768.32, gst_rate: 5 },
    ],
    charges: [], cgst: 1005.05, sgst: 1005.05, igst: null, round_off: -0.02, total: 42212, handwritten: false, warnings: [], _issues: [],
  };
}

// ------------------------------------------------------------ bank statements
const BANK_SYSTEM =
  "You are an expert Indian accountant reading bank statements for entry into Tally. Statements come from every kind of " +
  "bank — public, private, small finance and co-operative banks — as printed PDFs, scans or photos, in any layout. " +
  "Copy every transaction row exactly; never skip, merge, reorder or invent rows. Opening balance, closing balance, " +
  "page totals and headings are not transactions. A narration that wraps onto following lines belongs to the row above. " +
  "Indian number grouping: 1,23,456.78. Amounts marked Dr / withdrawal / debit are debits; Cr / deposit / credit are " +
  "credits. A balance marked Dr (overdrawn) is negative. Dates are Indian DD/MM/YYYY; use the transaction (posting) date, " +
  "not the value date; output YYYY-MM-DD. Check yourself: each balance = previous balance + credit − debit.";

const BANK_SCHEMA = {
  type: "object",
  properties: {
    opening_balance: { type: ["number", "null"], description: "Opening / brought-forward balance printed on this page, or null" },
    closing_balance: { type: ["number", "null"], description: "Closing / carried-forward balance printed on this page, or null" },
    transactions: {
      type: "array",
      description: "Every transaction row on this page, top to bottom, in printed order.",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "Transaction date YYYY-MM-DD" },
          narration: { type: "string", description: "Full narration / particulars, including wrapped lines" },
          ref: { type: "string", description: "Cheque / reference number column, or empty" },
          debit: { type: "number", description: "Withdrawal amount, 0 if none" },
          credit: { type: "number", description: "Deposit amount, 0 if none" },
          balance: { type: ["number", "null"], description: "Balance after this row (negative if Dr), or null if not printed" },
        },
        required: ["date", "narration", "debit", "credit"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["transactions"],
};
const BANK_TOOL = { name: "record_bank_page", description: "Record every transaction on this bank statement page.", input_schema: BANK_SCHEMA };

/**
 * One statement page: its text (digital PDF / Excel chunk) or its image (scan).
 * strong=true uses the careful model (used to re-read a page whose balances did not add up).
 */
export async function readBankPage(env, page, company, { prevBalance = null, strong = false, problem = "" } = {}) {
  if (env.EXTRACTOR === "mock") return mockBankPage(page);
  const mode = aiMode(env, company);
  const meter = makeMeter(env);
  const useClaude = strong ? mode !== "gemini" : mode === "claude";
  const model = useClaude ? (strong ? env.ANTHROPIC_MODEL_RECHECK || "claude-opus-5-5" : env.ANTHROPIC_MODEL || "claude-sonnet-5-5")
    : strong ? env.GEMINI_MODEL_RECHECK || env.GEMINI_MODEL || "gemini-3.8-flash" : env.GEMINI_MODEL || "gemini-3.8-flash";
  const parts = [];
  if (page.kind === "image") parts.push({ b64: page.content });
  else parts.push({ text: "Text of the statement page (columns are separated by runs of spaces):\n\n" + page.content });
  let ask2 = `Statement of ${company.name}'s account.`;
  if (prevBalance != null) ask2 += ` The balance at the end of the previous page was ${prevBalance}.`;
  if (problem) ask2 += `\n\nAn earlier reading of this page did not add up: ${problem}\nRead every amount and balance again digit by digit.`;
  parts.push({ text: ask2 });
  const res = await ask(env, useClaude ? "claude" : "gemini", parts, BANK_TOOL, { model, meter, system: BANK_SYSTEM, maxTokens: 32000 });
  const rows = (res.transactions || []).map((t) => ({ date: String(t.date || "").slice(0, 10), narration: String(t.narration || "").trim(),
    ref: String(t.ref || "").trim(), debit: Math.abs(+t.debit || 0), credit: Math.abs(+t.credit || 0), balance: t.balance == null ? null : +t.balance }));
  return { rows, opening: res.opening_balance ?? null, closing: res.closing_balance ?? null, warnings: res.warnings || [],
    read_by: modelLabel(model), cost_usd: Math.round(meter.usd * 1e5) / 1e5 };
}

/** Test reader: "DD/MM/YYYY  narration   debit   credit   balance" lines. */
function mockBankPage(page) {
  const rows = [];
  for (const line of String(page.content || "").split("\n")) {
    const c = line.split(/\s{3,}|\t/).map((x) => x.trim());
    const m = c[0]?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m || c.length < 5) continue;
    const n = (v) => +String(v || "0").replace(/,/g, "") || 0;
    rows.push({ date: `${m[3]}-${m[2]}-${m[1]}`, narration: c[1], ref: "", debit: n(c[2]), credit: n(c[3]), balance: n(c[4]) });
  }
  return { rows, opening: null, closing: null, warnings: [], read_by: "Test reader", cost_usd: 0 };
}
