// Month-end closing, Tally ledger health, the 180-day ITC alert and supplier follow-up (engine/accounting-tools.js,
// engine/tally-health.js). Plain script: uses the app's helpers (api, esc, money, toast, route, $, $$).
"use strict";
const GT = {
  rupees: (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  dmy: (d) => (d ? String(d).split("-").reverse().join("-") : ""),
  icon: { ok: ["good", "✓"], warn: ["warn", "!"], bad: ["bad", "✗"], none: ["muted", "–"], manual: ["muted", "☐"], todo: ["warn", "○"] },
  href: (cid, link) => (!link ? "" : /^(p2b|g|b|s|e)\//.test(link) ? "#/" + link : `#/c/${cid}/${link}`),
  prevMonth() { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); },
  shift(p, n) { const [y, m] = p.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); },
};
let MONTH_END_PERIOD = null;

// ------------------------------------------------------------------------------------------ month-end
async function companyMonthEnd(c, el) {
  const period = MONTH_END_PERIOD || GT.prevMonth();
  el.innerHTML = `<div class="card empty">Checking ${esc(period)}…</div>`;
  const m = await api(`/companies/${c.id}/month-end?period=${period}`);
  const st = (s) => { const [cls, ch] = GT.icon[s.state] || GT.icon.none; return `<span class="me-dot ${cls}" aria-label="${esc(s.state)}">${ch}</span>`; };
  const g = m.gstr3b, heads = ["igst", "cgst", "sgst", "cess"];
  const row = (label, o, note = "") => `<tr><td>${label}${note ? `<div class="muted small">${note}</div>` : ""}</td>${heads.map((h) => `<td class="num">${GT.rupees(o[h])}</td>`).join("")}<td class="num"><b>${GT.rupees(heads.reduce((a, h) => a + (+o[h] || 0), 0))}</b></td></tr>`;
  el.innerHTML = `
    <div class="me-head card">
      <button class="btn sm" id="mePrev" aria-label="Previous month">←</button>
      <div><div class="eyebrow">Closing</div><h2 style="margin:2px 0">${esc(m.label)}</h2></div>
      <button class="btn sm" id="meNext" aria-label="Next month">→</button>
      <span class="spacer"></span>
      <div class="me-progress"><b>${m.done} of ${m.of}</b> done<div class="me-bar"><span style="width:${Math.round((100 * m.done) / Math.max(1, m.of))}%"></span></div></div>
    </div>
    <div class="card flush" style="margin-top:12px"><table class="grid me-steps"><tbody>
      ${m.steps.map((s) => `<tr><td style="width:34px">${st(s)}</td><td><b>${esc(s.title)}</b><div class="muted small">${esc(s.detail || "")}</div></td>
        <td style="text-align:right">${s.link ? `<a class="btn sm" href="${GT.href(c.id, s.link)}">Open →</a>` : ""}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="card" style="margin-top:16px;padding:16px">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><h3 style="margin:0">GSTR-3B estimate</h3>
        <span class="muted small">Output tax from ${g.output_source === "tally" ? "Tally's sales (read on GST reconciliation)" : "sales posted by this app (read Tally's sales on GST reconciliation for all of them)"} · ITC from GSTR-2B</span></div>
      <div style="overflow:auto;margin-top:10px"><table class="grid"><thead><tr><th></th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Cess</th><th class="num">Total</th></tr></thead><tbody>
        ${row("Output tax on sales", g.output)}${row("Input tax credit (GSTR-2B, eligible)", g.itc, "includes ITC on reverse charge")}${row("Reverse charge tax", g.rcm, "paid in cash, then claimed as ITC")}
      </tbody></table></div>
      <div class="me-cash"><div><span class="muted small">Estimated cash to pay</span><b>${GT.rupees(g.cash_estimate)}</b></div>
        ${g.carry_forward ? `<div><span class="muted small">ITC left to carry forward</span><b>${GT.rupees(g.carry_forward)}</b></div>` : ""}
        <p class="muted small" style="margin:0;flex-basis:100%">An estimate for planning: heads are set off in total here, and opening ITC balance, interest and late fee aren't included. File from the GST portal's own figures.</p></div>
    </div>`;
  const go = (n) => { MONTH_END_PERIOD = GT.shift(period, n); companyMonthEnd(c, el); };
  $("#mePrev").onclick = () => go(-1);
  $("#meNext").onclick = () => go(1);
}

// ------------------------------------------------------------------------------------------ Tally ledger health
const HEALTH_TITLES = { company: "Your company", parties: "Parties — GSTIN, state, registration", duplicates: "Same GSTIN on more than one ledger",
  tax: "GST tax ledgers", expenses: "Fee & expense ledgers used on bills", stock: "Stock items used on bills" };
async function companyHealth(c, el) {
  el.innerHTML = `<div class="card empty">Checking your Tally masters…</div>`;
  const h = await api(`/companies/${c.id}/tally-health`);
  let q = "";
  const draw = () => {
    const sections = Object.entries(h.sections).map(([k, items]) => [k, items.filter((x) => !q || (x.name + " " + x.msg).toLowerCase().includes(q))]).filter(([, items]) => items.length);
    $("#hBody").innerHTML = sections.length ? sections.map(([k, items]) => `<h3 style="margin:18px 0 8px">${esc(HEALTH_TITLES[k] || k)} <span class="count">${items.length}</span></h3>
      <div class="card flush"><table class="grid"><tbody>${items.slice(0, 400).map((x) => `<tr><td style="width:30px"><span class="me-dot ${x.level === "error" ? "bad" : "warn"}">${x.level === "error" ? "✗" : "!"}</span></td>
        <td style="min-width:180px"><b>${esc(x.name)}</b></td><td>${esc(x.msg)}<div class="muted small">${esc(x.fix || "")}</div></td></tr>`).join("")}</tbody></table></div>`).join("")
      : `<div class="card empty">${q ? "Nothing matches." : "✓ Nothing to fix — your Tally masters are in good shape for GST."}</div>`;
  };
  el.innerHTML = `<div class="tiles" style="margin-bottom:6px">
      <div class="tile"><span class="ti bad">✗</span><b>${h.errors} to fix</b><span class="muted small">Will put vouchers in GSTR-3B uncertain transactions, or post them wrong</span></div>
      <div class="tile"><span class="ti warn">!</span><b>${h.warnings} to check</b><span class="muted small">Worth correcting once in Tally</span></div>
      <div class="tile"><span class="ti">☰</span><b>${h.checked.ledgers} ledgers · ${h.checked.stock_items} items</b><span class="muted small">${h.masters_imported_at ? "read from Tally " + ago(h.masters_imported_at) : "not read yet"}</span></div></div>
    ${h.checked.gst_details_read ? "" : `<div class="alert warn" style="margin:10px 0">Press <b>Import masters</b> (top right) once — this version also reads each ledger's GST details (tax type, GST applicability) for the checks below.</div>`}
    <p class="muted small">The app never changes Tally masters. Fix each one in Tally (Alter the ledger), then press Import masters and come back.</p>
    <input class="in" id="hQ" placeholder="Search ledger or problem…" style="max-width:320px">
    <div id="hBody"></div>`;
  $("#hQ").oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  draw();
}

// ------------------------------------------------------------------------------------------ 180-day ITC
async function companyItc180(c, el) {
  el.innerHTML = `<div class="card empty">Reading unpaid supplier bills from Tally…</div>`;
  let r;
  try { r = await api(`/companies/${c.id}/itc-180`); }
  catch (e) { el.innerHTML = `<div class="alert warn">${esc(e.message)}. This needs TallyPrime open with “${esc(c.tally_company || c.name)}”.</div>`; return; }
  const t = r.totals;
  el.innerHTML = `<div class="tiles" style="margin-bottom:10px">
      <div class="tile"><span class="ti warn">!</span><b>${GT.rupees(t.itc_due_soon)}</b><span class="muted small">ITC on bills reaching 180 days soon — pay these first</span></div>
      <div class="tile"><span class="ti bad">✗</span><b>${GT.rupees(t.itc_passed)}</b><span class="muted small">ITC on ${t.passed} bill(s) already past 180 days unpaid — reverse in GSTR-3B</span></div>
      <div class="tile"><span class="ti">₹</span><b>${GT.rupees(t.amount)}</b><span class="muted small">${t.bills} unpaid supplier bill(s) 150+ days old</span></div></div>
    <p class="muted small">GST law: input tax credit is lost if the supplier isn't paid within 180 days of the invoice date. Reverse it in GSTR-3B (with interest) and claim it again when you pay. ITC is shown where the bill is in this app or in GSTR-2B.</p>
    ${r.rows.length ? `<div class="card flush" style="overflow:auto"><table class="grid"><thead><tr><th>Supplier</th><th>Bill</th><th>Date</th><th class="num">Days</th><th>Pay by</th><th class="num">Unpaid</th><th class="num">ITC</th><th></th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td><b>${esc(x.party)}</b>${x.gstin ? `<div class="mono muted small">${esc(x.gstin)}</div>` : ""}</td><td class="mono">${esc(x.bill)}</td><td>${GT.dmy(x.date)}</td>
        <td class="num">${x.days}</td><td class="${x.passed ? "bad" : "warn"}">${GT.dmy(x.deadline)}</td><td class="num">${GT.rupees(x.amount)}</td>
        <td class="num">${x.itc == null ? '<span class="muted">—</span>' : GT.rupees(x.itc) + `<div class="muted small">${esc(x.itc_source)}</div>`}</td>
        <td><span class="pill ${x.passed ? "bad" : "warn"}">${x.passed ? "Past 180 days" : 180 - x.days + " days left"}</span></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card empty">✓ No unpaid supplier bill is 150 days old.</div>`}`;
}

// ------------------------------------------------------------------------------------------ supplier follow-up
async function companyFollowup(c, el) {
  const f = await api(`/companies/${c.id}/followups`);
  const t = f.totals;
  const open = f.suppliers.filter((s) => s.open.length), fixed = f.suppliers.filter((s) => s.fixed.length);
  const wa = (s) => { const ph = String(s.phone || "").replace(/\D/g, ""); return `https://wa.me/${ph ? (ph.length === 10 ? "91" + ph : ph) : ""}?text=${encodeURIComponent(s.message || "")}`; };
  el.innerHTML = `<div class="tiles" style="margin-bottom:10px">
      <div class="tile"><span class="ti warn">!</span><b>${GT.rupees(t.tax)}</b><span class="muted small">ITC waiting on ${t.open} invoice(s) suppliers haven't filed</span></div>
      <div class="tile"><span class="ti">✉</span><b>${t.asked} of ${t.suppliers}</b><span class="muted small">suppliers asked</span></div>
      <div class="tile"><span class="ti good">✓</span><b>${t.fixed}</b><span class="muted small">filed by the supplier since — found in a later GSTR-2B</span></div></div>
    <p class="muted small">Filled in each time GSTR-2B is matched with Tally: invoices in your books that aren't in the supplier's GSTR-1 / IFF yet. When a later GSTR-2B has them, they close by themselves.</p>
    ${open.length ? open.map((s, i) => `<div class="card" style="padding:14px;margin:10px 0">
      <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b>${esc(s.party || "—")}</b><span class="mono muted small">${esc(s.gstin || "")}</span>
        <span class="spacer"></span><b>${GT.rupees(s.tax)}</b><span class="muted small">GST on ${s.open.length} invoice(s)</span>
        ${s.messaged_at ? `<span class="pill good">asked ${ago(s.messaged_at)}</span>` : `<span class="pill warn">not asked yet</span>`}</div>
      <table class="grid" style="margin:8px 0"><tbody>${s.open.map((x) => `<tr><td class="mono">${esc(x.num)}</td><td>${GT.dmy(x.dt)}</td><td class="num">${GT.rupees(x.val)}</td><td class="num">GST ${GT.rupees(x.tax)}</td><td class="muted small">missing since ${esc(x.first_period)}</td></tr>`).join("")}</tbody></table>
      <details><summary class="small" style="cursor:pointer">Message</summary><textarea class="in" rows="8" data-msg="${i}" style="font-size:12.5px;margin-top:6px">${esc(s.message || "")}</textarea></details>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <a class="btn primary" target="_blank" rel="noopener" data-wa="${i}" href="${wa(s)}">Send on WhatsApp${s.phone ? "" : " (choose chat)"}</a>
        <button class="btn" data-copy="${i}">Copy message</button><button class="btn" data-asked="${i}">Mark as asked</button></div></div>`).join("")
      : `<div class="card empty">✓ Nothing to chase — every invoice in your books is in the suppliers' GSTR-1 / IFF (as far as the matched GSTR-2B months show).</div>`}
    ${fixed.length ? `<details style="margin-top:14px"><summary class="muted" style="cursor:pointer">Filed since (${t.fixed})</summary><div class="card flush" style="margin-top:8px"><table class="grid"><tbody>
      ${fixed.flatMap((s) => s.fixed.map((x) => `<tr><td>${esc(s.party || "")}</td><td class="mono">${esc(x.num)}</td><td>${GT.dmy(x.dt)}</td><td class="num">${GT.rupees(x.tax)}</td><td class="good small">in GSTR-2B ${esc(x.fixed_period || "")}</td></tr>`)).join("")}</tbody></table></div></details>` : ""}`;
  const mark = async (s) => { await api(`/companies/${c.id}/followups/messaged`, { body: { book_ids: s.open.map((x) => x.book_id) } }); };
  $$("[data-msg]", el).forEach((ta) => ta.oninput = () => { const s = open[+ta.dataset.msg]; s.message = ta.value; el.querySelector(`[data-wa="${ta.dataset.msg}"]`).href = wa(s); });
  $$("[data-wa]", el).forEach((a) => a.addEventListener("click", () => { mark(open[+a.dataset.wa]).then(() => setTimeout(() => companyFollowup(c, el), 600)).catch(() => {}); }));
  $$("[data-copy]", el).forEach((b) => b.onclick = async () => { const s = open[+b.dataset.copy]; try { await navigator.clipboard.writeText(s.message || ""); toast("Copied"); } catch { toast("Copy failed — select the message text", true); } });
  $$("[data-asked]", el).forEach((b) => b.onclick = async () => { await mark(open[+b.dataset.asked]); toast("Marked as asked"); companyFollowup(c, el); });
}
