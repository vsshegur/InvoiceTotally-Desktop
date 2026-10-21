// Locally persisted, tamper-evident posting audit. No invoice images or raw XML stored in the log.
// The hash chain makes accidental/after-the-fact modification detectable, not impossible.
import crypto from "node:crypto";
import { now } from "./db.js";

export const sha256 = value => crypto.createHash("sha256").update(String(value || "")).digest("hex");
const safe = value => String(value ?? "").replace(/[\x00-\x1f]/g, " ").slice(0, 800);
let append = Promise.resolve();

export async function audit(D, job, phase, detail = "", tallyCompany = "") {
  // Serialize chained inserts. Failure to write an attempted event must block posting.
  const work = async () => {
    const at = now();
    const last = await D.first("SELECT entry_hash FROM posting_audit ORDER BY id DESC LIMIT 1");
    const previous = last?.entry_hash || "GENESIS";
    const record = {
      company_id: job.company_id, job_id: job.id, invoice_id: job.invoice_id || "",
      kind: job.kind, phase, target_company: tallyCompany || "",
      payload_sha256: sha256(job.payload), detail: safe(detail), previous_hash: previous, at
    };
    const h = sha256(JSON.stringify(record));
    await D.run("INSERT INTO posting_audit(company_id,job_id,invoice_id,kind,phase,target_company,payload_sha256,detail,previous_hash,entry_hash,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      record.company_id, record.job_id, record.invoice_id, record.kind, record.phase, record.target_company,
      record.payload_sha256, record.detail, record.previous_hash, h, record.at);
    return h;
  };
  const result = append.then(work, work);
  append = result.catch(() => {});
  return result;
}
export async function auditRows(D, cid, limit = 200) {
  const n = Math.min(1000, Math.max(1, Number(limit) || 200));
  return D.all("SELECT id,company_id,job_id,invoice_id,kind,phase,target_company,payload_sha256,detail,previous_hash,entry_hash,at FROM posting_audit WHERE company_id=? ORDER BY id DESC LIMIT ?", cid, n);
}
export async function verifyAudit(D) {
  const all = await D.all("SELECT * FROM posting_audit ORDER BY id");
  let previous = "GENESIS";
  for (const row of all) {
    const record = {
      company_id: row.company_id, job_id: row.job_id, invoice_id: row.invoice_id || "", kind: row.kind,
      phase: row.phase, target_company: row.target_company || "", payload_sha256: row.payload_sha256,
      detail: row.detail || "", previous_hash: row.previous_hash, at: row.at
    };
    if (row.previous_hash !== previous || sha256(JSON.stringify(record)) !== row.entry_hash)
      return { ok: false, events: all.length, first_bad_event: row.id };
    previous = row.entry_hash;
  }
  return { ok: true, events: all.length, latest_hash: previous };
}
