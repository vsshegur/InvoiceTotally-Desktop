/* Bank statements: upload, reading progress, matching (runs here in the browser) and review. */
"use strict";

const BankLib = (() => {
  let mods = null;
  return async () => (mods ||= Promise.all([import("/bankparse.js"), import("/bankmatch.js")]).then(([parse, match]) => ({ parse, match })));
})();

const BANK_STAGE = { uploading: "Uploading", reading: "Reading the statement…", checking: "Checking balances…", review: "", error: "Could not read" };

// ---------------------------------------------------------------- company tab: list
async function companyBank(c, el) {
  const rows = await api(`/companies/${c.id}/bank`);
  el.innerHTML = rows.length ? `<table class="grid"><thead><tr><th>Statement</th><th>Bank ledger</th><th>Period</th><th class="num">Entries</th><th>Progress</th></tr></thead><tbody>
    ${rows.map((s) => {
      const n = s.counts || {};
      const need = (n.review || 0) + (n.new || 0) + (n.failed || 0);
      const progress = s.stage !== "review" ? `<span class="${s.stage === "error" ? "bad" : "warn"}">${BANK_STAGE[s.stage] || s.stage} ${s.stage === "error" ? esc(s.error || "") : ""}</span>`
        : `<span class="${n.synced === s.lines ? "good" : ""}">${n.synced || 0} of ${s.lines - (n.in_tally || 0) - (n.ignored || 0)} in Tally</span>${need ? ` · <span class="warn">${need} need a look</span>` : ""}${n.in_tally ? ` · <span class="muted">${n.in_tally} already in Tally</span>` : ""}${s.bad ? ` · <span class="bad">${s.bad} don't add up</span>` : ""}`;
      return `<tr class="click" data-href="#/s/${s.id}"><td><b>${esc(s.name)}</b><div class="muted" style="font-size:12px">${ago(s.created_at)}</div></td><td>${esc(s.bank_ledger)}</td>
        <td class="muted">${s.period_from ? `${fmtDate(s.period_from)} – ${fmtDate(s.period_to)}` : "—"}</td><td class="num">${s.lines}</td><td>${progress}</td></tr>`;
    }).join("")}</tbody></table>`
    : `<div class="card empty" style="text-align:left;max-width:720px"><b>Match your bank statement with Tally</b>
      <p class="muted" style="margin:8px 0 12px">Upload the statement as PDF, Excel or CSV — any bank, including co-operative banks; scanned pages and photos work too. Every entry is read, checked against the running balance, matched to the party and to the pending invoice named in the narration, and posted as a Receipt, Payment or Contra after your review. Entries already in Tally are recognised and skipped.</p>
      <a class="btn primary" href="#/c/${c.id}/bank/upload">⇪ Upload bank statement</a></div>`;
  $$("tr[data-href]", el).forEach((tr) => tr.onclick = () => location.hash = tr.dataset.href);
  every(5000, () => { if (rows.some((s) => s.stage !== "review" && s.stage !== "error")) refresh(); });
}

// ---------------------------------------------------------------- upload
async function viewBankUpload(cid) {
  const [c, banks] = await Promise.all([api(`/companies/${cid}`), api(`/companies/${cid}/masters?kind=ledger&groups=${encodeURIComponent("Bank Accounts|Bank OD A/c")}`)]);
  const items = banks.items || [];
  let saved = ""; try { saved = localStorage.getItem("it_bank_" + cid) || ""; } catch {}
  const st = { bank: items.some((b) => b.name === saved) ? saved : items.length === 1 ? items[0].name : "", files: [] };
  const render = () => {
    app().innerHTML = topBar([[c.name, `#/c/${cid}/bank`], ["Upload bank statement"]], c) + `<div class="bar"><span class="status"></span><div class="spacer"></div>
      <a class="btn" href="#/c/${cid}/bank">Back <kbd>Esc</kbd></a><button class="btn primary" id="go" ${st.bank && st.files.length ? "" : "disabled"}>Read statement <kbd>↵</kbd></button></div>
    <div class="page wiz"><div class="eyebrow">Bank statement</div><h1>${esc(c.name)}</h1>
      <div class="wstep active"><div class="head"><span class="n">1</span><b>Which bank account is it?</b></div>
        ${items.length ? `<div class="choices">${items.map((b) => `<div class="choice ${st.bank === b.name ? "on" : ""}" data-bank="${esc(b.name)}"><div><div><b>${esc(b.name)}</b></div><div class="sub">${esc(b.parent || "")}</div></div>${st.bank === b.name ? "✓" : ""}</div>`).join("")}</div>`
          : `<div class="alert warn">No bank ledgers yet. Press <b>Import masters</b> (top right) so your Tally bank ledgers appear here.</div>`}</div>
      <div class="wstep ${st.bank ? "active" : ""}"><div class="head"><span class="n">2</span><b>The statement</b></div>${st.bank ? `
        <label class="drop" id="drop"><input type="file" id="fi" multiple hidden accept=".pdf,.xlsx,.xlsm,.csv,.png,.jpg,.jpeg,image/*">
          <div style="font-size:15px;color:var(--text)">Drop the statement here or click to choose</div>
          <div>PDF (downloaded or scanned), Excel / CSV export, or photos of the pages. Several files of the same account are read as one statement.</div></label>
        <div class="files">${st.files.map((f, i) => `<div><span>${esc(f.name)}</span><span class="muted">${(f.size / 1024).toFixed(0)} KB <a href="#" data-rm="${i}">✕</a></span></div>`).join("")}</div>` : ""}</div>
    </div>`;
    wireTop(c);
    $$("[data-bank]").forEach((el) => el.onclick = () => { st.bank = el.dataset.bank; try { localStorage.setItem("it_bank_" + cid, st.bank); } catch {} render(); });
    $$("[data-rm]").forEach((a) => a.onclick = (e) => { e.preventDefault(); st.files.splice(+a.dataset.rm, 1); render(); });
    const drop = $("#drop");
    if (drop) {
      $("#fi").onchange = (e) => { st.files.push(...e.target.files); render(); };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); st.files.push(...e.dataTransfer.files); render(); };
    }
    $("#go").onclick = go;
  };
  let busy = false;
  const go = async () => {
    if (busy || !st.bank || !st.files.length) return;
    busy = true;
    const btn = $("#go"), status = $(".bar .status");
    btn.disabled = true; btn.textContent = "Reading…";
    const say = (t) => { status.textContent = t; };
    let sid = null;
    try {
      const { parse: BP } = await BankLib();
      // Read everything here first: clean Excel/PDF text needs no AI at all.
      let rows = [], opening = null, aiPages = [], source = "pdf";
      const allPdfPages = [];
      for (const f of st.files) {
        const k = Ingest.kind(f);
        if (k === "xlsx" || k === "csv" || k === "xls") {
          source = "excel";
          say(`Reading ${f.name}…`);
          const text = await Ingest.sheet(f);
          const r = BP.fromSheetText(text);
          if (r.rows.length) { rows.push(...r.rows); if (opening == null) opening = r.opening; }
          else { const lines = text.split("\n"); for (let i = 0; i < lines.length; i += 70) aiPages.push({ kind: "text", content: lines.slice(i, i + 70).join("\n").replace(/\t/g, "   ") }); }
        } else if (k === "pdf") {
          const pages = await Ingest.pdfBank(f, (i, n) => say(`Opening ${f.name} — page ${i} of ${n}`));
          allPdfPages.push(...pages);
        } else {
          say(`Preparing ${f.name}…`);
          source = "scan";
          aiPages.push({ kind: "image", content: await Ingest.image(f) });
        }
      }
      if (allPdfPages.length) {
        const r = allPdfPages.every((p) => p.hasText) ? BP.fromPdfPages(allPdfPages) : { ok: false };
        if (r.ok) { rows.push(...r.rows); if (opening == null) opening = r.opening; }
        else {
          if (allPdfPages.some((p) => !p.hasText)) source = "scan";
          for (const p of allPdfPages) aiPages.push(p.hasText ? { kind: "text", content: BP.pageText(p.items) } : { kind: "image", content: p.image });
        }
      }
      if (!rows.length && !aiPages.length) throw new Error("No transactions were found in these files");
      const name = st.files.map((f) => f.name).join(", ").slice(0, 120);
      sid = (await api(`/companies/${cid}/bank`, { body: { bank_ledger: st.bank, filename: name, source, opening } })).id;
      for (let i = 0; i < rows.length; i += 400) {
        say(`Saving entries ${i + 1}–${Math.min(rows.length, i + 400)} of ${rows.length}…`);
        await api(`/bank/${sid}/rows`, { body: { rows: rows.slice(i, i + 400), part: Math.floor(i / 400) } });
      }
      for (const [i, p] of aiPages.entries()) {
        say(`Uploading page ${i + 1} of ${aiPages.length}…`);
        for (let attempt = 0; ; attempt++) {
          try { await api(`/bank/${sid}/pages`, { body: { idx: i, ...p } }); break; }
          catch (e) { if (attempt >= 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
        }
      }
      await api(`/bank/${sid}/start`, { body: {} });
      location.hash = `#/s/${sid}`;
    } catch (e) {
      toast(e.message, true);
      if (sid) api(`/bank/${sid}`, { method: "DELETE" }).catch(() => {});
      busy = false; render();
    }
  };
  keymap.Escape = () => location.hash = `#/c/${cid}/bank`;
  keymap.enter = () => go();
  render();
}

// ---------------------------------------------------------------- statement
const BANK_DRIVERS = new Map();
function driveStatement(sid) {
  if (BANK_DRIVERS.has(sid)) return;
  const st = { stop: false };
  BANK_DRIVERS.set(sid, st);
  (async () => {
    try {
      for (let idle = 0; !st.stop && idle < 3;) {
        const r = await api(`/bank/${sid}/work`, { body: {}, quiet: true }).catch(() => ({ did: false }));
        if (r.stage === "review" || r.stage === "error") break;
        if (!r.did) { idle++; await new Promise((res) => setTimeout(res, 4000)); } else idle = 0;
      }
    } finally { BANK_DRIVERS.delete(sid); refresh(); }
  })();
}

const BANK_FILTERS = [
  ["need", "Needs a look", (l) => ["review", "new", "failed"].includes(l.status) || l.check_ok === 0],
  ["ready", "Ready", (l) => l.status === "ready" && l.check_ok !== 0],
  ["in_tally", "Already in Tally", (l) => l.status === "in_tally"],
  ["sent", "Posted", (l) => l.status === "queued" || l.status === "synced"],
  ["ignored", "Ignored", (l) => l.status === "ignored"],
  ["all", "All", () => true],
];
const BANK_UI = { filter: null, sel: 0, checked: new Set(), sid: null };

async function viewStatement(sid) {
  let s = await api(`/bank/${sid}`);
  const c = await api(`/companies/${s.company_id}`);
  CURRENT.company = c;
  if (BANK_UI.sid !== sid) Object.assign(BANK_UI, { filter: null, sel: 0, checked: new Set(), sid });
  const head = topBar([[c.name, `#/c/${c.id}/bank`], [s.name]], c);

  if (s.stage !== "review" && s.stage !== "error") {
    const done = s.pages.filter((p) => p.status === "done").length;
    app().innerHTML = head + `<div class="page"><h1>${esc(s.name)}</h1>
      <div class="card" style="max-width:640px"><div style="display:flex;gap:10px;align-items:center"><span class="spin"></span><b>${BANK_STAGE[s.stage] || "Working…"}</b></div>
      <p class="muted">${s.pages.length ? `Page ${Math.min(done + 1, s.pages.length)} of ${s.pages.length} — every row is checked against the running balance; a page that doesn't add up is read again carefully.` : "Checking the running balance…"}</p>
      ${s.pages.some((p) => p.rechecked) ? `<p class="muted">Re-reading ${s.pages.filter((p) => p.rechecked && p.status !== "done").length} page(s) that didn't add up.</p>` : ""}
      <p class="muted" style="font-size:12.5px">You can close this page — it carries on in the background.</p></div></div>`;
    wireTop(c);
    driveStatement(sid);
    every(3000, refresh);
    return;
  }

  // Match here in the browser when there's something new to match with.
  const ctx = await api(`/bank/${sid}/context`);
  const needMatch = s.lines.some((l) => l.status === "new") || (ctx.bills_at && ctx.bills_at > (s.matched_at || 0)) || (ctx.entries_at && ctx.entries_at > (s.matched_at || 0));
  const { match: BM } = await BankLib();
  const mctx = BM.buildContext({ ...ctx, bankLedger: s.bank_ledger });
  if (needMatch) {
    const m = BM.matchAll(s.lines, mctx);
    if (m.size) await api(`/bank/${sid}/matches`, { body: { results: [...m].map(([id, r]) => ({ id, ...r })) }, quiet: true });
    else await api(`/bank/${sid}/matches`, { body: { results: [] }, quiet: true });
    s = await api(`/bank/${sid}`, { quiet: true });
  }
  const lines = s.lines;
  const count = Object.fromEntries(BANK_FILTERS.map(([k, , f]) => [k, lines.filter(f).length]));
  if (!BANK_UI.filter) BANK_UI.filter = count.need ? "need" : count.ready ? "ready" : "all";
  const fdef = BANK_FILTERS.find((f) => f[0] === BANK_UI.filter) || BANK_FILTERS[5];
  const vis = lines.filter(fdef[2]);
  BANK_UI.sel = Math.min(BANK_UI.sel, Math.max(0, vis.length - 1));
  for (const id of [...BANK_UI.checked]) if (!vis.some((l) => l.id === id)) BANK_UI.checked.delete(id);
  const readyN = lines.filter((l) => (l.status === "ready" || l.status === "failed") && l.ledger && l.check_ok !== 0).length;
  const tallyJobs = (ctx.jobs || []).filter((j) => j.status === "pending" || j.status === "sent");
  const failedJob = (ctx.jobs || []).find((j) => j.status === "failed");
  const balanceNote = s.checked ? (s.bad ? `<span class="bad">⚠ ${s.bad} of ${s.checked} entries don't match the running balance</span>` : `<span class="good">✓ All ${s.checked} entries match the running balance</span>`) : `<span class="muted">No balance column — amounts can't be cross-checked</span>`;
  const tallyNote = tallyJobs.length ? `<span class="warn">Reading pending invoices from Tally… ${c.bridge_online ? "" : "(waiting for TallyBridge)"}</span>`
    : ctx.bills_at ? `<span class="muted">Pending invoices from Tally ${ago(ctx.bills_at)}</span>` : failedJob ? `<span class="bad">Couldn't read pending invoices from Tally: ${esc(/unknown|does not know|KeyError|export_b/i.test(failedJob.result || "") ? "update TallyBridge on the PC to 2.7 or newer" : failedJob.result || "")}</span>` : `<span class="muted">No pending invoices read from Tally yet</span>`;

  const row = (l, i) => {
    const amtIn = l.credit > 0;
    const stIcon = { ready: "good", synced: "good", queued: "warn", in_tally: "muted", ignored: "muted", failed: "bad" }[l.status] || "warn";
    return `<tr class="click ${i === BANK_UI.sel ? "sel" : ""}" data-i="${i}">
      <td style="width:28px" data-stop><input type="checkbox" data-ck="${l.id}" ${BANK_UI.checked.has(l.id) ? "checked" : ""} ${["synced", "queued"].includes(l.status) ? "disabled" : ""}></td>
      <td class="mono" style="white-space:nowrap">${fmtDate(l.date)}</td>
      <td><div style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.narration)}">${esc(l.narration)}</div>
        <div class="muted" style="font-size:12px">${l.ledger ? `→ <b>${esc(l.ledger)}</b> · ${esc(l.vtype || "")}${l.bills.length ? ` · ${l.bills.map((b) => esc(b.name)).join(", ")}` : ""}` : l.create ? `→ create <b>${esc(l.create.name)}</b>` : `<span class="warn">No ledger yet</span>`}</div></td>
      <td class="num">${amtIn ? "" : money(l.debit)}</td><td class="num good">${amtIn ? money(l.credit) : ""}</td>
      <td><span class="${stIcon}">${esc(l.check_ok === 0 ? "Amount doesn't add up" : l.state)}</span>${l.status === "failed" ? `<div class="bad" style="font-size:12px">${esc(l.sync_error || "")}</div>` : ""}</td></tr>`;
  };

  const panelFor = (l) => {
    if (!l) return { html: `<div class="empty">Select an entry</div>` };
    const amt = l.credit || l.debit, amtIn = l.credit > 0;
    const locked = ["queued", "synced"].includes(l.status);
    const side = amtIn ? "receivable" : "payable";
    let pick = l.ledger || "", vtype = l.vtype || (amtIn ? "Receipt" : "Payment");
    let bills = new Map((l.bills || []).map((b) => [b.name, b.amount]));
    const groups = amtIn ? "Sundry Debtors|Sundry Creditors|Indirect Incomes|Direct Incomes|Cash-in-Hand|Bank Accounts|Bank OD A/c|Loans (Liability)|Capital Account"
      : "Sundry Creditors|Sundry Debtors|Indirect Expenses|Direct Expenses|Cash-in-Hand|Bank Accounts|Bank OD A/c|Duties & Taxes|Loans & Advances (Asset)";
    const pk = locked ? null : picker({
      title: "Ledger", placeholder: "Search party / ledger…", selected: pick,
      suggest: async (q) => {
        if (q) return [];
        const r = BM.matchLine({ ...l, method: null }, mctx);
        return r.ledger && r.ledger !== pick ? [{ name: r.ledger, parent: mctx.byName.get(r.ledger)?.primary_group || "", tags: [r.method], score: r.confidence }] : [];
      },
      search: async (q) => (await api(`/companies/${c.id}/masters?kind=ledger&q=${encodeURIComponent(q)}${q ? "" : "&groups=" + encodeURIComponent(groups)}`, { quiet: true })).items,
      render: (it) => `<div><div class="nm">${esc(it.name)}</div><div class="sub">${esc(it.parent || it.primary_group || "")}</div></div><div class="tag">${(it.tags || []).map(esc).join(" · ")}${it.score != null && it._s ? ` ${it.score}%` : ""}</div>`,
      onPick: (it) => { pick = it.name; const g = mctx.byName.get(pick)?.primary_group; vtype = BM.voucherTypeFor(g, amtIn); bills = new Map(); drawBills(); $("#bk-vt").value = vtype; $("#bk-will").innerHTML = willText(); },
      createLabel: (q) => q ? `Create ledger “${esc(q)}”` : "",
      onCreate: (q) => bankCreateLedger(sid, [l.id], q, amtIn),
    });
    const willText = () => pick ? `${esc(vtype)} · <b>${esc(pick)}</b> · ${money(amt)}${bills.size ? ` · against ${[...bills.keys()].map(esc).join(", ")}` : ""}` : "Pick a ledger";
    const drawBills = () => {
      const box = $("#bk-bills");
      if (!box) return;
      const open = (mctx.billsByParty.get(pick) || []).filter((b) => b.side === side);
      box.innerHTML = !pick ? "" : open.length ? `<div class="eyebrow" style="margin-bottom:6px">Pending ${amtIn ? "invoices" : "bills"} of ${esc(pick)}</div>` +
        open.slice(0, 40).map((b) => `<label class="billrow"><input type="checkbox" data-bill="${esc(b.name)}" ${bills.has(b.name) ? "checked" : ""}> <span class="mono">${esc(b.name)}</span>
          <span class="muted">${fmtDate(b.date)}</span><span class="spacer"></span><span>${money(b.amount)}</span></label>`).join("") +
        `<div class="muted" style="font-size:12px;margin-top:6px">${bills.size ? `${money([...bills.values()].reduce((a, x) => a + x, 0))} against invoices` : "Not set against an invoice"} · the rest goes On Account</div>`
        : `<div class="muted" style="font-size:12.5px">${ctx.bills_at ? "No pending invoices for this ledger in Tally." : "Pending invoices haven't been read from Tally yet."}</div>`;
      $$("[data-bill]", box).forEach((cb) => cb.onchange = () => {
        const b = open.find((x) => x.name === cb.dataset.bill);
        if (cb.checked) { const used = [...bills.values()].reduce((a, x) => a + x, 0); bills.set(b.name, Math.max(0, Math.min(b.amount, Math.round((amt - used) * 100) / 100))); }
        else bills.delete(b.name);
        drawBills(); $("#bk-will").innerHTML = willText();
      });
    };
    const html = `<div class="box"><div class="bh"><span class="eyebrow">${amtIn ? "Money in" : "Money out"} · ${fmtDate(l.date)}</span><span class="${amtIn ? "good" : ""}" style="font-weight:700">${money(amt)}</span></div><div class="bb">
        <div style="font-size:14px;word-break:break-word">${esc(l.narration)}</div>
        <div class="kv">${l.ref ? `<div><span>Ref / cheque</span><span class="mono">${esc(l.ref)}</span></div>` : ""}<div><span>Balance after</span><span>${l.balance == null ? "—" : money(l.balance)}</span></div>
          <div><span>Matched by</span><span>${esc(l.method === "manual" ? "You" : l.method || "—")}${l.confidence && l.method !== "manual" ? ` · ${l.confidence}%` : ""}</span></div></div>
        ${l.check_ok === 0 ? `<div class="alert bad" style="margin-top:10px">The running balance says this should be <b>${money(Math.abs((l.expected ?? 0) - (l.balance ?? 0) + (amtIn ? l.credit : -l.debit)) || null)}</b> — the amount or the balance may be misread. Fix it, or confirm it's right.
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><input class="in" id="bk-amt" style="width:140px" value="${amt}"><button type="button" class="btn sm" id="bk-fix">Save amount</button><button type="button" class="btn sm" id="bk-ok">Amount is right</button></div></div>` : ""}
        ${l.status === "in_tally" ? `<div class="alert ok" style="margin-top:10px">${esc(l.method)}. It won't be posted again. <button type="button" class="btn sm" id="bk-notdup">It's a different entry</button></div>` : ""}
        ${l.status === "failed" ? `<div class="alert bad" style="margin-top:10px">Tally said: ${esc(l.sync_error || "")}</div>` : ""}
      </div></div>
      ${locked ? `<div class="alert ok">${l.status === "synced" ? "Posted in Tally ✓" : "Waiting for TallyBridge to post it…"}</div>` : `
      ${pk.html}
      <div class="box"><div class="bb" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="muted">Voucher</label>
        <select class="in" id="bk-vt" style="width:auto">${["Receipt", "Payment", "Contra"].map((v) => `<option ${v === vtype ? "selected" : ""}>${v}</option>`).join("")}</select>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="bk-rem" checked> Remember for “${esc(l.key ? l.key.replace(/^\w+:/, "") : "this narration")}”</label></div>
        <div class="bb" id="bk-bills" style="border-top:1px solid var(--line)"></div></div>
      ${willSet(`<span id="bk-will">${willText()}</span>`, `<button class="btn primary" id="bk-save">Save <kbd>↵</kbd></button>`,
        `<button class="btn" id="bk-ignore" title="Not to be posted (e.g. already entered differently)">${l.status === "ignored" ? "Un-ignore" : "Ignore"} <kbd>I</kbd></button>`)}`}`;
    const wire = () => {
      if (pk) {
        pk.wire();
        drawBills();
        $("#bk-vt").onchange = (e) => { vtype = e.target.value; $("#bk-will").innerHTML = willText(); };
        const save = async () => {
          if (!pick) return toast("Pick a ledger first", true);
          await act(() => api(`/bank/${sid}/lines`, { body: { ids: [l.id], set: { ledger: pick, vtype, bills: [...bills].map(([name, amount]) => ({ name, amount })), remember: $("#bk-rem").checked } } }), "Saved");
          BANK_UI.sel++; refresh();
        };
        $("#bk-save").onclick = save; keymap.enter = save;
        const ign = async () => { await act(() => api(`/bank/${sid}/lines`, { body: { ids: [l.id], set: { status: l.status === "ignored" ? "review" : "ignored" } } })); refresh(); };
        $("#bk-ignore").onclick = ign; keymap.i = ign;
      }
      $("#bk-fix")?.addEventListener("click", async () => {
        const v = +String($("#bk-amt").value).replace(/,/g, "");
        if (!(v > 0)) return toast("Enter the amount", true);
        await act(() => api(`/bank/${sid}/lines`, { body: { ids: [l.id], set: amtIn ? { credit: v } : { debit: v } } }), "Amount saved");
        refresh();
      });
      $("#bk-ok")?.addEventListener("click", async () => { await act(() => api(`/bank/${sid}/lines`, { body: { ids: [l.id], set: { confirm_balance: true } } }), "Confirmed"); refresh(); });
      $("#bk-notdup")?.addEventListener("click", async () => { await act(() => api(`/bank/${sid}/lines`, { body: { ids: [l.id], set: { status: "review" } } })); refresh(); });
    };
    return { html, wire };
  };

  const l = vis[BANK_UI.sel];
  const panel = panelFor(l);
  const nChecked = BANK_UI.checked.size;
  app().innerHTML = head + `<div class="bar"><span class="status">${esc(s.bank_ledger)} · ${s.period_from ? `${fmtDate(s.period_from)} – ${fmtDate(s.period_to)}` : ""}</span><div class="spacer"></div>
      <button class="btn" id="bk-tally" title="Read pending invoices and existing bank entries from Tally again">⟳ Refresh from Tally</button>
      <button class="btn" id="bk-del">Delete</button>
      <button class="btn primary" id="bk-push" ${readyN || nChecked ? "" : "disabled"}>${nChecked ? `Push ${nChecked} selected` : `Push ${readyN} ready`} to Tally <kbd>P</kbd></button></div>
    <div class="bankhead">
      <div><span>Opening</span><b>${s.opening == null ? "—" : money(s.opening)}</b></div><div><span>Money in</span><b class="good">${money(s.totals.credit)}</b></div>
      <div><span>Money out</span><b>${money(s.totals.debit)}</b></div><div><span>Closing</span><b>${s.closing == null ? "—" : money(s.closing)}</b></div>
      <div class="grow">${balanceNote}<br>${tallyNote}${s.error ? `<br><span class="bad">${esc(s.error)}</span> <button class="btn sm" id="bk-retry">Read again</button>` : ""}${s.ai_cost_usd ? `<br><span class="muted">AI reading cost ≈ $${s.ai_cost_usd}</span>` : ""}</div></div>
    <div class="split bank"><div class="left">
      <div class="filters"><div class="seg">${BANK_FILTERS.map(([k, label]) => `<button data-f="${k}" class="${BANK_UI.filter === k ? "on" : ""}">${label} <span class="c">${count[k]}</span></button>`).join("")}</div>
        <div class="spacer"></div>${nChecked ? `<span class="muted">${nChecked} selected</span> <button class="btn sm" id="bk-bulk">Set ledger…</button> <button class="btn sm" id="bk-bulkign">Ignore</button>` : `<span class="muted">Tick entries to change many at once</span>`}</div>
      <div id="rows">${vis.length ? `<table class="grid"><thead><tr><th><input type="checkbox" id="bk-all"></th><th>Date</th><th>Narration</th><th class="num">Out</th><th class="num">In</th><th>Status</th></tr></thead><tbody>${vis.map(row).join("")}</tbody></table>`
        : `<div class="empty">${BANK_UI.filter === "need" ? "Nothing needs a look. ✓" : "Nothing here."}</div>`}</div></div>
      <div class="right" id="panel">${panel.html}</div></div>`;
  wireTop(c);
  panel.wire();
  $$(".seg button[data-f]").forEach((b) => b.onclick = () => { BANK_UI.filter = b.dataset.f; BANK_UI.sel = 0; route(); });
  $$("#rows tr[data-i]").forEach((tr) => tr.onclick = (e) => { if (e.target.closest("[data-stop]")) return; BANK_UI.sel = +tr.dataset.i; route(); });
  $$("[data-ck]").forEach((cb) => cb.onchange = () => { cb.checked ? BANK_UI.checked.add(cb.dataset.ck) : BANK_UI.checked.delete(cb.dataset.ck); route(); });
  $("#bk-all")?.addEventListener("change", (e) => { for (const x of vis) if (!["synced", "queued"].includes(x.status)) e.target.checked ? BANK_UI.checked.add(x.id) : BANK_UI.checked.delete(x.id); route(); });
  keymap.arrowdown = () => { BANK_UI.sel = Math.min(vis.length - 1, BANK_UI.sel + 1); route(); };
  keymap.arrowup = () => { BANK_UI.sel = Math.max(0, BANK_UI.sel - 1); route(); };
  const push = async () => {
    const ids = [...BANK_UI.checked];
    const r = await act(() => api(`/bank/${sid}/push`, { body: { ids } }));
    BANK_UI.checked.clear();
    toast(`${r.pushed} entr${r.pushed === 1 ? "y" : "ies"} sent to TallyBridge${r.skipped.length ? ` · ${r.skipped.length} held back` : ""}`);
    if (r.skipped.length) toast(r.skipped.slice(0, 3).map((x) => `${fmtDate(x.date)}: ${x.why}`).join("\n"), true);
    BANK_UI.filter = "sent"; route();
  };
  $("#bk-push").onclick = push; keymap.p = push;
  $("#bk-tally").onclick = async () => { await act(() => api(`/bank/${sid}/tally`, { body: {} }), c.bridge_online ? "Reading from Tally…" : "Queued — runs when TallyBridge connects"); refresh(); };
  $("#bk-del").onclick = async () => { if (confirm("Delete this statement here? Entries already posted stay in Tally.")) { await api(`/bank/${sid}`, { method: "DELETE" }); location.hash = `#/c/${c.id}/bank`; } };
  $("#bk-retry")?.addEventListener("click", async () => { await act(() => api(`/bank/${sid}/retry`, { body: {} })); refresh(); });
  $("#bk-bulkign")?.addEventListener("click", async () => { await act(() => api(`/bank/${sid}/lines`, { body: { ids: [...BANK_UI.checked], set: { status: "ignored" } } }), "Ignored"); BANK_UI.checked.clear(); route(); });
  $("#bk-bulk")?.addEventListener("click", () => bankBulkLedger(sid, c, [...BANK_UI.checked], lines, mctx, BM));
  // keep it fresh while Tally is being read or entries are being posted
  if (tallyJobs.length || lines.some((x) => x.status === "queued")) every(5000, refresh);
}

function bankBulkLedger(sid, c, ids, lines, mctx, BM) {
  const sel = lines.filter((l) => ids.includes(l.id));
  const anyIn = sel.some((l) => l.credit > 0), anyOut = sel.some((l) => l.debit > 0);
  const bg = modal(`<h2>Set ledger for ${ids.length} entries</h2>
    <div class="field"><label>Ledger</label><input class="in" name="ledger" list="bk-ledgers" required autocomplete="off" placeholder="Start typing…"><datalist id="bk-ledgers"></datalist></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-bottom:12px"><input type="checkbox" name="remember" checked> Remember these narrations for next time</label>
    <p class="muted" style="font-size:12.5px">${anyIn && anyOut ? "Money in becomes Receipts and money out Payments" : anyIn ? "They become Receipts" : "They become Payments"} (Contra for cash and bank ledgers). Pending invoices are not set for bulk changes.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Apply</button></div>`,
    async (d) => {
      const g = mctx.byName.get(d.ledger)?.primary_group;
      if (!mctx.byName.has(d.ledger)) throw new Error(`“${d.ledger}” is not a ledger in Tally`);
      const ins = sel.filter((l) => l.credit > 0).map((l) => l.id), outs = sel.filter((l) => l.debit > 0).map((l) => l.id);
      if (ins.length) await api(`/bank/${sid}/lines`, { body: { ids: ins, set: { ledger: d.ledger, vtype: BM.voucherTypeFor(g, true), bills: [], remember: !!d.remember } } });
      if (outs.length) await api(`/bank/${sid}/lines`, { body: { ids: outs, set: { ledger: d.ledger, vtype: BM.voucherTypeFor(g, false), bills: [], remember: !!d.remember } } });
      BANK_UI.checked.clear(); toast("Saved"); route();
    });
  $("#bk-ledgers", bg).innerHTML = [...mctx.byName.keys()].sort().map((n) => `<option value="${esc(n)}">`).join("");
}

function bankCreateLedger(sid, ids, name, amtIn) {
  const groups = amtIn ? ["Sundry Debtors", "Indirect Incomes", "Direct Incomes", "Loans (Liability)", "Capital Account"] : ["Sundry Creditors", "Indirect Expenses", "Direct Expenses", "Duties & Taxes", "Loans & Advances (Asset)"];
  modal(`<h2>Create ledger in Tally</h2>
    <div class="field"><label>Ledger name</label><input class="in" name="name" value="${esc(name || "")}" required></div>
    <div class="field"><label>Under group</label><select class="in" name="parent">${groups.map((g) => `<option>${g}</option>`).join("")}</select></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-bottom:12px"><input type="checkbox" name="remember" checked> Remember this narration</label>
    <p class="muted" style="font-size:12.5px">TallyBridge creates it in Tally before posting the entry.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create &amp; use</button></div>`,
    async (d) => { await api(`/bank/${sid}/create-ledger`, { body: { ids, name: d.name, parent: d.parent, remember: !!d.remember } }); toast(`Ledger ${d.name} will be created`); route(); });
}
