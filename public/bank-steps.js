/* Bank statement, one transaction at a time: who is it, which of their bills does it settle.
   Nothing is posted from here — each step only saves the reviewed ledger / bill choice on the statement line. */
"use strict";

async function openBankSteps(o) {
  const BP = await import("/bankparse.js");
  const { sid, ledgers, partySugg } = o;
  const meta = new Map(ledgers.map((l) => [l.name.toUpperCase(), l]));
  const isParty = (name) => /^(sundry debtors|sundry creditors)$/i.test(String((meta.get(String(name).toUpperCase()) || {}).primary_group || (meta.get(String(name).toUpperCase()) || {}).parent || "").trim());
  const queue = o.lines.filter((l) => (!o.ids || o.ids.includes(l.id)) && ["ready", "failed"].includes(l.status));
  if (!queue.length) { toast("No transactions waiting for a ledger.", true); return; }
  const billCache = new Map();   // ledger -> { bills, notice }
  const used = new Map();        // "LEDGER|BILL" -> amount already given to it in this session
  const done = [], skipped = [];
  let i = 0;

  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal bs" role="dialog" aria-label="Go through transactions one by one"></div>`;
  document.body.appendChild(bg);
  const box = $(".modal", bg);
  const close = () => { bg.remove(); if (done.length) route(); };
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });

  const amountOf = (l) => Math.round((l.credit || l.debit) * 100) / 100;
  const openAmt = (ledger, b) => Math.max(0, Math.round((b.amount - (used.get(ledger.toUpperCase() + "|" + b.name) || 0)) * 100) / 100);

  async function billsFor(ledger) {
    const k = ledger.toUpperCase();
    if (!billCache.has(k)) billCache.set(k, await api("/bank/" + sid + "/outstanding-bills", { body: { ledger }, quiet: true }));
    return billCache.get(k);
  }

  function finish() {
    box.innerHTML = `<h2>All done</h2><p><b>${done.length}</b> transaction${done.length === 1 ? "" : "s"} saved${skipped.length ? `, <b>${skipped.length}</b> skipped` : ""}.</p>
      <p class="muted small">Nothing has gone to Tally yet. Post the ready entries from the statement page when you are happy.</p>
      <div style="display:flex;justify-content:flex-end"><button class="btn primary" id="bsClose">Close</button></div>`;
    $("#bsClose", box).onclick = close;
  }

  async function show() {
    if (i >= queue.length) return finish();
    const l = queue[i], amount = amountOf(l), out = !!l.debit && !l.credit;
    const names = (partySugg[l.id] || []).filter((s) => !/^(bank accounts|cash)/i.test((meta.get(s.name.toUpperCase()) || {}).primary_group || ""));
    const chq = BP.chequeNo(l.narration), hints = BP.billHints(l.narration);
    const startLedger = l.ledger && l.method === "manual" ? l.ledger : (names[0]?.name || "");
    box.innerHTML = `
      <div class="bs-top"><b>Transaction ${i + 1} of ${queue.length}</b><div class="bs-bar"><i style="width:${Math.round(i / queue.length * 100)}%"></i></div>
        <div class="spacer"></div><button type="button" class="btn sm" id="bsBack" ${i ? "" : "disabled"}>‹ Back</button><button type="button" class="btn sm" id="bsSkip">Skip ›</button><button type="button" class="btn sm ghost" id="bsX" aria-label="Close">✕</button></div>
      <div class="bs-tx"><div><span class="tag ${out ? "bad" : "good"}">${out ? "Money out · Payment" : "Money in · Receipt"}</span><div class="bs-amt">₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div><div class="muted small">${esc(fmtDate(l.date))}${chq ? ` · Cheque ${esc(chq)}` : ""}${l.ref ? ` · Ref ${esc(l.ref)}` : ""}</div></div>
        <div class="bs-narr">${esc(l.narration)}</div></div>
      <div class="field" style="margin-top:12px"><label for="bsLedger">Who is this? Type to search ledgers</label>
        <select class="in" id="bsLedger" data-search><option value="">Choose a ledger…</option>${ledgers.map((x) => `<option ${x.name === startLedger ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
      ${names.length ? `<div class="bs-sug">Found in the narration: ${names.map((s) => `<button type="button" class="chip-btn" data-pick="${esc(s.name)}">${esc(s.name)} <span class="muted small">${Math.round(s.score <= 1 ? s.score * 100 : s.score)}%</span></button>`).join("")}</div>` : `<div class="bs-sug muted small">No party name recognised in this narration — search the ledger above.</div>`}
      <div id="bsBills" style="margin-top:12px"></div>
      <div id="bsFoot"></div>`;
    $("#bsX", box).onclick = close;
    $("#bsBack", box).onclick = () => { i = Math.max(0, i - 1); show(); };
    $("#bsSkip", box).onclick = () => { skipped.push(l.id); i++; show(); };
    const sel = $("#bsLedger", box);
    $$("[data-pick]", box).forEach((b) => b.onclick = () => { sel.value = b.dataset.pick; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    sel.addEventListener("change", () => render(l, amount, hints));
    render(l, amount, hints);
    setTimeout(() => { if (!sel.value) $(".cb-input", box)?.focus(); }, 30);
  }

  async function render(l, amount, hints) {
    const sel = $("#bsLedger", box), ledger = sel.value, area = $("#bsBills", box), foot = $("#bsFoot", box);
    if (!ledger) { area.innerHTML = ""; foot.innerHTML = ""; return; }
    if (!isParty(ledger)) {
      area.innerHTML = `<div class="alert info">${esc(ledger)} is not a customer or supplier, so there are no bills to pick.</div>`;
      return saveBar(l, amount, ledger, () => []);
    }
    area.innerHTML = `<div class="boot" style="height:80px"><span class="spin"></span> Reading ${esc(ledger)}'s open bills from Tally…</div>`;
    let r;
    try { r = await billsFor(ledger); } catch (e) { area.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return saveBar(l, amount, ledger, () => []); }
    if (sel.value !== ledger) return;
    const bills = r.bills.map((b) => ({ ...b, open: openAmt(ledger, b) })).filter((b) => b.open > 0.004);
    // Tick a bill the narration names; otherwise the one bill that equals this amount exactly.
    const named = bills.filter((b) => hints.some((h) => String(b.name).toUpperCase().replace(/\s/g, "").includes(h.replace(/\s/g, ""))));
    const exact = bills.filter((b) => Math.abs(b.open - amount) < 0.01);
    const pre = new Set((named.length ? named : exact.length === 1 ? exact : []).map((b) => b.name));
    area.innerHTML = bills.length ? `<div class="bs-bills"><table class="grid"><thead><tr><th></th><th>Bill no.</th><th>Date</th><th class="num">Open ₹</th><th class="num">Settle ₹</th></tr></thead><tbody>
      ${bills.map((b, k) => { const on = pre.has(b.name); return `<tr class="${on ? "sel" : ""}"><td><input type="checkbox" class="bsUse" data-k="${k}" ${on ? "checked" : ""} aria-label="Settle ${esc(b.name)}"></td>
        <td><b>${esc(b.name)}</b>${hints.some((h) => String(b.name).toUpperCase().includes(h)) ? ' <span class="tag good">in narration</span>' : ""}${b.overdue_days > 0 ? ` <span class="tag bad">${b.overdue_days}d overdue</span>` : ""}</td><td>${b.date ? esc(fmtDate(b.date)) : "—"}</td>
        <td class="num">${b.open.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
        <td class="num"><input class="in bsAmt" data-k="${k}" inputmode="decimal" style="width:110px;text-align:right" value="${on ? Math.min(b.open, amount).toFixed(2) : ""}" aria-label="Amount settled against ${esc(b.name)}"></td></tr>`; }).join("")}</tbody></table></div>
      <div class="small muted" style="margin-top:4px">${esc(r.notice || "")} Tick the bill(s) this ${l.debit && !l.credit ? "payment" : "receipt"} settles. What is left over is saved On Account.</div>
      <div style="margin-top:6px"><button type="button" class="btn sm" id="bsFifo">Fill oldest bills first</button></div>` :
      `<div class="alert warn">${esc(r.notice || "No open bills found.")} ${bills.length === 0 && r.bills.length ? "All of this party's bills are already used by earlier transactions here." : "The amount will be saved On Account."}</div>`;
    const getPicked = () => {
      const out = [];
      $$(".bsUse", area).forEach((cb) => {
        if (!cb.checked) return;
        const k = +cb.dataset.k, v = Number($(`.bsAmt[data-k="${k}"]`, area).value);
        if (v > 0) out.push({ name: bills[k].name, amount: Math.round(v * 100) / 100 });
      });
      return out;
    };
    $$(".bsUse", area).forEach((cb) => cb.onchange = () => {
      const k = +cb.dataset.k, inp = $(`.bsAmt[data-k="${k}"]`, area);
      if (cb.checked && !Number(inp.value)) {
        const left = Math.max(0, amount - getPicked().reduce((a, b) => a + b.amount, 0));
        inp.value = Math.min(bills[k].open, left || bills[k].open).toFixed(2);
      }
      if (!cb.checked) inp.value = "";
      cb.closest("tr").classList.toggle("sel", cb.checked); paintSum();
    });
    $$(".bsAmt", area).forEach((inp) => inp.oninput = () => { const k = +inp.dataset.k; const cb = $(`.bsUse[data-k="${k}"]`, area); cb.checked = Number(inp.value) > 0; cb.closest("tr").classList.toggle("sel", cb.checked); paintSum(); });
    $("#bsFifo", area)?.addEventListener("click", () => {
      let left = amount;
      bills.slice().sort((a, b) => String(a.date || "9").localeCompare(String(b.date || "9"))).forEach((b) => {
        const k = bills.indexOf(b), take = Math.min(b.open, left);
        const cb = $(`.bsUse[data-k="${k}"]`, area), inp = $(`.bsAmt[data-k="${k}"]`, area);
        cb.checked = take > 0; inp.value = take > 0 ? take.toFixed(2) : ""; cb.closest("tr").classList.toggle("sel", take > 0); left = Math.round((left - take) * 100) / 100;
      });
      paintSum();
    });
    const paintSum = () => {
      const got = getPicked().reduce((a, b) => a + b.amount, 0), left = Math.round((amount - got) * 100) / 100;
      const el = $("#bsSum", box);
      if (el) { el.innerHTML = got ? `Settles <b>₹${got.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</b> of ${amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}${left > 0.004 ? ` · <span class="warn">₹${left.toLocaleString("en-IN", { minimumFractionDigits: 2 })} On Account</span>` : left < -0.004 ? ` · <span class="bad">₹${(-left).toFixed(2)} more than the amount</span>` : " · exact"}` : `No bill ticked — the whole ₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })} goes <b>On Account</b>`; el.dataset.over = left < -0.004 ? "1" : ""; }
    };
    saveBar(l, amount, ledger, getPicked, paintSum);
  }

  function saveBar(l, amount, ledger, getPicked, paintSum) {
    const foot = $("#bsFoot", box), party = isParty(ledger);
    foot.innerHTML = `<div class="bs-foot"><label class="check-row" style="margin:0"><input type="checkbox" id="bsRemember" checked> Remember for similar narrations</label><div class="spacer"></div>
      <div id="bsSum" class="small"></div><button type="button" class="btn primary" id="bsSave">Save &amp; next ›</button></div>`;
    paintSum?.(); if (!paintSum) $("#bsSum", box).textContent = "";
    $("#bsSave", box).onclick = async () => {
      const picked = getPicked();
      if ($("#bsSum", box).dataset.over) return toast("The bills add up to more than the transaction amount.", true);
      const btn = $("#bsSave", box); btn.disabled = true;
      try {
        const remember = $("#bsRemember", box).checked;
        if (!picked.length || remember)
          await api("/bank/" + sid + "/assign", { body: { ids: [l.id], ledger, on_account: party, remember } });
        if (picked.length) {
          await api("/bank/" + sid + "/allocate-bills", { body: { id: l.id, ledger, bills: picked } });
          for (const p of picked) { const k = ledger.toUpperCase() + "|" + p.name; used.set(k, (used.get(k) || 0) + p.amount); }
        }
        l.ledger = ledger; l.method = "manual"; done.push(l.id); i++; show();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    };
  }
  show();
}
