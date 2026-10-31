// Processing work units, matching, tax, push to Tally, Tally results.
import { newId, now, jload } from "./db.js";
import { readInvoice, readSheet, splitPages, AIError, makeMeter } from "./reader.js";
import * as M from "./matching.js";
import * as T from "./tally.js";
import { cleanGstin, gstinValid, stateCode, stateName } from "./gst.js";
import { parseAmount } from "./num.js";
import {normalizeInvoiceDate,invoiceDateReview} from "./invoice-period.js";
import {normalizePurchase} from "./line-normalize.js";
import {gstContext,applyGstCheck} from "./gst-preflight.js";

const STALE = 240; // seconds before a claimed unit is considered abandoned
const TRIES = 4;   // a file or invoice is tried this many times, then shown as failed with the reason (never endless)
const backoff = (n) => 20 * n; // seconds to wait before the next try after a temporary AI problem
// "…; it will retry." reads oddly once the page itself says how many tries are left.
const plain = (msg) => String(msg).replace(/[;,.]?\s*it will retry(?: automatically)?\.?/i, "").trim().replace(/[;,]$/, "");

export async function getCompany(D, cid) {
  const c = await D.first("SELECT * FROM companies WHERE id=?", cid);
  if (!c) return null;
  c.settings = jload(c.settings, {});
  c.state_code = c.state_code || stateCode(c.gstin);
  return c;
}

// ======================================================================= work
/** Do one unit of work (split one file, read one sheet, or read one invoice). Returns true if something was done. */
export async function doWork(env, D, { batchId = null } = {}) {
  const t = now();
  const scope = batchId ? "batch_id=?" : "1=1";
  const sargs = batchId ? [batchId] : [];

  // 1. files waiting to be split / sheets to read. A 'ready' file with claimed_at in the future is waiting out a retry pause.
  const f = await D.first(
    `UPDATE files SET status='working', claimed_at=?, attempts=coalesce(attempts,0)+1 WHERE id=(SELECT id FROM files WHERE ${scope} AND
      ((status='ready' AND (claimed_at IS NULL OR claimed_at<=?)) OR (status='working' AND claimed_at<? AND coalesce(attempts,0)<?)) ORDER BY idx LIMIT 1) RETURNING *`,
    t, ...sargs, t, t - STALE, TRIES);
  if (f) {
    const b = await D.first("SELECT * FROM batches WHERE id=?", f.batch_id);
    if(!b)return true; // The batch was deleted while its file was claimed.
    const comp = await getCompany(D, b.company_id);
    try {
      if (f.sheet_text != null) {
        const invs = await readSheet(env, f.sheet_text, comp, b.voucher_type);
        for(const data of invs){
          // A user can delete the batch while the remote AI is reading its sheet.
          // Atomic EXISTS guard prevents any invoice being recreated afterwards.
          const id=newId();
          const inserted=await D.run(
            "INSERT INTO invoices(id,batch_id,company_id,page_ids,status,created_at) "+
            "SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM batches WHERE id=?)",
            id,b.id,comp.id,"[]","reading",now(),b.id);
          if(!inserted.meta?.changes)break;
          await applyExtraction(D,id,data);
        }
        await D.log(`Read ${invs.length} invoice(s) from ${f.filename}`, { batch_id: b.id });
      } else {
        const pages = await D.all("SELECT id, thumb_b64 FROM pages WHERE file_id=? ORDER BY idx", f.id);
        const meter = makeMeter(env);
        const groups = await splitPages(env, pages.map((p) => p.thumb_b64), comp, meter);
        if(!(await D.first("SELECT id FROM batches WHERE id=?",b.id)))return true;
        const base = (await D.first("SELECT count(*) n FROM invoices WHERE batch_id=?", b.id)).n;
        await D.batch(groups.map((g, i) => D.insertStmt("invoices", {
          id: newId(), batch_id: b.id, company_id: comp.id, page_ids: JSON.stringify(g.map((k) => pages[k].id)),
          data: JSON.stringify(i === 0 && meter.usd ? { ai_split_cost: meter.usd } : {}),
          status: "pending", created_at: now(), seq: base + i })));
        if (pages.length > 1) await D.log(`${f.filename}: ${pages.length} pages → ${groups.length} invoice(s)`, { batch_id: b.id });
      }
      await D.update("files", f.id, { status: "done", error: null, note: null });
    } catch (e) {
      const msg = plain(e.message || e);
      const retry = e instanceof AIError && e.retryable && f.attempts < TRIES;
      await D.update("files", f.id, retry ? { status: "ready", claimed_at: now() + backoff(f.attempts), note: msg }
        : { status: "failed", error: e.retryable ? `${msg} — tried ${f.attempts} times. Press Retry to try again.` : msg, note: null });
      await D.log(`${f.filename}: ${msg}${retry ? ` (try ${f.attempts} of ${TRIES})` : ""}`, { batch_id: b.id });
    }
    await refreshStage(D, f.batch_id);
    return true;
  }

  // 2. invoices waiting to be read
  const inv = await D.first(
    `UPDATE invoices SET status='reading', claimed_at=?, attempts=attempts+1 WHERE id=(SELECT id FROM invoices WHERE ${scope} AND
      ((status='pending' AND (claimed_at IS NULL OR claimed_at<=?)) OR (status='reading' AND claimed_at<? AND attempts<?)) ORDER BY seq LIMIT 1) RETURNING *`,
    t, ...sargs, t, t - STALE, TRIES);
  if (inv) {
    const b = await D.first("SELECT * FROM batches WHERE id=?", inv.batch_id);
    if(!b)return true; // Invoice deleted while claimed for a read.
    const comp = await getCompany(D, b.company_id);
    try {
      const ids = jload(inv.page_ids, []);
      const imgs = [];
      if (ids.length) {
        const rows = await D.all(`SELECT id, image_b64 FROM pages WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
        const by = Object.fromEntries(rows.map((r) => [r.id, r.image_b64]));
        for (const pid of ids) if (by[pid]) imgs.push(by[pid]);
      }
      const data = await readInvoice(env, imgs, comp, b.voucher_type);
      if (inv.sync_error) await D.update("invoices", inv.id, { sync_error: null });
      await applyExtraction(D, inv.id, data);
    } catch (e) {
      const msg = plain(e.message || e);
      const retry = e instanceof AIError && e.retryable && inv.attempts < TRIES;
      await D.update("invoices", inv.id, retry ? { status: "pending", claimed_at: now() + backoff(inv.attempts), sync_error: `Trying again shortly: ${msg}` }
        : { status: "error", sync_error: `Could not read: ${msg}${inv.attempts >= TRIES && e.retryable ? ` — tried ${inv.attempts} times. Press Retry to try again.` : ""}` });
    }
    await refreshStage(D, inv.batch_id);
    return true;
  }

  // 3. nothing to do: give up on work that stopped part-way too often (the reader was cut off each time)
  const gaveUp = await D.many([
    [`UPDATE files SET status='failed', error=?, note=NULL WHERE ${scope} AND status='working' AND claimed_at<? AND coalesce(attempts,0)>=? RETURNING batch_id`,
      `Reading stopped before it finished, ${TRIES} times. Try a smaller file (fewer pages), or press Retry.`, ...sargs, t - STALE, TRIES],
    [`UPDATE invoices SET status='error', sync_error=? WHERE ${scope} AND status='reading' AND claimed_at<? AND attempts>=? RETURNING batch_id`,
      `Could not read: reading stopped before it finished, ${TRIES} times. Press Retry to try again.`, ...sargs, t - STALE, TRIES]]);
  for (const id of new Set(gaveUp.flat().map((r) => r.batch_id))) await refreshStage(D, id);
  return false;
}

export async function refreshStage(D, batchId) {
  const [[bf], [bi], [b], [files]] = await D.many([
    ["SELECT count(*) n FROM files WHERE batch_id=? AND status IN ('uploading','ready','working')", batchId],
    ["SELECT count(*) n FROM invoices WHERE batch_id=? AND status IN ('pending','reading')", batchId],
    ["SELECT stage FROM batches WHERE id=?", batchId],
    ["SELECT count(*) n, sum(status='failed') f FROM files WHERE batch_id=?", batchId]]);
  const busyFiles = bf.n, busyInv = bi.n;
  if (!b || b.stage === "uploading") return;
  let stage = busyFiles ? "find" : busyInv ? "read" : "review";
  if (stage === "review" && files.n && files.f === files.n) stage = "error";
  if (stage !== b.stage) await D.update("batches", batchId, { stage, error: stage === "error" ? "Every file failed to read — see the activity log." : null });
}

// ======================================================================= extraction → invoice
const numOrNull = (v) => parseAmount(v);

function lineRow(invoiceId, idx, kind, l) {
  return {
    id: newId(), invoice_id: invoiceId, idx, kind, description: String(l.description || "").trim(),
    hsn: String(l.hsn || "").trim(), qty: numOrNull(l.qty), unit: String(l.unit || "").trim(),
    alt_qty: numOrNull(l.alt_qty), alt_unit: String(l.alt_unit || "").trim(), rate: numOrNull(l.rate),
    discount_pct: numOrNull(l.discount_pct), amount: numOrNull(l.amount) || 0, gst_rate: numOrNull(l.gst_rate),
    stock_state: kind === "item" ? "suspense" : null, ledger_state: "suspense",
  };
}
export { lineRow };

export async function applyExtraction(D, invId, data) {
  const inv = await D.first("SELECT i.*, b.voucher_type,b.period_mode,b.expected_period,b.fy_start,b.created_at AS batch_created_at FROM invoices i JOIN batches b ON b.id=i.batch_id WHERE i.id=?", invId);
  if(!inv)return; // Deleted while AI was processing — never restore a removed invoice.
  const vt = inv.voucher_type;
  const party = (vt === "Purchase" ? data.seller : data.buyer) || {};
  const h = {
    number: String(data.number || "").trim(), date: normDate(data.date) || data.date || "",
    party_name: String(party.name || "").trim(), party_gstin: cleanGstin(party.gstin),
    party_address: party.address || "", party_state: party.state || "", place_of_supply: data.place_of_supply || "",
    cgst: numOrNull(data.cgst), sgst: numOrNull(data.sgst), igst: numOrNull(data.igst), cess: numOrNull(data.cess),
    round_off: numOrNull(data.round_off), total: numOrNull(data.total), handwritten: !!data.handwritten,
    rechecked: !!data._rechecked, warnings: [...(data.warnings || []), ...(data._issues || [])], narration: "",
    ai: data._ai || null,
  };
  // Sticky evidence of an AI-misread date remains until manually verified.
  // Re-reading never silently clears a previous date warning.
  const prev = jload(inv.data, {});
  const initialReview=invoiceDateReview({...inv,data:h});
  if(initialReview.reasons.length)h.date_issue_original=
    prev.date_issue_original||initialReview.reasons[0];
  else if(prev.date_issue_original)h.date_issue_original=prev.date_issue_original;
  h.date_verified_at=null;
  h.date_verified_value=null;
  if (h.ai && prev.ai_split_cost) h.ai.cost_usd = Math.round((h.ai.cost_usd + prev.ai_split_cost) * 1e5) / 1e5;
  const dup = await findDuplicate(D, inv.company_id, invId, h.number, h.party_gstin, h.party_name);
  if (dup) h.warnings.push(`Possible duplicate: invoice ${h.number} from this party is already ${dup.status === "synced" ? "in Tally" : "uploaded"} (batch ${dup.batch_name}).`);
  // Purchase bills: dozen → pieces, and a separate discount line → discount % on every item (see line-normalize.js).
  let itemLines = data.lines || [], chargeLines = data.charges || [];
  if (vt === "Purchase") {
    const nz = normalizePurchase(data);
    itemLines = nz.lines; chargeLines = nz.charges;
    h.conversions = nz.notes;
    h.unit_review = nz.review;
    h.unit_ack = false;
  }
  const stmts = [D.stmt("DELETE FROM lines WHERE invoice_id=?", invId)];
  let idx = 0;
  for (const l of itemLines) stmts.push(D.insertStmt("lines", lineRow(invId, idx++, "item", l)));
  for (const c of chargeLines) stmts.push(D.insertStmt("lines", lineRow(invId, idx++, "ledger", c)));
  stmts.push(D.updateStmt("invoices", invId, { data: JSON.stringify(h), status: "review", tax_lines: null, party_ledger: null,
    party_method: null, party_proposed: null, sync_error: null }));
  await D.batch(stmts);
  await autoMatch(D, invId);
}

export async function findDuplicate(D, cid, invId, number, gstin, name, partyLedger = null) {
  if (!number) return null;
  const rows = await D.all(`SELECT i.id, i.status, i.data, i.party_ledger, b.name batch_name FROM invoices i JOIN batches b ON b.id=i.batch_id
    WHERE i.company_id=? AND i.id<>? AND i.status NOT IN ('pending','reading','error') AND i.data LIKE ?`, cid, invId, `%"number":"${String(number).replace(/["%_\\]/g, "")}"%`);
  for (const r of rows) {
    const d = jload(r.data, {});
    if (String(d.number || "").trim().toUpperCase() !== String(number).trim().toUpperCase()) continue;
    if ((gstin && d.party_gstin === gstin) || (partyLedger && r.party_ledger === partyLedger) ||
        (name && M.normParty(d.party_name) === M.normParty(name))) return r;
  }
  return null;
}

export async function autoMatch(D, invId, onlyUnresolved = false) {
  const inv = await loadInvoice(D, invId);
  const comp = await getCompany(D, inv.company_id);
  if (!inv || !comp) return;
  const vt = inv.voucher_type, h = inv.data;
  const stmts = [];
  let party = inv.party_ledger;
  if (!(onlyUnresolved && inv.party_ledger)) {
    const m = await M.matchParty(D, comp.id, vt, h.party_name, h.party_gstin);
    party = m.state === "resolved" ? m.ledger : null;
    stmts.push(D.updateStmt("invoices", invId, m.state === "resolved"
      ? { party_ledger: m.ledger, party_method: m.method, party_proposed: null }
      : { party_ledger: null, party_method: m.method, party_proposed: m.ledger }));
  }
  // A supplier remembered as "post to this ledger, as a voucher": every line not already given a stock item by hand
  // goes to that ledger, so their bills need no Stock step.
  const voucherLedger = party ? await M.aliasGet(D, comp.id, "voucher", `${vt}:${party}`) : null;
  // Lines are matched in parallel (each line: stock item first, then its ledger).
  const lineStmts = await Promise.all(inv.lines.map(async (l) => {
    const upd = {};
    if (voucherLedger && !(l.kind === "item" && l.stock_state === "resolved")) {
      if (l.kind !== "ledger" || l.ledger_state !== "resolved") {
        // a fee remembered on its own (Flipkart "Shipping fee" → its ledger) wins over "every line from this party"
        const own = await M.aliasGet(D, comp.id, "party_charge", M.partyChargeKey(vt, party, l.description));
        const ledger = own && (await D.first("SELECT 1 x FROM masters WHERE company_id=? AND kind='ledger' AND name=?", comp.id, own)) ? own : voucherLedger;
        return D.updateStmt("lines", l.id, { kind: "ledger", stock_item: null, stock_state: null, ledger, ledger_state: "resolved" });
      }
      return null;
    }
    if (l.kind === "item" && l.stock_state !== "resolved") {
      const s = await M.matchStock(D, comp.id, l, party);
      upd.stock_item = s.item; upd.stock_state = s.state; l.stock_item = s.item;
    }
    if (l.ledger_state !== "resolved") {
      const v = await M.matchValueLedger(D, comp.id, vt, l, party, comp.settings);
      upd.ledger = v.ledger; upd.ledger_state = v.state;
    }
    return Object.keys(upd).length ? D.updateStmt("lines", l.id, upd) : null;
  }));
  await D.batch([...stmts, ...lineStmts.filter(Boolean)]);
  if (party) await gstinFromLedger(D, invId);
}

/**
 * The party's GSTIN from its Tally ledger, where you verified it. Without `force` only when the bill's GSTIN is missing
 * or misread (fails the check digit); with `force` (the "Use GSTIN from Tally" button) always. The AI's reading is kept.
 */
export async function gstinFromLedger(D, invId, force = false) {
  const inv = await D.first("SELECT id, company_id, party_ledger, data, tax_lines FROM invoices WHERE id=?", invId);
  if (!inv?.party_ledger) return false;
  const led = await D.first("SELECT gstin, state FROM masters WHERE company_id=? AND kind='ledger' AND name=?", inv.company_id, inv.party_ledger);
  const g = cleanGstin(led?.gstin);
  if (!g || !gstinValid(g)) return false;
  const h = jload(inv.data, {});
  const cur = cleanGstin(h.party_gstin);
  if (cur === g || (!force && cur && gstinValid(cur))) return false;
  h.party_gstin_read = h.party_gstin_read || h.party_gstin || "";
  h.party_gstin = g;
  h.party_state = led.state || stateName(g.slice(0, 2)) || h.party_state;
  h.gstin_from_tally = true;
  h.warnings = (h.warnings || []).filter((w) => !/^GSTIN .* fails the checksum/.test(w));
  await D.update("invoices", invId, { data: JSON.stringify(h) });
  await D.log(`GSTIN ${g} taken from Tally ledger ${inv.party_ledger}${h.party_gstin_read ? ` (bill read ${h.party_gstin_read})` : ""}`, { invoice_id: invId });
  if (inv.tax_lines) await calculateTax(D, invId).catch(() => null); // IGST vs CGST+SGST may change with the state
  return true;
}

export async function loadInvoice(D, invId) {
  const [[inv], lines] = await D.many([
    ["SELECT i.*, b.voucher_type,b.period_mode,b.expected_period,b.fy_start,b.created_at AS batch_created_at FROM invoices i JOIN batches b ON b.id=i.batch_id WHERE i.id=?", invId],
    ["SELECT * FROM lines WHERE invoice_id=? ORDER BY idx", invId]]);
  if (!inv) return null;
  inv.data = jload(inv.data, {});
  inv.page_ids = jload(inv.page_ids, []);
  inv.tax_lines = jload(inv.tax_lines, null);
  inv.lines = lines;
  if (inv.party_ledger) inv.party_ledger_gstin = (await D.first("SELECT gstin FROM masters WHERE company_id=? AND kind='ledger' AND name=?", inv.company_id, inv.party_ledger))?.gstin || null;
  inv.date_review=invoiceDateReview(inv);
  inv.steps = stepStatus(inv);
  inv.computed_total = computedTotal(inv);
  applyGstCheck(inv, await gstContext(D, inv.company_id, [inv]));
  return inv;
}

/** Load all invoices of a batch with 2 queries (cheap). */
export async function loadBatchInvoices(D, batchId, statuses = null) {
  let [invs, lines] = await D.many([
    ["SELECT i.*, b.voucher_type,b.period_mode,b.expected_period,b.fy_start,b.created_at AS batch_created_at FROM invoices i JOIN batches b ON b.id=i.batch_id WHERE i.batch_id=? ORDER BY i.seq, i.created_at", batchId],
    ["SELECT l.* FROM lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.batch_id=? ORDER BY l.idx", batchId]]);
  if (statuses) invs = invs.filter((i) => statuses.includes(i.status));
  const by = {};
  for (const l of lines) (by[l.invoice_id] ||= []).push(l);
  const parties = [...new Set(invs.map((i) => i.party_ledger).filter(Boolean))];
  const gstinOf = new Map();
  for (let k = 0; k < parties.length; k += 400) {
    const part = parties.slice(k, k + 400);
    for (const r of await D.all(`SELECT name, gstin FROM masters WHERE company_id=? AND kind='ledger' AND name IN (${part.map(() => "?").join(",")})`, invs[0].company_id, ...part)) gstinOf.set(r.name, r.gstin);
  }
  for (const inv of invs) {
    inv.data = jload(inv.data, {});
    inv.page_ids = jload(inv.page_ids, []);
    inv.tax_lines = jload(inv.tax_lines, null);
    inv.lines = by[inv.id] || [];
    if (inv.party_ledger) inv.party_ledger_gstin = gstinOf.get(inv.party_ledger) || null;
    inv.date_review=invoiceDateReview(inv);
    inv.steps = stepStatus(inv);
    inv.computed_total = computedTotal(inv);
  }
  if (invs.length) { const ctx = await gstContext(D, invs[0].company_id, invs); for (const inv of invs) applyGstCheck(inv, ctx); }
  return invs;
}

export function computedTotal(inv) {
  const items = inv.lines.reduce((a, l) => a + (l.amount || 0), 0);
  const extra = inv.tax_lines ? inv.tax_lines.reduce((a, t) => a + t.amount, 0)
    : ["cgst", "sgst", "igst", "cess", "round_off"].reduce((a, k) => a + (+inv.data[k] || 0), 0);
  return Math.round((items + extra) * 100) / 100;
}

export function stepStatus(inv) {
  const lines = inv.lines;
  const party = !!inv.party_ledger;
  const stock = lines.filter((l) => l.kind === "item").every((l) => l.stock_state === "resolved");
  const ledger = lines.every((l) => l.ledger_state === "resolved");
  const tax = !!inv.tax_lines && inv.tax_lines.every((t) => t.ledger);
  const h = inv.data || {};
  const computed = computedTotal(inv);
  const totalOk = h.total == null || Math.abs(computed - h.total) <= 1;
  const dateReview=invoiceDateReview(inv);
  const dateOk = !!dateReview.date&&!dateReview.needs_review&&!dateReview.hard_mismatch;
  const blockers = [];
  if (!party) blockers.push("pick the party ledger");
  const billGstin = cleanGstin(h.party_gstin), tallyGstin = cleanGstin(inv.party_ledger_gstin);
  if (party && billGstin && tallyGstin && billGstin !== tallyGstin)
    blockers.push(`GSTIN on the bill (${billGstin}) is not the Tally ledger's (${tallyGstin}) — use Tally's GSTIN, or pick the right party`);
  if (!stock) blockers.push("map every line to a stock item");
  if (!ledger) blockers.push("pick a ledger for every line");
  if (!tax) blockers.push(inv.tax_lines ? "map every tax head to a ledger" : "calculate tax");
  if (!lines.length) blockers.push("add at least one line");
  if (!h.number) blockers.push("invoice number is missing");
  if (!dateReview.date) blockers.push(`date '${h.date || ""}' isn't valid`);
  for(const reason of dateReview.needs_review||dateReview.hard_mismatch ? dateReview.reasons : [])blockers.push(reason);
  if ((h.unit_review || []).length && !h.unit_ack) blockers.push("check the unit / discount lines marked for review and tick “I checked these against the bill”");
  if (!totalOk) blockers.push(`lines + taxes = ₹${computed.toFixed(2)} but the invoice total is ₹${(+h.total).toFixed(2)}`);
  return { party, stock, ledger, tax, total_ok: totalOk, date_ok: dateOk,date_review:dateReview, blockers, ready: blockers.length === 0 };
}

/** Strict date normalization also rejects impossible calendar days (e.g. 31 April). */
export const normDate=normalizeInvoiceDate;

// ======================================================================= tax
export async function calculateTax(D, invId) {
  const inv = await loadInvoice(D, invId);
  const comp = await getCompany(D, inv.company_id);
  const vt = inv.voucher_type, h = inv.data;
  // the party's state decides IGST vs CGST+SGST: from its Tally ledger first (verified there), then the bill
  const led = inv.party_ledger ? await D.first("SELECT gstin, state FROM masters WHERE company_id=? AND kind='ledger' AND name=?", comp.id, inv.party_ledger) : null;
  let partySc = (led && stateCode(led.gstin, led.state)) || stateCode(h.party_gstin, h.party_state);
  const ourSc = comp.state_code;
  const inter = partySc && ourSc ? partySc !== ourSc : !!h.igst && !(h.cgst || h.sgst);
  const r2 = (x) => Math.round(x * 100) / 100;
  const byRate = {};
  // A line's GST rate: as read from the invoice, else from its ledger's name ("PACKING MATERIAL @ 18%").
  const lineRate = (l) => l.gst_rate || +(/@\s*(\d+(?:\.\d+)?)\s*%/.exec(l.ledger || "")?.[1] || 0) || null;
  for (const l of inv.lines) { const rt = lineRate(l); if (rt) byRate[rt] = (byRate[rt] || 0) + (l.amount || 0); }
  // No rate anywhere, but GST is printed on the bill (common when items have no rate column, only an HSN summary):
  // work the rate out from the printed tax, so the GST is never silently left out.
  const printedTax = (+h.igst || 0) + (+h.cgst || 0) + (+h.sgst || 0);
  const taxable = inv.lines.reduce((a, l) => a + (l.amount || 0), 0);
  if (!Object.keys(byRate).length && printedTax > 0 && taxable > 0) {
    const raw = (printedTax / taxable) * 100;
    // the closest standard rate (not the first within 0.2%: 0.1% and 0.25% are both within it of 0.2%)
    const std = [0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40].map((r) => [r, Math.abs(r - raw)]).sort((a, b) => a[1] - b[1]).find(([, d]) => d <= 0.2)?.[0];
    byRate[std ?? r2(raw)] = taxable;
  }
  const heads = [];
  for (const [rate, taxable] of Object.entries(byRate).sort((a, b) => a[0] - b[0])) {
    if (inter) heads.push({ head: "IGST", rate: +rate, amount: r2((taxable * rate) / 100) });
    else { const half = r2((taxable * rate) / 200); heads.push({ head: "CGST", rate: rate / 2, amount: half }, { head: "SGST", rate: rate / 2, amount: half }); }
  }
  for (const head of ["CGST", "SGST", "IGST"]) {
    const printed = h[head.toLowerCase()];
    const rows = heads.filter((x) => x.head === head);
    if (printed && rows.length === 1 && Math.abs(rows[0].amount - printed) <= 1) rows[0].amount = r2(printed);
  }
  if (h.cess) heads.push({ head: "CESS", rate: null, amount: r2(h.cess) });
  const pre = r2(inv.lines.reduce((a, l) => a + (l.amount || 0), 0) + heads.reduce((a, x) => a + x.amount, 0));
  let ro = 0;
  if (h.total && Math.abs(h.total - pre) < 1) ro = r2(h.total - pre);
  else if (h.total && h.round_off && Math.abs(h.total - pre - h.round_off) < 0.01) ro = r2(h.round_off); // printed round-off of ₹1 or more
  else if (comp.settings.round_off !== false) ro = r2(Math.round(pre) - pre);
  if (Math.abs(ro) >= 0.005) heads.push({ head: "ROUND", rate: null, amount: ro });
  const prev = Object.fromEntries((inv.tax_lines || []).map((x) => [`${x.head}|${x.rate}`, x.ledger]));
  const label = { CGST: "CGST", SGST: "SGST", IGST: "IGST", CESS: "Cess", ROUND: "Round Off" };
  await Promise.all(heads.map(async (x) => {
    let led = prev[`${x.head}|${x.rate}`], method = "Kept";
    if (!led) ({ ledger: led, method } = await M.matchTaxLedger(D, comp.id, x.head, x.rate, vt));
    Object.assign(x, { ledger: led, method, label: label[x.head],
      note: x.head === "ROUND" ? "nearest rupee" : `${vt === "Purchase" ? "input" : "output"}, ${inter ? "inter" : "intra"}-state` });
  }));
  await D.update("invoices", invId, { tax_lines: JSON.stringify(heads) });
  return heads;
}

// ======================================================================= masters & jobs
export async function queueJob(D, cid, kind, payload, invoiceId = null) {
  const id = newId();
  await D.insert("jobs", { id, company_id: cid, kind, invoice_id: invoiceId, payload, status: "pending", created_at: now(), updated_at: now() });
  return id;
}

export async function queueImportMasters(D, cid) {
  const c = await getCompany(D, cid);
  await D.run("DELETE FROM jobs WHERE company_id=? AND kind IN ('export_groups','export_units','export_ledgers','export_stock') AND status='pending'", cid);
  let t = now();
  for (const kind of ["export_groups", "export_units", "export_ledgers", "export_stock"]) {
    await D.insert("jobs", { id: newId(), company_id: cid, kind, payload: T.exportRequest(kind, c.tally_company || ""),
      status: "pending", created_at: (t += 0.001), updated_at: t });
  }
}

const KIND = { export_groups: "group", export_ledgers: "ledger", export_stock: "stock_item", export_units: "unit" };

/** Masters read from Tally are stored in chunks: first chunk (part=0) replaces existing non-pending rows. */
export async function storeMastersChunk(D, cid, jobKind, rows, part) {
  const kind = KIND[jobKind];
  const stmts = [];
  if (part === 0) stmts.push(D.stmt("DELETE FROM masters WHERE company_id=? AND kind=? AND pending=0", cid, kind));
  let groups = {};
  if (kind === "ledger") for (const g of await D.all("SELECT name, parent FROM masters WHERE company_id=? AND kind='group'", cid)) groups[g.name] = g.parent;
  for (const r of rows) {
    if (!r.name) continue;
    stmts.push(D.stmt("DELETE FROM masters WHERE company_id=? AND kind=? AND name=? AND pending=1", cid, kind, r.name));
    stmts.push(D.stmt(`INSERT INTO masters (company_id, kind, name, uname, parent, primary_group, gstin, state, hsn, gst_rate, unit, reg_type, tax_type, duty_head, gst_app, pending)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, cid, kind, r.name, M.norm(r.name), r.parent || "",
      kind === "ledger" ? T.resolvePrimary(groups, r.parent || "") : null, cleanGstin(r.gstin) || null, r.state || null,
      r.hsn || null, r.gst_rate ?? null, r.unit || null, r.reg_type || null, r.tax_type || null, r.duty_head || null, r.gst_app || null));
  }
  await D.batch(stmts);
}

export async function createMaster(D, cid, kind, name, kw = {}) {
  const c = await getCompany(D, cid);
  const tc = c.tally_company || "";
  let xml;
  if (kind === "ledger") {
    const parent = kw.parent || "Sundry Creditors";
    const groups = Object.fromEntries((await D.all("SELECT name, parent FROM masters WHERE company_id=? AND kind='group'", cid)).map((g) => [g.name, g.parent]));
    await D.run("INSERT INTO masters (company_id, kind, name, uname, parent, primary_group, gstin, state, pending) VALUES (?,?,?,?,?,?,?,?,1)",
      cid, "ledger", name, M.norm(name), parent, T.resolvePrimary(groups, parent), cleanGstin(kw.gstin) || null, kw.state || null);
    xml = T.ledgerMaster(tc, name, parent, cleanGstin(kw.gstin), kw.state || "", kw.address || "");
  } else {
    const unit = kw.unit || "Nos";
    if (!(await D.first("SELECT 1 x FROM masters WHERE company_id=? AND kind='unit' AND upper(name)=upper(?)", cid, unit))) {
      await D.run("INSERT INTO masters (company_id, kind, name, uname, pending) VALUES (?,?,?,?,1)", cid, "unit", unit, M.norm(unit));
      await queueJob(D, cid, "import_master", T.unitMaster(tc, unit));
    }
    await D.run("INSERT INTO masters (company_id, kind, name, uname, parent, hsn, gst_rate, unit, pending) VALUES (?,?,?,?,?,?,?,?,1)",
      cid, "stock_item", name, M.norm(name), kw.parent || "", kw.hsn || null, kw.gst_rate ?? null, unit);
    xml = T.stockItemMaster(tc, name, unit, kw.hsn || "", kw.gst_rate ?? null, kw.parent || "");
  }
  await queueJob(D, cid, "import_master", xml);
}

export async function buildVoucherXml(D, inv) {
  const names = inv.lines.filter((l) => l.kind === "item").map((l) => l.stock_item);
  const ledgerNames = [...new Set(inv.lines.filter((l) => l.kind === "ledger").map((l) => l.ledger).filter(Boolean))];
  const [[c0], unitRows, [led0], groupRows] = await D.many([
    ["SELECT * FROM companies WHERE id=?", inv.company_id],
    names.length ? [`SELECT name, unit FROM masters WHERE company_id=? AND kind='stock_item' AND name IN (${names.map(() => "?").join(",")})`, inv.company_id, ...names]
      : ["SELECT name, unit FROM masters WHERE 0"],
    ["SELECT gstin, state, reg_type FROM masters WHERE company_id=? AND kind='ledger' AND name=?", inv.company_id, inv.party_ledger],
    ledgerNames.length ? [`SELECT name, primary_group FROM masters WHERE company_id=? AND kind='ledger' AND name IN (${ledgerNames.map(() => "?").join(",")})`, inv.company_id, ...ledgerNames]
      : ["SELECT name, primary_group FROM masters WHERE 0"]]);
  const c = { ...c0, settings: jload(c0.settings, {}) };
  const units = Object.fromEntries(unitRows.map((r) => [r.name, r.unit]));
  const groupOf = Object.fromEntries(groupRows.map((r) => [r.name, r.primary_group || ""]));
  const h = inv.data;
  const led = led0 || {};
  // Tally's ledger is the truth for the party's GST registration (you verify GSTINs there); the bill's reading is the fallback.
  const gstin = cleanGstin(led.gstin) || cleanGstin(h.party_gstin) || "";
  const st = led.state || stateName(stateCode(gstin)) || h.party_state;
  return T.voucher(c.tally_company || "", inv.voucher_type,
    { number: h.number, date: h.date, party_gstin: gstin, party_state: st, party_reg_type: led.reg_type || "", place_of_supply: h.place_of_supply, narration: h.narration },
    inv.party_ledger, inv.lines, inv.tax_lines || [], { sendDescriptions: c.settings.send_descriptions !== false, units,
      reg: T.companyRegistration({ gstin: c.gstin, settings: c.settings }),
      supplyOf: (name) => (/purchase accounts|sales accounts/i.test(groupOf[name] || "") ? "Goods" : "Services") });
}

export async function pushInvoice(D, invId, force = false) {
  const inv = await loadInvoice(D, invId);
  if (!inv) throw new Error("Invoice not found");
  const s = inv.steps;
  if (!s.ready) {
    if (!s.total_ok) throw new Error(`Invoice ${inv.data.number}: lines + taxes don't match the invoice total. Fix it on the invoice screen.`);
    if (!s.date_ok || !inv.data.number) throw new Error(`Invoice ${inv.data.number || ""}: number or date missing.`);
    throw new Error("Resolve party, stock, ledger and tax first.");
  }
  const h = inv.data;
  const dup = await findDuplicate(D, inv.company_id, invId, h.number, h.party_gstin, h.party_name, inv.party_ledger);
  if (dup && ["synced", "queued"].includes(dup.status) && !force)
    throw new Error(`Invoice ${h.number} from ${inv.party_ledger} is already in Tally (batch ${dup.batch_name}).`);
  const xml = await buildVoucherXml(D, inv);
  const t = now();
  await D.batch([
    D.stmt("DELETE FROM jobs WHERE invoice_id=? AND status='pending'", invId),
    D.insertStmt("jobs", { id: newId(), company_id: inv.company_id, kind: "import_voucher", invoice_id: invId, payload: xml, status: "pending", created_at: t, updated_at: t }),
    D.updateStmt("invoices", invId, { status: "queued", sync_error: null }),
    D.stmt("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", inv.batch_id, invId, "Queued for Tally", t)]);
}

// Learn only from vouchers Tally explicitly confirmed as CREATED. Never replace
// a manual alias, and never teach Smart Matching from an AI guess or a queued job.
export async function confirmedPostingMemory(D,invoiceId){
  const inv=await loadInvoice(D,invoiceId);
  if(!inv||!inv.party_ledger)return [];
  const masters=await D.all("SELECT name,kind,gstin,pending FROM masters WHERE company_id=? AND pending=0",inv.company_id);
  const master=(kind,name)=>masters.find(m=>m.kind===kind&&m.name===name);
  const aliases=await D.all("SELECT kind,key,value FROM aliases WHERE company_id=?",inv.company_id);
  const known=new Map(aliases.map(a=>[a.kind+"|"+a.key,a.value]));
  const out=[],stamp=now();
  const remember=(kind,key,value)=>{
    if(!key||!value)return;
    const id=kind+"|"+key;
    // Existing manual/earlier postings always take precedence, including a
    // conflicting explicit choice in another batch.
    if(known.has(id))return;
    known.set(id,value);
    out.push(D.stmt("INSERT OR IGNORE INTO aliases(company_id,kind,key,value) VALUES (?,?,?,?)",
      inv.company_id,kind,key,value));
    out.push(D.stmt("INSERT OR IGNORE INTO smart_posted_memory(company_id,kind,key,value,invoice_id,at) VALUES (?,?,?,?,?,?)",
      inv.company_id,kind,key,value,invoiceId,stamp));
  };
  const h=inv.data,party=master("ledger",inv.party_ledger);
  if(!party)return [];
  if(h.party_gstin&&party.gstin&&h.party_gstin.toUpperCase()!==party.gstin.toUpperCase())return [];
  if(h.party_gstin)remember("party","gstin:"+h.party_gstin.toUpperCase(),party.name);
  if(h.party_name)remember("party","name:"+M.normParty(h.party_name),party.name);
  for(const l of inv.lines){
    if(l.kind==="item"&&l.stock_state==="resolved"&&master("stock_item",l.stock_item)){
      remember("stock_party",M.stockPartyKey(party.name,l.description),l.stock_item);
      if(l.ledger_state==="resolved"&&master("ledger",l.ledger))
        remember("ledger","party_item:"+inv.voucher_type+":"+party.name+":"+l.stock_item,l.ledger);
    }
    if(l.kind==="ledger"&&l.ledger_state==="resolved"&&master("ledger",l.ledger))
      remember("charge",M.norm(l.description),l.ledger);
  }
  for(const tax of inv.tax_lines||[]){
    if(tax.ledger&&master("ledger",tax.ledger))
      remember("tax",inv.voucher_type+":"+tax.head+":"+(tax.rate??""),tax.ledger);
  }
  return out;
}

export async function jobResult(D, job, ok, response, error) {
  let status = ok ? "done" : "failed";
  let confirmedCreated=false;
  let note = error || "";
  const t = now();
  const w = [];
  const log = (message) => w.push(D.stmt("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", null, job.invoice_id, message, t));
  if (job.kind.startsWith("export_")) {
    if (ok) {
      note = response || "Imported";
      if (KIND[job.kind]) w.push(D.stmt("UPDATE companies SET masters_imported_at=? WHERE id=?", t, job.company_id));
    }
  } else if (job.kind === "import_bank") {
    const res = ok ? T.parseImportResponse(response) : { ok: false, messages: [error || "Tally error"] };
    const created=ok && res.ok && res.created===1 && res.altered===0;
    const uncertain=!created && /check in tally|outcome uncertain|too long|closed while posting|result unknown|timeout/i.test(error||"");
    status=created?"done":"failed";
    note=(res.messages||[]).join("; ") || (created?"Created":error||"Tally did not confirm one new bank voucher");
    if(job.invoice_id)w.push(D.updateStmt("bank_lines",job.invoice_id,
      created?{status:"synced",synced_at:t,sync_error:null}: {status:uncertain?"uncertain":"failed",sync_error:note}));
  } else if (job.kind === "import_master" || job.kind === "import_voucher") {
    const res = ok ? T.parseImportResponse(response) : { ok: false, messages: [error || "Tally error"] };
    confirmedCreated=job.kind==="import_voucher"&&res.ok&&res.created===1&&res.altered===0;
    status=(job.kind==="import_voucher"?confirmedCreated:res.ok)?"done":"failed";
    note=res.messages.join("; ")||(status==="done"?"Created":"Tally did not confirm one new voucher; check Tally before retrying");
    if (job.kind === "import_master") {
      const m = job.payload.match(/<(LEDGER|STOCKITEM|UNIT) NAME="([^"]+)"/);
      if (m) {
        const kind = { LEDGER: "ledger", STOCKITEM: "stock_item", UNIT: "unit" }[m[1]];
        const name = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        // created — or already in Tally under that name: either way it exists; Import masters brings its details
        if (res.ok || /already exists|duplicate/i.test(note))
          w.push(D.stmt("UPDATE masters SET pending=0 WHERE company_id=? AND kind=? AND name=? AND pending=1", job.company_id, kind, name));
        // refused for another reason: not left "being created" for ever — it can be created again after fixing
        else if (status === "failed") {
          w.push(D.stmt("DELETE FROM masters WHERE company_id=? AND kind=? AND name=? AND pending=1", job.company_id, kind, name));
          w.push(D.stmt("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", null, null, `Tally did not create ${kind === "stock_item" ? "stock item" : kind} “${name}”: ${note}`.slice(0, 500), t));
        }
      }
    }
    if (job.kind === "import_voucher" && job.invoice_id) {
      w.push(D.updateStmt("invoices", job.invoice_id, confirmedCreated ? { status: "synced", synced_at: t, sync_error: null } : { status: "failed", sync_error: note }));
      log(confirmedCreated ? "Created in Tally" : `Tally did not confirm creation: ${note}`);
    }
  }
  w.push(D.updateStmt("jobs", job.id, { status, result: String(note).slice(0, 2000), updated_at: t }));
  if(confirmedCreated&&job.invoice_id){
    try{w.push(...await confirmedPostingMemory(D,job.invoice_id));}
    catch(e){w.push(D.stmt("INSERT INTO activity(batch_id,invoice_id,message,at) VALUES (?,?,?,?)",
      null,job.invoice_id,"Smart Matching memory not saved: "+String(e.message).slice(0,300),t));}
  }
  await D.batch(w);
  if (ok && job.kind === "export_stock") await rematchCompany(D, job.company_id);
}

export async function rematchCompany(D, cid) {
  const rows = await D.all("SELECT id FROM invoices WHERE company_id=? AND status IN ('review','failed') ORDER BY created_at DESC LIMIT 2000", cid);
  for (const r of rows) await autoMatch(D, r.id, true);
}
