// Runs the Tally work the engine queues in the jobs table — reading masters, reading GST vouchers, posting
// vouchers and new masters — straight against TallyPrime on this PC, one at a time.
import * as P from "../engine/pipeline.js";
import * as GS from "../engine/gstr2b.js";
import * as EC from "../engine/ecommerce.js";
import * as G2BP from "../engine/gstr2b-purchase.js";
import * as AD from "../engine/audit.js";
import * as T from "../engine/tally.js";
import * as DUP from "../engine/duplicate-check.js";
import { now } from "../engine/db.js";
import * as TL from "./tally.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 400;

/** canPost(company) → true, false, or "other" (the company belongs to another account than the one signed in now) */
export function makeRunner(D, { canPost = async () => true, log = () => {} } = {}) {
  const state = { status: "unknown", detail: "Checking Tally…", companies: [], at: 0, busy: "", posted: 0 };
  let stopped = false;

  /** Is Tally up, and which companies are open? Cached for a few seconds. */
  async function tally(fresh = false) {
    if (!fresh && Date.now() - state.at < (state.status === "ok" ? 8000 : 4000)) return state;
    const list = await TL.openCompanies().catch((e) => { state.detail = e.message; return null; });
    state.at = Date.now();
    if (list === null) Object.assign(state, { status: "down", detail: "TallyPrime is not running, or its connectivity port (9000) is off", companies: [] });
    else Object.assign(state, { status: "ok", detail: list.length ? "Connected" : "Connected — no company is open", companies: list });
    return state;
  }
  const isOpen = (tc) => state.companies.some((n) => n.toLowerCase() === String(tc || "").trim().toLowerCase());

  async function requeue(job, msg) {
    log(`${job.kind} waits: ${msg} — Tally: ${state.status} ${state.detail}`);
    // try again in a few seconds; other companies' work goes ahead meanwhile
    await D.run("UPDATE jobs SET status='pending', result=?, updated_at=? WHERE id=?", msg, now() + 5, job.id);
  }

  /** One job. Returns "done" | "wait" | "idle". */
  async function step() {
    const t = now();
    const next = await D.first("SELECT id FROM jobs WHERE status='pending' AND (updated_at IS NULL OR updated_at<=?) LIMIT 1", t);
    if (!next) return "idle";
    await tally(true);
    if (state.status !== "ok") {
      // every waiting job shows why; nothing is claimed while Tally is closed
      await D.run("UPDATE jobs SET result=? WHERE status='pending' AND (result IS NULL OR result NOT LIKE 'Waiting%')", "Waiting for Tally — it will run when TallyPrime is open");
      return "wait";
    }
    const job = await D.first(`UPDATE jobs SET status='sent', updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='pending'
      AND (updated_at IS NULL OR updated_at<=?) ORDER BY created_at LIMIT 1) RETURNING *`, t, t);
    if (!job) return "idle";
    const c = await P.getCompany(D, job.company_id);
    if (!c) { await D.run("DELETE FROM jobs WHERE id=?", job.id); return "done"; }
    const tc = c.tally_company || c.name;
    if (!isOpen(tc)) {
      // this company's work waits; other companies' work goes ahead
      await D.run("UPDATE jobs SET status='pending', result=?, updated_at=? WHERE company_id=? AND status IN ('pending','sent')",
        `Waiting for “${tc}” to be opened in Tally`, now() + 5, c.id);
      return "done";
    }
    state.busy = job.kind;
    try {
      if (job.kind.startsWith("export_")) await runExport(job);
      else await runPost(job, tc, c);
    } finally { state.busy = ""; }
    return "done";
  }

  async function runExport(job) {
    let reply;
    try { reply = await TL.exportData(job.payload); }
    catch (e) {
      if (e.down || e.timeout) { state.at = 0; await requeue(job, "Waiting for Tally — it will run when TallyPrime answers"); return; }
      await P.jobResult(D, job, false, "", e.message);
      return;
    }
    let rows;
    try {
      rows = job.kind === "export_purchase_gst" ? TL.purchaseGstRows(reply) : TL.masterRows(job.kind, reply);
    } catch (e) { await P.jobResult(D, job, false, "", "Could not read Tally's reply: " + e.message); return; }
    for (let part = 0, i = 0; i < rows.length || part === 0; part++, i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      if (GS.TALLY_ROW_KINDS.has(job.kind)) await GS.storeTallyRows(D, job, chunk, part);
      else await P.storeMastersChunk(D, job.company_id, job.kind, chunk, part);
      if (i + CHUNK >= rows.length) break;
    }
    await P.jobResult(D, job, true, `${rows.length} records`);
    log(`${job.kind}: ${rows.length} found`);
  }

  async function runPost(job, tc, c) {
    if (!["import_voucher", "import_master", "import_bank", "import_ecommerce", "import_gstr2b_purchase"].includes(job.kind)) { await P.jobResult(D, job, false, "", "Unknown job type"); return; }
    const who = await canPost(c);
    if (who === "other") { await requeue(job, `Waiting for ${c.owner_email || "the company's owner"} to sign in on this PC`); return; }
    if (!who) { await P.jobResult(D, job, false, "", "Posting to Tally is not allowed for your account. Ask the admin."); return; }
    if (job.kind === "import_ecommerce") {
      let check;
      try { check = await EC.beforePosting(D, job, tc, (xml) => TL.exportData(xml)); }
      catch (e) {
        if (e.down || e.timeout) { state.at = 0; await requeue(job, "Waiting for Tally to answer the duplicate check"); return; }
        await EC.jobResult(D, job, false, "", "Existing-voucher check failed: " + e.message);
        return; // fail closed: never import without checking Tally
      }
      if (check.duplicate) {
        await AD.audit(D,job,"duplicate_blocked",check.message,tc);
        await EC.jobResult(D,job,false,"",check.message,true); return;
      }
    }
    if(job.kind==="import_gstr2b_purchase"){
      let check;
      try{check=await G2BP.beforePosting(D,job,tc,xml=>TL.exportData(xml));}
      catch(e){
        if(e.down||e.timeout){state.at=0;await requeue(job,"Waiting for Tally purchase duplicate verification");return;}
        const message="Live Tally purchase check failed: "+e.message;
        await AD.audit(D,job,"not_sent",message,tc).catch(err=>log("Audit failure: "+err.message));
        await G2BP.jobResult(D,job,false,"",message);
        return;
      }
      if(check.duplicate){
        await AD.audit(D,job,"duplicate_blocked",check.message,tc);
        await G2BP.jobResult(D,job,false,"",check.message,true);
        return;
      }
    }
    if(job.kind==="import_voucher"){
      // Manual imports and imports from earlier installations are checked in
      // Tally before a new posting. No duplicate inference from amount alone.
      let check;
      try{check=await DUP.guardExternalDuplicate(job,tc,xml=>TL.exportData(xml));}
      catch(e){
        if(e.down||e.timeout){state.at=0;await requeue(job,"Waiting for Tally existing-invoice verification");return;}
        const message="Tally existing-invoice verification failed: "+e.message;
        await AD.audit(D,job,"not_sent",message,tc);
        await P.jobResult(D,job,false,"",message);
        return;
      }
      if(check.duplicate){
        await AD.audit(D,job,"duplicate_blocked",check.message,tc);
        await P.jobResult(D,job,false,"",check.message);
        return;
      }
    }
    try {
      await AD.audit(D,job,"attempt", "Create-only Tally posting requested",tc);
    } catch (e) {
      const message="Posting blocked: the local audit log is unavailable ("+e.message+")";
      if(job.kind==="import_ecommerce") await EC.jobResult(D,job,false,"",message);
      else if(job.kind==="import_gstr2b_purchase")await G2BP.jobResult(D,job,false,"",message);
      else await P.jobResult(D,job,false,"",message);
      return;
    }
    let res;
    try { res = await TL.post(job.payload, tc); }
    catch (e) {
      if (job.kind === "import_gstr2b_purchase") {
        const message="Check Tally before retrying — posting result unknown: "+e.message;
        await AD.audit(D,job,"uncertain",message,tc).catch(err=>log("Audit failure: "+err.message));
        await G2BP.jobResult(D,job,false,"",message,false,true);
        return;
      }
      if (job.kind === "import_ecommerce") {
        // The request might have reached Tally before a timeout or connection reset.
        // Stop; never automatically retry a write with an unknown outcome.
        await AD.audit(D,job,"uncertain","Check Tally before retrying: "+e.message,tc).catch(err=>log("Audit failure: "+err.message));
        await EC.jobResult(D, job, false, "", "Check in Tally before retrying — " + e.message);
        return;
      }
      if (e.down) { state.at = 0; await requeue(job, "Waiting for Tally — it will be posted when TallyPrime is open"); return; } // nothing reached Tally
      const msg = e.timeout ? "Tally took too long to answer. Check in Tally whether it was saved before pushing again." : `Not sent: ${e.message}`;
      await AD.audit(D,job,e.timeout?"uncertain":"not_sent",msg,tc).catch(err=>log("Audit failure: "+err.message));
      await P.jobResult(D, job, false, "", msg);
      return;
    }
    const result=T.parseImportResponse(res.reply);
    await AD.audit(D,job,result.ok && result.created===1 && !result.altered?"created":"rejected",
      result.messages.join("; ") || ("Created "+result.created+", altered "+result.altered+", errors "+result.errors+", exceptions "+result.exceptions),tc)
      .catch(err=>log("Audit failure after Tally response: "+err.message));
    if (job.kind === "import_ecommerce") await EC.jobResult(D, job, true, res.reply);
    else if(job.kind==="import_gstr2b_purchase")await G2BP.jobResult(D,job,true,res.reply);
    else await P.jobResult(D, job, true, res.reply);
    state.posted++;
    log(`Posted ${res.what}`);
  }

  async function recover() {
    // The app stopped while these were with Tally: reads are simply asked again; a post may or may not have been saved.
    await D.run("UPDATE jobs SET status='pending' WHERE status='sent' AND kind LIKE 'export_%'");
    for (const j of await D.all("SELECT * FROM jobs WHERE status='sent'")) {
      const msg = "The app closed while posting this. Check in Tally whether it was saved before pushing again.";
      await AD.audit(D,j,"uncertain",msg).catch(err=>log("Audit recovery failure: "+err.message));
      if (j.kind === "import_ecommerce") await EC.jobResult(D, j, false, "", msg);
      else if(j.kind==="import_gstr2b_purchase")await G2BP.jobResult(D,j,false,"",msg,false,true);
      else await P.jobResult(D, j, false, "", msg);
    }
  }

  async function loop() {
    await recover();
    while (!stopped) {
      let r = "idle";
      // never let one stuck request stop the queue: a step that runs past 10 minutes is left behind
      try { r = await Promise.race([step(), sleep(600_000).then(() => { throw new Error("a Tally request did not finish in 10 minutes"); })]); }
      catch (e) { log("Tally job failed: " + (e.stack || e)); r = "wait"; }
      if (r === "done") continue;
      if (r === "idle") await tally().catch(() => {});
      await sleep(r === "wait" ? 5000 : 1500);
    }
  }

  return { state, tally, step, recover, readOnly: (xml) => TL.exportData(xml), start: () => loop(), stop: () => { stopped = true; } };
}
