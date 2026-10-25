/* Outstanding & ageing: who owes what, how old it is, and sharing it (WhatsApp text, PDF) by party or by group.
   Read-only: the figures are read live from Tally; nothing here writes to Tally. */
"use strict";

const OUT_STATE = {};
const outKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const OUT_BUCKETS = [["0-30", "0–30 days"], ["31-60", "31–60"], ["61-90", "61–90"], ["90+", "Over 90"], ["undated", "No date"]];

async function renderOutstanding(c, el) {
  const S = (OUT_STATE[c.id] ||= { side: "receivable", q: "", group: "", asOf: "", off: new Set(), skip: new Set(), open: new Set() });
  const Share = await import("/share.js");
  const { download } = await import("/xlsxwrite.js");
  let data = null, failed = "";

  el.innerHTML = `<div class="out">
    <div class="out-tools">
      <div class="seg" id="oSide"><button data-s="receivable">To receive <span class="c" id="oCntR"></span></button><button data-s="payable">To pay <span class="c" id="oCntP"></span></button></div>
      <label class="out-asof">As on <input class="in" type="date" id="oAsOf"></label>
      <input class="in" id="oQ" placeholder="Find a party…" style="max-width:240px">
      <select class="in" id="oGroup" style="max-width:220px"></select>
      <div class="spacer"></div>
      <button class="btn" id="oReload" title="Read Tally again">↻ Read Tally again</button>
    </div>
    <div id="oBody"><div class="boot"><span class="spin"></span> Reading outstanding bills from Tally…</div></div>
  </div>`;
  const body = $("#oBody", el);

  const effBills = (p) => p.bills.filter((b) => !S.skip.has(b.id));
  const sum = (bills) => Math.round(bills.reduce((s, b) => s + b.amount, 0) * 100) / 100;
  const inr = Share.inr;
  const side = () => data.sides[S.side];
  const visible = () => side().parties.filter((p) => (!S.q || outKey(p.ledger).includes(outKey(S.q))) && (!S.group || p.group === S.group));
  const included = () => visible().filter((p) => !S.off.has(outKey(p.ledger)));

  async function load() {
    failed = "";
    body.innerHTML = `<div class="boot"><span class="spin"></span> Reading outstanding bills from Tally…</div>`;
    try { data = await api(`/companies/${c.id}/outstanding${S.asOf ? "?as_of=" + encodeURIComponent(S.asOf) : ""}`); S.asOf = data.as_of; }
    catch (e) { failed = e.message; }
    draw();
  }

  function sourceHtml() {
    const steps = data.diagnostics.map((d) => `<li class="${d.ok ? "ok" : "no"}"><b>${d.ok ? "✓" : "✗"} ${esc(d.step)}</b> <span class="muted">${esc(d.detail || "")}</span></li>`).join("");
    const label = { report: "Tally's Bills Receivable / Payable reports", "ledger-bills": "each party's bill details", balances: "ledger balances only", "": "nothing" }[data.source];
    const warn = data.warnings.length ? `<ul class="out-warn">${data.warnings.slice(0, 6).map((w) => `<li>${esc(w)}</li>`).join("")}${data.warnings.length > 6 ? `<li class="muted">…and ${data.warnings.length - 6} more</li>` : ""}</ul>` : "";
    return `<div class="alert ${data.source === "report" || data.source === "ledger-bills" ? "info" : data.source ? "warn" : "bad"}" style="margin-bottom:12px">
      <b>Source: ${esc(label)}</b> · as on ${esc(fmtDate(data.as_of))} ${warn}
      <details ${data.source ? "" : "open"} style="margin-top:6px"><summary class="small">What Tally answered</summary><ul class="out-diag">${steps}</ul></details></div>`;
  }

  function summaryHtml(list) {
    const bills = list.flatMap(effBills);
    const owed = bills.filter((b) => b.amount > 0), adv = bills.filter((b) => b.amount < 0);
    const total = sum(bills), overdue = sum(owed.filter((b) => b.overdue_days > 0));
    const by = Object.fromEntries(OUT_BUCKETS.map(([k]) => [k, 0]));
    for (const b of owed) by[b.bucket] = (by[b.bucket] || 0) + b.amount;
    const max = Math.max(1, ...Object.values(by));
    return `<div class="out-sum">
      <div class="stat"><div class="k">${S.side === "payable" ? "Total to pay" : "Total to receive"}</div><div class="v">₹${inr(total)}</div><div class="s">${list.length} part${list.length === 1 ? "y" : "ies"} · ${owed.length} bills${adv.length ? ` · advances ₹${inr(-sum(adv))}` : ""}</div></div>
      <div class="stat"><div class="k">Past due</div><div class="v ${overdue ? "bad" : ""}">₹${inr(overdue)}</div><div class="s">${owed.filter((b) => b.overdue_days > 0).length} bills overdue</div></div>
      <div class="stat wide"><div class="k">Age of bills</div><div class="buckets">${OUT_BUCKETS.filter(([k]) => by[k] || k !== "undated").map(([k, l]) =>
        `<div class="bk"><div class="bar2"><i class="b-${k.replace("+", "p")}" style="height:${Math.round(by[k] / max * 100)}%"></i></div><div class="bl">${l}</div><div class="bv">${inr(by[k])}</div></div>`).join("")}</div></div>
    </div>`;
  }

  function billRows(p) {
    return p.bills.map((b) => `<tr class="bill ${b.amount < 0 ? "adv" : ""}"><td><input type="checkbox" data-bill="${esc(b.id)}" ${S.skip.has(b.id) ? "" : "checked"} aria-label="Include ${esc(b.name)}"></td>
      <td>${esc(b.name)}${b.amount < 0 ? ' <span class="tag">advance / credit</span>' : b.kind === "balance" ? ' <span class="tag warn">balance only</span>' : ""}</td>
      <td>${b.date ? esc(fmtDate(b.date)) : "—"}</td><td>${b.due ? esc(fmtDate(b.due)) : "—"}</td>
      <td class="num">${b.days_old ?? "—"}</td><td class="num">${b.overdue_days > 0 ? `<span class="bad">${b.overdue_days}</span>` : b.overdue_days === 0 ? "0" : "—"}</td>
      <td class="num">${inr(b.amount)}</td></tr>`).join("");
  }

  function partyRows(list) {
    if (!list.length) return `<tr><td colspan="8" class="empty">${data.source ? "No parties match." : "Nothing to show."}</td></tr>`;
    return list.map((p) => {
      const k = outKey(p.ledger), on = !S.off.has(k), open = S.open.has(k), eb = effBills(p);
      const owed = eb.filter((b) => b.amount > 0), od = sum(owed.filter((b) => b.overdue_days > 0));
      const skipped = p.bills.length - eb.length;
      return `<tr class="party ${on ? "" : "off"}" data-k="${esc(k)}">
        <td><input type="checkbox" data-party ${on ? "checked" : ""} aria-label="Include ${esc(p.ledger)}"></td>
        <td><button class="lnk" data-toggle title="Show or hide the bills">${open ? "▾" : "▸"} <b>${esc(p.ledger)}</b></button>
          <div class="muted small">${esc(p.group || "")}${p.mismatch != null ? ` · <span class="warn" title="The ledger balance in Tally is ₹${inr(p.mismatch)}">differs from ledger</span>` : ""}${skipped ? ` · ${skipped} unticked` : ""}</div></td>
        <td class="small">${p.phone ? `<span class="mono">+${esc(p.phone)}</span> <button class="lnk" data-phone title="Change number">✎</button>` : `<button class="lnk" data-phone>+ Add number</button>`}</td>
        <td class="num">${owed.length}</td>
        <td class="num">${p.oldest_days != null ? p.oldest_days + " d" : "—"}</td>
        <td class="num">${od ? `<span class="bad">${inr(od)}</span>` : "—"}</td>
        <td class="num"><b>${inr(sum(eb))}</b></td>
        <td class="acts"><button class="btn sm wa" data-wa title="Send on WhatsApp">WhatsApp</button> <button class="btn sm" data-pdf title="Download a PDF statement">PDF</button></td></tr>
        ${open ? `<tr class="bills"><td></td><td colspan="7"><table class="grid inner"><thead><tr><th></th><th>Bill</th><th>Date</th><th>Due</th><th class="num">Days</th><th class="num">Overdue</th><th class="num">Pending ₹</th></tr></thead><tbody>${billRows(p)}</tbody></table>
          <div class="small muted" style="margin:4px 0 8px">Untick a bill to leave it out of this party's total, message and PDF.</div></td></tr>` : ""}`;
    }).join("");
  }

  function draw() {
    if (failed) { body.innerHTML = `<div class="alert bad"><b>Couldn't read the bills.</b> ${esc(failed)}</div><p><button class="btn" id="oRetry">↻ Try again</button></p>`; $("#oRetry", el).onclick = load; return; }
    $("#oAsOf", el).value = S.asOf || data.as_of;
    $$("#oSide button", el).forEach((b) => b.classList.toggle("on", b.dataset.s === S.side));
    $("#oCntR", el).textContent = data.sides.receivable.parties.length; $("#oCntP", el).textContent = data.sides.payable.parties.length;
    const groups = [...new Set(side().parties.map((p) => p.group).filter(Boolean))].sort();
    if (S.group && !groups.includes(S.group)) S.group = "";
    $("#oGroup", el).innerHTML = `<option value="">All groups</option>` + groups.map((g) => `<option ${g === S.group ? "selected" : ""}>${esc(g)}</option>`).join("");
    const list = visible(), inc = included();
    body.innerHTML = sourceHtml() + summaryHtml(inc) + `<div class="card flush"><table class="grid out-table"><thead><tr>
        <th style="width:30px"><input type="checkbox" id="oAll" ${inc.length && inc.length === list.length ? "checked" : ""} aria-label="Select all parties"></th>
        <th>Party</th><th>WhatsApp number</th><th class="num">Bills</th><th class="num">Oldest</th><th class="num">Past due</th><th class="num">Pending ₹</th><th></th></tr></thead>
      <tbody>${partyRows(list)}</tbody></table></div>
      <div class="out-foot"><span><b>${inc.length}</b> of ${list.length} parties ticked</span><div class="spacer"></div>
        <button class="btn" id="oExpand">${list.every((p) => S.open.has(outKey(p.ledger))) ? "Collapse all" : "Expand all"}</button>
        <button class="btn" id="oShare" ${inc.length ? "" : "disabled"}>Share ticked parties…</button>
        <button class="btn primary" id="oPdfAll" ${inc.length ? "" : "disabled"}>PDF of ticked parties</button></div>`;
    wire();
  }

  // ---------------------------------------------------------------- actions
  const partyOf = (tr) => side().parties.find((p) => outKey(p.ledger) === tr.dataset.k);
  const payload = (p) => ({ company: c.name, side: S.side, asOf: data.as_of, party: p.ledger, bills: effBills(p) });
  const safe = (s) => String(s).replace(/[^\w\- ]+/g, "").trim().slice(0, 50) || "party";
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } };
  const pdfFor = (parties, title) => {
    const ps = parties.map((p) => ({ heading: p.ledger, sub: p.group, bills: effBills(p), total: sum(effBills(p)) })).filter((p) => p.bills.length);
    if (!ps.length) throw new Error("Every bill is unticked — tick the bills you want to include.");
    return new Blob([Share.buildPdf({ title, subtitle: `${c.name}  ·  as on ${fmtDate(data.as_of)}`, parties: ps, grandTotal: sum(ps.flatMap((p) => p.bills)), footer: "Amounts in Indian Rupees. Generated from Tally by Vipul Workplace." })], { type: "application/pdf" });
  };
  const titleOf = () => S.side === "payable" ? "Payments due" : "Outstanding statement";
  function pdfParty(p) {
    try { download(pdfFor([p], `${titleOf()} - ${p.ledger}`), `${titleOf()} - ${safe(p.ledger)} - ${data.as_of}.pdf`); toast("PDF saved to your Downloads folder"); }
    catch (e) { toast(e.message, true); }
  }
  async function waParty(p, phoneOverride) {
    const bills = effBills(p);
    if (!bills.length) { toast("Every bill is unticked — tick the bills you want to send.", true); return; }
    const text = Share.partyText(payload(p));
    const link = Share.waLink(phoneOverride ?? p.phone, text);
    await copy(text);
    window.open(link.url, "_blank", "noopener");
    toast(link.sendsToNumber ? (link.short ? "Opened WhatsApp (message trimmed — attach the PDF for the full list)" : "Opened WhatsApp with the message ready") : "No number saved — pick the contact in WhatsApp. The message is also copied.");
  }
  function phoneModal(p) {
    modal(`<h2>WhatsApp number — ${esc(p.ledger)}</h2>
      <div class="field"><label>Mobile number (10 digits, or with country code)</label><input class="in mono" name="phone" value="${esc(p.phone ? "+" + p.phone : "")}" placeholder="98765 43210" autocomplete="off"></div>
      <div class="muted small" style="margin-bottom:10px">Saved on this PC only, not in Tally. Leave empty to remove it.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>`,
    async (d) => {
      const r = await api(`/companies/${c.id}/party-contacts`, { method: "PUT", body: { ledger: p.ledger, phone: d.phone } });
      for (const sd of Object.values(data.sides)) for (const q of sd.parties) if (outKey(q.ledger) === outKey(p.ledger)) q.phone = r.phone;
      draw();
    });
  }
  function shareModal() {
    const parties = included().filter((p) => effBills(p).length);
    const bg = modal(`<h2>Share ${parties.length} part${parties.length === 1 ? "y" : "ies"}</h2>
      <p class="muted small" style="margin-top:-6px">WhatsApp opens with each message ready; press send there. A PDF can't be attached by a link — download it and attach it in the chat.</p>
      <div class="share-list">${parties.map((p, i) => `<div class="share-row" data-i="${i}"><div class="who"><b>${esc(p.ledger)}</b><div class="muted small">₹${inr(sum(effBills(p)))} · ${plural(effBills(p).filter((b) => b.amount > 0).length, "bill")}</div></div>
        <input class="in mono ph" placeholder="Mobile number" value="${esc(p.phone ? "+" + p.phone : "")}" aria-label="Mobile number for ${esc(p.ledger)}">
        <button type="button" class="btn sm wa" data-w>WhatsApp</button><button type="button" class="btn sm" data-p>PDF</button></div>`).join("")}</div>
      <div class="field" style="margin-top:12px"><label>One summary message for the whole list (each party's total)</label>
        <div style="display:flex;gap:8px"><input class="in mono" id="grpPhone" placeholder="Number to send the summary to (optional)"><button type="button" class="btn" id="grpWa">WhatsApp summary</button><button type="button" class="btn" id="grpCopy">Copy</button></div></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button type="button" class="btn" data-close>Close</button></div>`, async () => {});
    $(".modal", bg).style.maxWidth = "720px"; $(".modal", bg).style.width = "min(720px,94vw)";
    $$(".share-row", bg).forEach((row) => {
      const p = parties[+row.dataset.i], ph = $(".ph", row);
      ph.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); ph.blur(); } };
      ph.onchange = async () => {
        try { const r = await api(`/companies/${c.id}/party-contacts`, { method: "PUT", body: { ledger: p.ledger, phone: ph.value } }); p.phone = r.phone; ph.value = r.phone ? "+" + r.phone : ""; }
        catch (e) { toast(e.message, true); }
      };
      $("[data-w]", row).onclick = () => waParty(p, ph.value);
      $("[data-p]", row).onclick = () => pdfParty(p);
    });
    const groupMsg = () => Share.groupText({ company: c.name, side: S.side, asOf: data.as_of, groupName: S.group || (S.side === "payable" ? "Payables" : "Outstanding"), parties: parties.map((p) => ({ ledger: p.ledger, bills: effBills(p) })) });
    $("#grpPhone", bg).onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); };
    $("#grpWa", bg).onclick = async () => { const t = groupMsg(); await copy(t); window.open(Share.waLink($("#grpPhone", bg).value, t).url, "_blank", "noopener"); };
    $("#grpCopy", bg).onclick = async () => toast((await copy(groupMsg())) ? "Summary copied" : "Couldn't copy", false);
  }

  function wire() {
    $("#oAll", el).onchange = (e) => { for (const p of visible()) e.target.checked ? S.off.delete(outKey(p.ledger)) : S.off.add(outKey(p.ledger)); draw(); };
    $$("tr.party", el).forEach((tr) => {
      const p = partyOf(tr), k = tr.dataset.k;
      $("[data-party]", tr).onchange = (e) => { e.target.checked ? S.off.delete(k) : S.off.add(k); draw(); };
      $("[data-toggle]", tr).onclick = () => { S.open.has(k) ? S.open.delete(k) : S.open.add(k); draw(); };
      $("[data-phone]", tr).onclick = () => phoneModal(p);
      $("[data-wa]", tr).onclick = () => waParty(p);
      $("[data-pdf]", tr).onclick = () => pdfParty(p);
    });
    $$("[data-bill]", el).forEach((cb) => cb.onchange = () => { cb.checked ? S.skip.delete(cb.dataset.bill) : S.skip.add(cb.dataset.bill); draw(); });
    $("#oExpand", el).onclick = () => { const l = visible(); const all = l.every((p) => S.open.has(outKey(p.ledger))); for (const p of l) all ? S.open.delete(outKey(p.ledger)) : S.open.add(outKey(p.ledger)); draw(); };
    $("#oShare", el).onclick = shareModal;
    $("#oPdfAll", el).onclick = () => {
      try { const t = S.group ? `${titleOf()} - ${S.group}` : titleOf(); download(pdfFor(included(), t), `${t} - ${data.as_of}.pdf`.replace(/[\\/:*?"<>|]/g, "")); toast("PDF saved to your Downloads folder"); }
      catch (e) { toast(e.message, true); }
    };
  }

  $$("#oSide button", el).forEach((b) => b.onclick = () => { S.side = b.dataset.s; S.group = ""; if (data) draw(); });
  $("#oAsOf", el).onchange = (e) => { S.asOf = e.target.value; S.skip.clear(); load(); };
  $("#oQ", el).value = S.q;
  $("#oQ", el).oninput = debounce((e) => { S.q = e.target.value; if (data) draw(); }, 150);
  $("#oGroup", el).onchange = (e) => { S.group = e.target.value; if (data) draw(); };
  $("#oReload", el).onclick = () => { S.skip.clear(); load(); };
  await load();
}
