/* Bank statements, the simple way: read on this PC (no AI), every entry posted to one suspense ledger. */
"use strict";

const BankLib = (() => { let m = null; return async () => (m ||= import("/bankparse.js")); })();
const BANK_FIELDS = [["", "—"], ["date", "Date"], ["narration", "Narration"], ["ref", "Cheque / Ref no."], ["debit", "Withdrawal (Dr)"], ["credit", "Deposit (Cr)"],
  ["amount", "Amount (one column)"], ["drcr", "Dr / Cr"], ["balance", "Balance"]];
const bankMapKey = (cid, bank) => `it_bankmap_${cid}_${bank}`;
const loadJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------------------------------------------------------------- company tab: list
async function companyBank(c, el) {
  const rows = await api(`/companies/${c.id}/bank`);
  const l = ME.licence || {};
  el.innerHTML = rows.length ? `<table class="grid"><thead><tr><th>Statement</th><th>Bank → Suspense</th><th>Period</th><th class="num">Entries</th><th>Progress</th></tr></thead><tbody>
    ${rows.map((s) => {
      const n = s.counts || {};
      const toPost = (n.ready || 0) + (n.failed || 0);
      const progress = s.stage === "error" ? `<span class="bad">${esc(s.error || "Failed")}</span>` : s.stage !== "review" ? `<span class="warn">Not finished saving</span>`
        : `<span class="${n.synced && !toPost && !n.queued ? "good" : ""}">${n.synced || 0} in Tally</span>${n.queued ? ` · <span class="warn">${n.queued} sending…</span>` : ""}${toPost ? ` · ${toPost} to post` : ""}${n.duplicate ? ` · <span class="muted">${n.duplicate} posted earlier</span>` : ""}${n.failed ? ` · <span class="bad">${n.failed} rejected</span>` : ""}`;
      return `<tr class="click" data-href="#/s/${s.id}"><td><b>${esc(s.name)}</b><div class="muted small">${ago(s.created_at)}</div></td>
        <td>${esc(s.bank_ledger)} <span class="faint">→</span> <span class="muted">${esc(s.suspense_ledger || "")}</span></td>
        <td class="muted">${s.period_from ? `${fmtDate(s.period_from)} – ${fmtDate(s.period_to)}` : "—"}</td><td class="num">${s.lines}</td><td>${progress}</td></tr>`;
    }).join("")}</tbody></table>`
    : `<div class="card empty" style="text-align:left;max-width:720px"><b>Post a bank statement to Tally in one go</b>
      <p class="muted" style="margin:8px 0 12px">Download the statement from net banking as <b>Excel, CSV or PDF</b> and drop it here. It is read on this PC (no AI),
      every transaction is checked against the running balance, and each one is posted to the <b>suspense ledger</b> you choose — money in as a Receipt,
      money out as a Payment, with the bank's narration and reference. Then move each entry from Suspense to the right ledger in Tally, as usual.
      A transaction already posted from an earlier statement is never posted twice.</p>
      <a class="btn primary" href="#/c/${c.id}/bank/upload">⇪ Upload bank statement</a>
      ${l.unlimited ? "" : `<p class="muted small" style="margin:10px 0 0">Each statement uses one statement credit — you have ${l.statement_credits ?? 0}.</p>`}</div>`;
  $$("tr[data-href]", el).forEach((tr) => tr.onclick = () => location.hash = tr.dataset.href);
  every(4000, () => { if (rows.some((s) => s.counts?.queued)) refresh(); });
}

// ---------------------------------------------------------------- upload
async function viewBankUpload(cid) {
  const [c, banks, susp] = await Promise.all([api(`/companies/${cid}`),
    api(`/companies/${cid}/masters?kind=ledger&groups=${encodeURIComponent("Bank Accounts|Bank OD A/c")}`),
    api(`/companies/${cid}/masters?kind=ledger&groups=${encodeURIComponent("Suspense A/c")}`)]);
  const bankItems = banks.items || [], suspItems = susp.items || [];
  const saved = loadJSON("it_bankpick_" + cid) || {};
  const st = {
    bank: bankItems.some((b) => b.name === saved.bank) ? saved.bank : bankItems.length === 1 ? bankItems[0].name : "",
    suspense: saved.suspense || (suspItems.length === 1 ? suspItems[0].name : ""),
    files: [], parsed: null, mapping: null, busy: false, passwords: {},
  };
  const l = ME.licence || {};
  const head = topBar([[c.name, `#/c/${cid}/bank`], ["Upload bank statement"]], c);

  const render = () => {
    const p = st.parsed;
    const ready = st.bank && st.suspense && p && p.rows.length && !st.busy;
    app().innerHTML = head + `<div class="bar"><span class="status" id="say">${p ? `${plural(p.rows.length, "transaction")} found` : ""}</span><div class="spacer"></div>
      <a class="btn" href="#/c/${cid}/bank">Back <kbd>Esc</kbd></a>
      <button class="btn primary" id="go" ${ready ? "" : "disabled"}>Save statement <kbd>↵</kbd></button></div>
    <div class="page wiz"><div class="eyebrow">Bank statement</div><h1>${esc(c.name)}</h1>
      <div class="wstep active"><div class="head"><span class="n">1</span><b>Which bank account?</b></div>
        ${bankItems.length ? `<div class="choices">${bankItems.map((b) => `<div class="choice ${st.bank === b.name ? "on" : ""}" data-bank="${esc(b.name)}"><div><div><b>${esc(b.name)}</b></div><div class="sub">${esc(b.parent || "")}</div></div>${st.bank === b.name ? "✓" : ""}</div>`).join("")}</div>`
          : `<div class="alert warn">No bank ledgers found. Press <b>Import masters</b> (top right) so your Tally bank ledgers appear here.</div>`}</div>
      <div class="wstep ${st.bank ? "active" : ""}"><div class="head"><span class="n">2</span><b>Post every entry to which suspense ledger?</b></div>${st.bank ? `
        ${suspItems.length ? `<div class="choices">${suspItems.map((b) => `<div class="choice ${st.suspense === b.name ? "on" : ""}" data-susp="${esc(b.name)}"><div><div><b>${esc(b.name)}</b></div><div class="sub">${esc(b.parent || "Suspense A/c")}</div></div>${st.suspense === b.name ? "✓" : ""}</div>`).join("")}</div>` : ""}
        <div class="field" style="margin-top:8px"><label class="muted small">${suspItems.length ? "…or another ledger" : "No ledger under Suspense A/c yet — type the ledger to use (create it in Tally first)"}</label>
          <input class="in" id="suspOther" list="ledgerList" value="${esc(suspItems.some((x) => x.name === st.suspense) ? "" : st.suspense)}" placeholder="Search ledgers…" style="max-width:420px"><datalist id="ledgerList"></datalist></div>` : ""}</div>
      <div class="wstep ${st.bank && st.suspense ? "active" : ""}"><div class="head"><span class="n">3</span><b>The statement</b></div>${st.bank && st.suspense ? `
        <label class="drop" id="drop"><input type="file" id="fi" multiple hidden accept=".pdf,.xlsx,.xlsm,.xls,.csv">
          <div style="font-size:15px;color:var(--text)">Drop the statement here or click to choose</div>
          <div>Excel or CSV export, or the PDF downloaded from net banking. Several files of the same account are read as one statement. Scanned or photographed pages can't be read.</div></label>
        <div class="files">${st.files.map((f, i) => `<div><span>${esc(f.name)}</span><span class="muted">${(f.size / 1024).toFixed(0)} KB <a href="#" data-rm="${i}">✕</a></span></div>`).join("")}</div>
        <div id="result">${resultHtml()}</div>` : ""}</div>
      ${l.unlimited ? "" : `<p class="muted small">Saving uses one statement credit (you have ${l.statement_credits ?? 0}). Reading and checking the file here is free.</p>`}
    </div>`;
    wireTop(c);
    $$("[data-bank]").forEach((el) => el.onclick = () => { st.bank = el.dataset.bank; remember(); reparse(); });
    $$("[data-susp]").forEach((el) => el.onclick = () => { st.suspense = el.dataset.susp; remember(); render(); });
    const other = $("#suspOther");
    if (other) {
      other.oninput = debounce(async () => {
        const r = await api(`/companies/${cid}/masters?kind=ledger&q=${encodeURIComponent(other.value)}`, { quiet: true });
        $("#ledgerList").innerHTML = r.items.map((x) => `<option value="${esc(x.name)}">${esc(x.primary_group || "")}</option>`).join("");
        if (r.items.some((x) => x.name === other.value)) { st.suspense = other.value; remember(); render(); $("#suspOther")?.focus(); }
      }, 250);
    }
    $$("[data-rm]").forEach((a) => a.onclick = (e) => { e.preventDefault(); st.files.splice(+a.dataset.rm, 1); reparse(); });
    const drop = $("#drop");
    if (drop) {
      $("#fi").onchange = (e) => { st.files.push(...e.target.files); reparse(); };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); st.files.push(...e.dataTransfer.files); reparse(); };
    }
    wireMapping();
    $("#go").onclick = save;
  };
  const remember = () => saveJSON("it_bankpick_" + cid, { bank: st.bank, suspense: st.suspense });

  function resultHtml() {
    const p = st.parsed;
    if (st.busy) return `<div class="card"><span class="spin"></span> ${esc(st.busy)}</div>`;
    if (!p) return "";
    if (p.error && !p.rows.length && !p.table) return `<div class="alert bad">${esc(p.error)}</div>`;
    if (!p.rows.length) return mappingHtml();
    const bad = p.rows.filter((r) => r.ok === false).length, checked = p.rows.filter((r) => r.ok != null).length;
    const tin = p.rows.reduce((s, r) => s + r.credit, 0), tout = p.rows.reduce((s, r) => s + r.debit, 0);
    const dates = p.rows.map((r) => r.date).sort();
    return `<div class="card" style="margin-top:10px">
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:baseline"><b>${plural(p.rows.length, "transaction")}</b>
        <span class="muted">${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}</span>
        <span class="good">In ${money(tin)}</span><span>Out ${money(tout)}</span>
        ${checked ? (bad ? `<span class="bad">⚠ ${bad} of ${checked} don't match the running balance</span>` : `<span class="good">✓ Every entry matches the running balance</span>`) : `<span class="muted">No balance column — totals can't be cross-checked</span>`}
        ${p.counted ? `<span class="good">✓ Same count as the bank's</span>` : ""}
        ${p.mapped ? `<button class="btn sm" id="remap">Change columns</button>` : ""}</div>
      ${p.opening != null || p.closing != null ? `<div class="muted small" style="margin-top:6px">${p.opening != null ? `Opening balance ${money(p.opening)}` : ""}${p.opening != null && p.closing != null ? " → " : ""}${p.closing != null ? `closing balance ${money(p.closing)}` : ""}</div>` : ""}
      ${(p.warnings || []).map((w) => `<div class="alert warn" style="margin-top:8px">⚠ ${esc(w)} Check that every page of the statement was uploaded.</div>`).join("")}
      ${bad ? `<p class="muted small" style="margin:8px 0 0">Entries that don't match are marked on the next screen — usually a page that was missed or a column read wrongly. You can still save and leave them out.</p>` : ""}
      <table class="grid" style="margin-top:10px"><thead><tr><th>Date</th><th>Narration</th><th class="num">Out</th><th class="num">In</th><th class="num">Balance</th></tr></thead><tbody>
      ${p.rows.slice(0, 6).map((r) => `<tr class="${r.ok === false ? "badrow" : ""}"><td class="mono">${fmtDate(r.date)}</td><td><div class="ellipsis" style="max-width:420px">${esc(r.narration)}</div>${r.ref ? `<div class="muted small">Ref ${esc(r.ref)}</div>` : ""}</td>
        <td class="num">${r.debit ? money(r.debit) : ""}</td><td class="num good">${r.credit ? money(r.credit) : ""}</td><td class="num muted">${r.balance == null ? "" : money(r.balance)}</td></tr>`).join("")}
      ${p.rows.length > 6 ? `<tr><td colspan="5" class="muted small">…and ${p.rows.length - 6} more</td></tr>` : ""}</tbody></table></div>`;
  }

  // ------------------------------------------------ the columns couldn't be found: let the person say which is which
  function mappingHtml() {
    const t = st.parsed.table;
    if (!t || !t.length) return `<div class="alert bad">${esc(st.parsed.error || "No transactions found")}</div>`;
    const cols = Math.min(12, Math.max(...t.slice(0, 40).map((r) => r.length)));
    const m = st.mapping ||= { row: guessHeaderRow(t), map: {} };
    const rows = t.slice(0, 40);
    return `<div class="alert warn" style="margin-top:10px"><b>Which column is which?</b> The headings of this statement weren't recognised. Pick the heading row
      (click it), then say what each column holds. This is remembered for <b>${esc(st.bank)}</b>.</div>
      <div class="mapwrap"><table class="grid map"><thead><tr><th></th>${Array.from({ length: cols }, (_, j) => `<th><select class="in sm" data-col="${j}">
        ${BANK_FIELDS.map(([k, lbl]) => `<option value="${k}" ${Object.entries(m.map).some(([f, idx]) => f === k && idx === j) ? "selected" : ""}>${lbl}</option>`).join("")}</select></th>`).join("")}</tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="click ${i === m.row ? "sel" : ""}" data-hrow="${i}"><td class="muted small">${i === m.row ? "headings" : i + 1}</td>${Array.from({ length: cols }, (_, j) => `<td class="small"><div class="ellipsis" style="max-width:180px">${esc(r[j] || "")}</div></td>`).join("")}</tr>`).join("")}
      </tbody></table></div>
      <button class="btn primary" id="applyMap" style="margin-top:8px">Read with these columns</button>`;
  }
  function guessHeaderRow(t) {
    let best = 0, score = -1;
    t.slice(0, 40).forEach((r, i) => { const s = r.filter((x) => /[a-z]{3,}/i.test(x || "") && !/\d{2}/.test(x || "")).length; if (s > score) { score = s; best = i; } });
    return best;
  }
  function wireMapping() {
    $("#remap")?.addEventListener("click", () => { st.parsed = { ...st.parsed, rows: [] }; render(); });
    $$("[data-hrow]").forEach((tr) => tr.onclick = () => { st.mapping.row = +tr.dataset.hrow; render(); });
    $$("[data-col]").forEach((sel) => sel.onchange = () => {
      const j = +sel.dataset.col;
      for (const [f, idx] of Object.entries(st.mapping.map)) if (idx === j || f === sel.value) delete st.mapping.map[f];
      if (sel.value) st.mapping.map[sel.value] = j;
      render();
    });
    $("#applyMap")?.addEventListener("click", async () => {
      const BP = await BankLib();
      const m = st.mapping.map;
      if (m.date == null || (m.amount == null && m.debit == null && m.credit == null)) return toast("Mark at least the Date column and the amount column(s)", true);
      const t = st.parsed.table;
      const r = BP.parseTable(t, { row: st.mapping.row, map: m });
      if (!r.rows.length) return toast("No transactions found with these columns — check the heading row and the columns", true);
      const c2 = BP.checkBalances(r.rows, r.opening, r.closing);
      saveJSON(bankMapKey(cid, st.bank), { sig: t[st.mapping.row].map((x) => String(x || "").trim().toLowerCase()).join("|"), map: m });
      st.parsed = { ...st.parsed, rows: c2.rows, opening: r.opening, closing: r.closing, mapped: true, warnings: [], counted: false };
      render();
    });
  }

  // ------------------------------------------------ read the files here (no AI)
  async function reparse() {
    st.parsed = null; st.mapping = null;
    if (!st.files.length) return render();
    const BP = await BankLib();
    st.busy = "Reading…"; render();
    const say = (t) => { st.busy = t; const r = $("#result"); if (r) r.innerHTML = resultHtml(); };
    try {
      let rows = [], opening = null, closing = null, table = [], source = "excel", errors = [], warnings = [], counted = 0;
      // the bank's own count / closing balance, from each file
      const took = (f, r) => { closing = r.closing ?? closing; for (const w of r.warnings || []) warnings.push(st.files.length > 1 ? `${f.name}: ${w}` : w); if (r.counts && !(r.warnings || []).length) counted++; };
      for (const f of st.files) {
        const k = Ingest.kind(f);
        if (k === "xlsx" || k === "csv" || k === "xls") {
          say(`Reading ${f.name}…`);
          const text = await Ingest.sheet(f);
          const t = text.split("\n").map((x) => x.split("\t"));
          const r = BP.fromSheetText(text);
          if (r.rows.length) { rows.push(...r.rows); if (opening == null) opening = r.opening; took(f, r); }
          else { table.push(...t); errors.push(`${f.name}: ${r.error || "the columns weren't recognised"}`); }
        } else if (k === "pdf") {
          source = "pdf";
          let pages;
          for (;;) {
            try { pages = await Ingest.pdfBank(f, (i, n) => say(`Opening ${f.name} — page ${i} of ${n}`), st.passwords[f.name]); break; }
            catch (e) {
              if (!e.password) throw e;
              const pw = prompt(`${e.message}. Enter the PDF password (banks often use your customer ID or date of birth):`);
              if (!pw) throw new Error(`${f.name} needs its password to be read`);
              st.passwords[f.name] = pw;
            }
          }
          if (!pages.some((p) => p.hasText)) { errors.push(`${f.name} is a scanned image — download the statement from net banking as PDF or Excel instead (scans can't be read without AI)`); continue; }
          const r = BP.fromPdfPages(pages.filter((p) => p.hasText));
          if (r.rows.length) { rows.push(...r.rows); if (opening == null) opening = r.opening; took(f, r); }
          else {
            // columns not found: offer the text lines as a table to map by hand
            for (const p of pages) for (const line of BP.pageText(p.items).split("\n")) table.push(line.split(/\s{3,}/));
            errors.push(`${f.name}: ${r.error || "the columns weren't recognised"}`);
          }
        } else errors.push(`${f.name}: use Excel, CSV or PDF`);
      }
      // a layout mapped by hand before for this bank account
      const saved = loadJSON(bankMapKey(cid, st.bank));
      if (!rows.length && table.length && saved) {
        const hr = table.findIndex((r) => r.map((x) => String(x || "").trim().toLowerCase()).join("|") === saved.sig);
        if (hr >= 0) { const r = BP.parseTable(table, { row: hr, map: saved.map }); if (r.rows.length) { rows = r.rows; opening = r.opening; closing = r.closing; } }
      }
      const checked = rows.length ? BP.checkBalances(rows, opening, closing) : { rows: [] };
      st.parsed = { rows: checked.rows, opening, closing, source, table: rows.length ? null : table, error: errors.join(" · "), warnings,
        counted: counted && counted === st.files.length };
    } catch (e) { st.parsed = { rows: [], error: e.message }; }
    st.busy = false;
    render();
  }

  async function save() {
    const p = st.parsed;
    if (st.busy || !p?.rows.length || !st.bank || !st.suspense) return;
    st.busy = "Saving…"; render();
    let sid = null;
    try {
      const name = st.files.map((f) => f.name).join(", ").slice(0, 120);
      sid = (await api(`/companies/${cid}/bank`, { body: { bank_ledger: st.bank, suspense_ledger: st.suspense, filename: name, source: p.source, opening: p.opening } })).id;
      for (let i = 0; i < p.rows.length; i += 500) await api(`/bank/${sid}/rows`, { body: { rows: p.rows.slice(i, i + 500), part: Math.floor(i / 500) } });
      await api(`/bank/${sid}/start`, { body: {} });
      ME = await api("/me", { quiet: true }).catch(() => ME);
      location.hash = `#/s/${sid}`;
    } catch (e) {
      toast(e.message, true);
      if (sid) api(`/bank/${sid}`, { method: "DELETE" }).catch(() => {});
      st.busy = false; render();
    }
  }

  keymap.Escape = () => location.hash = `#/c/${cid}/bank`;
  keymap.enter = () => save();
  render();
}

// ---------------------------------------------------------------- statement
const BANK_FILTERS = [
  ["ready", "To post", (l) => l.status === "ready" || l.status === "failed"],
  ["sent", "In Tally", (l) => l.status === "queued" || l.status === "synced"],
  ["duplicate", "Posted earlier", (l) => l.status === "duplicate"],
  ["ignored", "Left out", (l) => l.status === "ignored"],
  ["all", "All", () => true],
];
const BANK_UI = { filter: null, checked: new Set(), sid: null };

async function viewStatement(sid) {
  const s = await api(`/bank/${sid}`);
  const c = await api(`/companies/${s.company_id}`);
  CURRENT.company = c;
  if (BANK_UI.sid !== sid) Object.assign(BANK_UI, { filter: null, checked: new Set(), sid });
  const lines = s.lines;
  const count = Object.fromEntries(BANK_FILTERS.map(([k, , f]) => [k, lines.filter(f).length]));
  if (!BANK_UI.filter) BANK_UI.filter = count.ready ? "ready" : "all";
  const fdef = BANK_FILTERS.find((f) => f[0] === BANK_UI.filter) || BANK_FILTERS[4];
  const vis = lines.filter(fdef[2]);
  for (const id of [...BANK_UI.checked]) if (!vis.some((l) => l.id === id)) BANK_UI.checked.delete(id);
  const canPost = !!ME.licence?.can_post;
  const bad = lines.filter((l) => l.check_ok === 0).length;
  const help = tallyHelp(c);
  const stCls = { ready: "", synced: "good", queued: "warn", duplicate: "muted", ignored: "muted", failed: "bad" };

  app().innerHTML = topBar([[c.name, `#/c/${c.id}/bank`], [s.name]], c) + `<div class="bar">
      <span class="status">${esc(s.bank_ledger)} → <b>${esc(s.suspense_ledger)}</b> · ${s.period_from ? `${fmtDate(s.period_from)} – ${fmtDate(s.period_to)}` : ""} · in ${money(s.totals.in)} · out ${money(s.totals.out)}</span>
      <div class="spacer"></div><a class="btn" href="#/br/${sid}">Reconcile against Tally</a> <a class="btn" href="#/c/${c.id}/bank">Back <kbd>Esc</kbd></a>
      ${featureOn("delete_data") ? `<button class="btn danger" id="del" title="Delete this statement from the app (entries in Tally stay)">🗑</button>` : ""}
      <button class="btn primary" id="post" ${count.ready && canPost ? "" : "disabled"} ${canPost ? "" : 'title="Posting to Tally is not allowed for your account"'}>Post ${BANK_UI.checked.size ? `${BANK_UI.checked.size} selected` : count.ready ? `all ${count.ready}` : ""} to Tally <kbd>P</kbd></button></div>
    <div class="page wide">
      ${s.stage === "error" ? `<div class="alert bad">${esc(s.error || "")}</div>` : ""}
      ${!canPost ? `<div class="alert warn" style="margin-bottom:10px">Posting to Tally is not allowed for your account. Ask the admin to allow it.</div>` : help && (count.ready || s.jobs.pending) ? `<div class="alert warn" style="margin-bottom:10px">${help}</div>` : ""}
      ${bad ? `<div class="alert warn" style="margin-bottom:10px">⚠ ${plural(bad, "entry", "entries")} ${bad === 1 ? "doesn't" : "don't"} match the running balance (marked below). Check them against the statement; leave out any that are wrong.</div>` : ""}
      <div class="filters" style="padding:0 0 10px;border:0;flex-wrap:wrap;gap:8px"><div class="seg" id="flt">${BANK_FILTERS.map(([k, lbl]) => `<button data-f="${k}" class="${BANK_UI.filter === k ? "on" : ""}">${lbl} <span class="c">${count[k]}</span></button>`).join("")}</div>
        <div class="spacer"></div>
        <label class="muted small">Suspense ledger <select class="in sm" id="susp" style="width:auto"><option>${esc(s.suspense_ledger)}</option></select></label>
        ${BANK_UI.filter === "ignored" || BANK_UI.filter === "duplicate" ? `<button class="btn sm" id="back" ${BANK_UI.checked.size ? "" : "disabled"}>Post these after all</button>` : `<button class="btn sm" id="leave" ${BANK_UI.checked.size ? "" : "disabled"}>Leave out <kbd>L</kbd></button>`}</div>
      ${vis.length ? `<table class="grid"><thead><tr><th style="width:28px"><input type="checkbox" id="all" aria-label="Select all"></th><th>Date</th><th>Narration in Tally</th><th class="num">Out</th><th class="num">In</th><th class="num">Balance</th><th>Voucher</th><th>Status</th></tr></thead><tbody>
      ${vis.map((l) => `<tr class="${l.check_ok === 0 ? "badrow" : ""}"><td><input type="checkbox" data-ck="${l.id}" ${BANK_UI.checked.has(l.id) ? "checked" : ""} ${["synced", "queued"].includes(l.status) ? "disabled" : ""}></td>
        <td class="mono" style="white-space:nowrap">${fmtDate(l.date)}</td>
        <td><div class="ellipsis" style="max-width:520px" title="${esc(l.tally_narration)}">${esc(l.tally_narration)}</div></td>
        <td class="num">${l.debit ? money(l.debit) : ""}</td><td class="num good">${l.credit ? money(l.credit) : ""}</td>
        <td class="num muted">${l.balance == null ? "" : money(l.balance)}${l.check_ok === 0 ? ` <span class="bad" title="Doesn't match the running balance">⚠</span>` : ""}</td>
        <td class="small">${esc(l.vtype)}</td>
        <td class="${stCls[l.status] || ""}">${esc(l.state)}${l.status === "failed" ? `<div class="small">${esc(l.sync_error || "")}</div>` : ""}${l.status === "duplicate" && l.note ? `<div class="muted small">${esc(l.note)}</div>` : ""}</td></tr>`).join("")}
      </tbody></table>` : `<div class="card empty">Nothing here.</div>`}
    </div>`;
  wireTop(c);
  // suspense ledgers to choose from (only for entries not yet posted)
  api(`/companies/${c.id}/masters?kind=ledger&groups=${encodeURIComponent("Suspense A/c")}`, { quiet: true }).then((r) => {
    const sel = $("#susp"); if (!sel) return;
    const names = [...new Set([s.suspense_ledger, ...r.items.map((x) => x.name)])];
    sel.innerHTML = names.map((n) => `<option ${n === s.suspense_ledger ? "selected" : ""}>${esc(n)}</option>`).join("");
    sel.onchange = async () => { await act(() => api(`/bank/${sid}/suspense`, { body: { suspense_ledger: sel.value } }), `Entries not yet posted go to ${sel.value}`); refresh(); };
  }).catch(() => {});
  $$("#flt [data-f]").forEach((b) => b.onclick = () => { BANK_UI.filter = b.dataset.f; BANK_UI.checked.clear(); refresh(); });
  $$("[data-ck]").forEach((cb) => cb.onchange = () => { cb.checked ? BANK_UI.checked.add(cb.dataset.ck) : BANK_UI.checked.delete(cb.dataset.ck); refresh(); });
  $("#all")?.addEventListener("change", (e) => { vis.filter((l) => !["synced", "queued"].includes(l.status)).forEach((l) => e.target.checked ? BANK_UI.checked.add(l.id) : BANK_UI.checked.delete(l.id)); refresh(); });
  const mark = async (status, msg) => { if (!BANK_UI.checked.size) return; await act(() => api(`/bank/${sid}/mark`, { body: { ids: [...BANK_UI.checked], status } }), msg); BANK_UI.checked.clear(); refresh(); };
  $("#leave")?.addEventListener("click", () => mark("ignored", "Left out — they won't be posted"));
  $("#back")?.addEventListener("click", () => mark("ready", "They'll be posted with the rest"));
  keymap.l = () => mark("ignored", "Left out — they won't be posted");
  const post = async () => {
    if (!count.ready || !canPost) return;
    const ids = [...BANK_UI.checked].filter((id) => lines.find((l) => l.id === id && (l.status === "ready" || l.status === "failed")));
    const r = await act(() => api(`/bank/${sid}/push`, { body: ids.length ? { ids } : {} }));
    toast(`${plural(r.queued, "entry", "entries")} sent to Tally`);
    BANK_UI.checked.clear(); BANK_UI.filter = "sent"; refresh();
  };
  $("#post").onclick = post; keymap.p = post;
  if ($("#del")) $("#del").onclick = async () => { if (confirm("Delete this statement from the app? Entries already posted stay in Tally.")) { await api(`/bank/${sid}`, { method: "DELETE" }); location.hash = `#/c/${c.id}/bank`; } };
  keymap.Escape = () => location.hash = `#/c/${c.id}/bank`;
  if (s.lines.some((l) => l.status === "queued")) every(2500, refresh);
}
