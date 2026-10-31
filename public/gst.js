/* GSTR-2B reconciliation: upload the portal file, match it with the Tally purchase register (read by
   Tally), review differences, export for the CA, and message suppliers. Matching runs here. */
"use strict";

const GstLib = (() => {
  let mods = null;
  return async () => (mods ||= Promise.all([import("/gstr2b.js"), import("/gstmatch.js"), import("/xlsxwrite.js")]).then(([parse, match, xlsx]) => ({ parse, match, xlsx })));
})();

const GST_STATUS = {
  matched: ["good", "Matched"], mismatch: ["bad", "Amounts differ"], probable: ["warn", "Check invoice no."], missing: ["warn", "Not in Tally"],
  accepted: ["good", "Accepted"], ignored: ["muted", "Ignored"], info: ["muted", "Not compared"], new: ["muted", "Not matched yet"], books: ["warn", "Not in GSTR-2B"],
};
const gstChip = (st) => { const [cls, label] = GST_STATUS[st] || ["muted", st]; return `<span class="chip ${cls}">${label}</span>`; };
const gstTax = (x) => Math.round(((x.igst || 0) + (x.cgst || 0) + (x.sgst || 0) + (x.cess || 0)) * 100) / 100;

// ---------------------------------------------------------------- company tab: list
async function companyGst(c, el) {
  const rows = await api(`/companies/${c.id}/gstr2b`);
  const { parse: GP } = await GstLib();
  el.innerHTML = rows.length ? `<table class="grid"><thead><tr><th>Month</th><th>File</th><th class="num">Invoices</th><th class="num">Matched</th>
      <th class="num">Need a look</th><th class="num">Not in Tally</th><th class="num">Not in 2B</th><th class="num">ITC as per 2B</th></tr></thead><tbody>
    ${rows.map((r) => {
      const n = r.counts || {}, s = r.summary;
      const need = (n.mismatch || 0) + (n.probable || 0);
      return `<tr class="click" data-href="#/g/${r.id}"><td><b>${esc(GP.periodLabel(r.period))}</b><div class="muted" style="font-size:12px">${esc(r.kind || "GSTR-2B")} · ${ago(r.created_at)}</div></td>
        <td class="muted"><div style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.filename)}">${esc(r.filename)}</div></td>
        <td class="num">${r.docs}</td><td class="num good">${n.matched || 0}${n.accepted ? ` <span class="muted">+${n.accepted}</span>` : ""}</td>
        <td class="num ${need ? "bad" : "muted"}">${need}</td><td class="num ${n.missing ? "warn" : "muted"}">${n.missing || 0}</td>
        <td class="num ${s?.booksOnly?.n ? "warn" : "muted"}">${s ? s.booksOnly.n : "—"}</td><td class="num">${s ? money(s.b2b.tax) : "—"}</td></tr>`;
    }).join("")}</tbody></table>`
    : `<div class="card empty" style="text-align:left;max-width:760px"><b>Match GSTR-2B with your purchase register</b>
      <p class="muted" style="margin:8px 0 12px">Download GSTR-2B from the GST portal (JSON or Excel) and drop it here. The app reads your purchases from Tally, debit notes and GST journals from Tally;
      every supplier invoice is matched by GSTIN and invoice number — even when the number is written differently — and the tax is compared head by head.
      You see what matches, where the amounts differ, what is missing in Tally (input tax credit you could claim) and what your suppliers haven't filed yet — with a ready message for each supplier and an Excel for your CA.</p>
      <a class="btn primary" href="#/c/${c.id}/gstr2b/upload">⇪ Upload GSTR-2B</a></div>`;
  $$("tr[data-href]", el).forEach((tr) => tr.onclick = () => location.hash = tr.dataset.href);
}

// ---------------------------------------------------------------- upload
async function gstReadFile(file, GP) {
  const k = Ingest.kind(file);
  if (k === "zip") {
    const inner = (await Ingest.unzip(file)).filter((x) => /\.(json|xlsx)$/i.test(x.name));
    if (!inner.length) throw new Error(`${file.name}: no JSON or Excel file inside`);
    return Promise.all(inner.map((x) => gstReadFile(x.file, GP))).then((all) => all.flat());
  }
  if (k === "json") {
    let obj;
    try { obj = JSON.parse(await file.text()); } catch { throw new Error(`${file.name}: not a valid JSON file`); }
    return [{ ...GP.fromJson(obj), filename: file.name, source: "json" }];
  }
  if (k === "xlsx" || k === "xls") return [{ ...GP.fromWorkbook(await Ingest.workbook(file)), filename: file.name, source: "excel" }];
  throw new Error(`${file.name}: choose the JSON or Excel file downloaded from the GST portal`);
}

async function viewGstUpload(cid,mode="reconcile") {
  const purchaseMode=mode==="purchase";
  const [c, existing, { parse: GP }] = await Promise.all([api(`/companies/${cid}`), api(`/companies/${cid}/gstr2b`), GstLib()]);
  const st = { items: [], error: "" };
  const months = (() => { const out = []; const d = new Date(); d.setDate(1); for (let i = 0; i < 24; i++) { out.push(d.toISOString().slice(0, 7)); d.setMonth(d.getMonth() - 1); } return out; })();
  const render = () => {
    const ready = st.items.length && st.items.every((x) => x.period && x.docs.length);
    app().innerHTML = topBar([[c.name, purchaseMode ? `#/c/${cid}/gstr2b-purchase` : `#/c/${cid}/gstr2b`], ["Upload GSTR-2B"]], c) + `<div class="bar"><span class="status"></span><div class="spacer"></div>
      <a class="btn" href="#/c/${cid}/${purchaseMode?"gstr2b-purchase":"gstr2b"}">Back <kbd>Esc</kbd></a><button class="btn primary" id="go" ${ready ? "" : "disabled"}>${purchaseMode?"Prepare Purchase vouchers":"Match with Tally"} <kbd>↵</kbd></button></div>
    <div class="page wiz"><div class="eyebrow">${purchaseMode?"Purchase vouchers from GSTR-2B":"GSTR-2B reconciliation"}</div><h1>${esc(c.name)}</h1>
      <div class="wstep active"><div class="head"><span class="n">1</span><b>Download GSTR-2B from the GST portal</b></div>
        <p class="muted" style="margin:8px 0 0;font-size:13px">gst.gov.in → <b>Services → Returns → Returns Dashboard</b> → pick the financial year and month → <b>GSTR-2B → View → Download</b> (JSON or Excel; a .zip works too).</p></div>
      <div class="wstep active"><div class="head"><span class="n">2</span><b>Drop the file here</b></div>
        <label class="drop" id="drop"><input type="file" id="fi" multiple hidden accept=".json,.xlsx,.zip,application/json,application/zip">
          <div style="font-size:15px;color:var(--text)">Drop GSTR-2B here or click to choose</div>
          <div>One file per month. Several months at once are fine.</div></label>
        ${st.error ? `<div class="alert bad" style="margin-top:10px">${esc(st.error)}</div>` : ""}
        ${st.items.map((x, i) => {
          const s = { inv: 0, notes: 0, sup: new Set(), tax: 0 };
          for (const d of x.docs) { if (d.compare === false) continue; s.sup.add(d.ctin); if (d.note) s.notes++; else s.inv++; s.tax += (d.note === "C" ? -1 : 1) * (d.itc === "N" ? 0 : gstTax(d)); }
          const dup = existing.find((r) => r.period === x.period);
          const other = c.gstin && x.gstin && c.gstin.toUpperCase() !== x.gstin;
          return `<div class="card" style="margin-top:10px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>${esc(x.kind)} · ${x.period ? esc(GP.periodLabel(x.period)) : "month not found in the file"}</b>
            <span class="muted">${esc(x.filename)}</span><span class="spacer"></span><a href="#" data-rm="${i}" class="muted">Remove</a></div>
            <div class="kv"><div><span>Invoices</span><b>${s.inv}</b></div><div><span>Credit / debit notes</span><b>${s.notes}</b></div><div><span>Suppliers</span><b>${s.sup.size}</b></div>
              <div><span>ITC available</span><b>${money(s.tax)}</b></div>${x.gstin ? `<div><span>Your GSTIN</span><b class="mono">${esc(x.gstin)}</b></div>` : ""}</div>
            ${x.period ? "" : `<div class="field" style="margin-top:10px;max-width:260px"><label>Which month is this GSTR-2B for?</label><select class="in" data-period="${i}"><option value="">Choose…</option>${months.map((m) => `<option value="${m}">${GP.periodLabel(m)}</option>`).join("")}</select></div>`}
            ${!x.docs.length ? `<div class="alert warn" style="margin-top:10px">No invoices found in this file.</div>` : ""}
            ${other ? `<div class="alert warn" style="margin-top:10px">This GSTR-2B is for GSTIN <b>${esc(x.gstin)}</b>, but ${esc(c.name)} is set up with <b>${esc(c.gstin)}</b>. Check that it's the right company.</div>` : ""}
            ${dup ? `<div class="alert warn" style="margin-top:10px">${esc(GP.periodLabel(x.period))} is already here (uploaded ${ago(dup.created_at)}). ${purchaseMode?"This upload will be saved separately; previously prepared Purchase batches and reconciliation decisions are retained.":"The older one is replaced; decisions you made there are not carried over."}</div>` : ""}
            ${x.rejected ? `<div class="muted" style="font-size:12.5px;margin-top:8px">${x.rejected} document(s) you rejected on the IMS dashboard are left out.</div>` : ""}</div>`;
        }).join("")}
      </div></div>`;
    wireTop(c);
    const add = async (files) => {
      st.error = "";
      for (const f of files) {
        try { st.items.push(...(await gstReadFile(f, GP))); }
        catch (e) { st.error = e.message; }
      }
      render();
    };
    $("#fi").onchange = (e) => add([...e.target.files]);
    const drop = $("#drop");
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); add([...e.dataTransfer.files]); };
    $$("[data-rm]").forEach((a) => a.onclick = (e) => { e.preventDefault(); st.items.splice(+a.dataset.rm, 1); render(); });
    $$("[data-period]").forEach((s) => s.onchange = () => { st.items[+s.dataset.period].period = s.value; render(); });
    $("#go").onclick = go;
  };
  let busy = false;
  const go = async () => {
    if (busy || !st.items.length || !st.items.every((x) => x.period && x.docs.length)) return;
    if(purchaseMode&&st.items.some(x=>x.kind!=="GSTR-2B"||!x.gstin||x.gstin.toUpperCase()!==String(c.gstin||"").toUpperCase()))return toast("Only GSTR-2B files matching the selected company GSTIN can create Purchase vouchers.",true);
    busy = true;
    const btn = $("#go"), status = $(".bar .status");
    btn.disabled = true; btn.textContent = "Saving…";
    let last = null;
    try {
      for (const x of st.items) {
        if(!purchaseMode)for (const old of existing.filter((r) => r.period === x.period)) await api(`/gstr2b/${old.id}`, { method: "DELETE" });
        status.textContent = `Saving ${GP.periodLabel(x.period)}…`;
        const r = await api(`/companies/${cid}/gstr2b`, { body: { period: x.period, gstin: x.gstin, kind: x.kind, filename: x.filename, source: x.source, gendt: x.gendt, rejected: x.rejected } });
        for (let i = 0; i < x.docs.length; i += 500) await api(`/gstr2b/${r.id}/docs`, { body: { part: i / 500, docs: x.docs.slice(i, i + 500) } });
        await api(`/gstr2b/${r.id}/start`, { body: {} });
        last = r.id;
      }
      if(purchaseMode&&st.items.length===1){
        const result=await api("/companies/"+cid+"/gstr2b-purchases/prepare",{body:{return_id:last}});
        location.hash="#/p2b/"+result.id;
      }else if(purchaseMode)location.hash="#/c/"+cid+"/gstr2b-purchase";
      else location.hash = st.items.length === 1 ? `#/g/${last}` : `#/c/${cid}/gstr2b`;
    } catch (e) { toast(e.message, true); busy = false; render(); }
  };
  keymap.Escape = () => location.hash = purchaseMode ? `#/c/${cid}/gstr2b-purchase` : `#/c/${cid}/gstr2b`;
  keymap.enter = () => go();
  render();
}

// ---------------------------------------------------------------- review
const GST_FILTERS = [
  ["need", "Need a look", (x) => x.kind === "doc" && ["mismatch", "probable"].includes(x.st)],
  ["missing", "Not in Tally", (x) => x.kind === "doc" && x.st === "missing"],
  ["books", "Not in 2B", (x) => x.kind === "book"],
  ["matched", "Matched", (x) => x.kind === "doc" && x.st === "matched"],
  ["done", "Accepted / ignored", (x) => x.kind === "doc" && ["accepted", "ignored"].includes(x.st)],
  ["info", "Imports & ISD", (x) => x.kind === "doc" && x.st === "info"],
  ["all", "All", (x) => x.kind === "doc"],
];
const GST_UI = { filter: null, sel: 0, rid: null, q: "" };

async function gstData(rid, GM) {
  let s = await api(`/gstr2b/${rid}`);
  const ctx = await api(`/gstr2b/${rid}/context`);
  const books = GM.buildBooks(ctx.books, ctx.ledgers, ctx.rules||[]);
  const opts = { tol: s.tol ?? 1, period: s.period, usedElsewhere: new Set(ctx.elsewhere) };
  const fresh = ctx.books_at && (!s.matched_at || ctx.books_at > s.matched_at || s.docs.some((d) => d.status === "new") || s.summary?.calculation_version !== 2);
  if (fresh) {
    const r = GM.reconcile(s.docs, books, opts);
    const summary = GM.summarize(s.docs, r.results, r.booksOnly, r.byMid);
    await api(`/gstr2b/${rid}/matches`, { body: { results: [...r.results].map(([id, x]) => ({ id, ...x })), summary, books_only: r.booksOnly.map((b) => b.id),
      books_only_items: r.booksOnly.map((b) => ({ id: b.id, gstin: b.gstin, party: b.party, num: b.num || b.number, dt: b.dt, val: b.val, tax: b.tax })) }, quiet: true });
    s = await api(`/gstr2b/${rid}`, { quiet: true });
  }
  const r = GM.reconcile(s.docs, books, opts);
  const summary = GM.summarize(s.docs, r.results, r.booksOnly, r.byMid);
  return { s, ctx, books, r, summary };
}

async function viewGst(rid) {
  const { parse: GP, match: GM, xlsx: XW } = await GstLib();
  const { s, ctx, books, r, summary } = await gstData(rid, GM);
  const c = await api(`/companies/${s.company_id}`);
  CURRENT.company = c;
  if (GST_UI.rid !== rid) Object.assign(GST_UI, { filter: null, sel: 0, rid, q: "" });
  const label = GP.periodLabel(s.period);
  const tol = s.tol ?? 1;
  const byMid = r.byMid;
  const job = (ctx.jobs || [])[0];
  const reading = job && (job.status === "pending" || job.status === "sent");

  // one list of rows: 2B documents + Tally vouchers missing from 2B
  const items = [
    ...s.docs.map((d) => ({ kind: "doc", d, st: ctx.books_at || d.status === "info" ? d.status : "new", b: d.mid ? byMid.get(d.mid) : null })),
    ...r.booksOnly.map((b) => ({ kind: "book", b, st: "books" })),
  ];
  const count = Object.fromEntries(GST_FILTERS.map(([k, , f]) => [k, items.filter(f).length]));
  if (!GST_UI.filter) GST_UI.filter = count.need ? "need" : count.missing ? "missing" : count.books ? "books" : "all";
  const fdef = GST_FILTERS.find((f) => f[0] === GST_UI.filter) || GST_FILTERS[6];
  const q = GST_UI.q.trim().toLowerCase();
  const hit = (x) => !q || [x.d?.name, x.d?.ctin, x.d?.num, x.b?.party, x.b?.gstin, x.b?.num, x.b?.number].some((v) => String(v || "").toLowerCase().includes(q));
  const vis = items.filter((x) => fdef[2](x) && hit(x));
  GST_UI.sel = Math.min(GST_UI.sel, Math.max(0, vis.length - 1));

  // big figure = GST amount; under it, how many documents
  const card = (title, x, cls = "", sub = "") => `<div class="${cls}"><span>${title}</span><b>${money(x.tax)}</b><span class="muted">${x.n} document${x.n === 1 ? "" : "s"}${sub}</span></div>`;
  const tallyNote = reading ? `<span class="warn"><span class="spin" style="display:inline-block;vertical-align:-2px"></span> Reading purchases from Tally… ${c.tally_status === "ok" ? "" : "(waiting for TallyPrime to be open)"}</span>`
    : job?.status === "failed" ? `<span class="bad">Couldn't read purchases from Tally: ${esc(job.result || "")}</span>`
    : ctx.books_at ? `<span class="muted">${ctx.books.length} purchase vouchers read from Tally ${ago(ctx.books_at)} (${fmtDate(s.books_from)} – ${fmtDate(s.books_to)})</span>`
    : `<span class="muted">Purchases haven't been read from Tally yet.</span>`;

  const row = (x, i) => {
    const sel = i === GST_UI.sel ? "sel" : "";
    if (x.kind === "book") {
      const b = x.b;
      return `<tr class="click ${sel}" data-i="${i}"><td><b>${esc(b.party || "—")}</b><div class="muted mono" style="font-size:11.5px">${esc(b.gstin || "no GSTIN in Tally")}</div></td>
        <td class="mono" style="white-space:nowrap">${esc(b.num || "—")}<div class="muted" style="font-size:11.5px">${esc(b.vtype || "")} ${esc(b.number || "")}</div></td><td class="mono" style="white-space:nowrap">${fmtDate(b.dt)}</td>
        <td class="num">${money(b.val)}</td><td class="num">${money(b.tax)}</td><td>${gstChip("books")}<div class="muted" style="font-size:12px;max-width:260px">${esc(b.why || "")}</div></td></tr>`;
    }
    const d = x.d;
    const note = (d.notes || [])[0] || (d.diffs || []).map((f) => `${GM.HEAD_LABEL[f.field] || f.field} ${money(f.b2b)} vs ${money(f.books)}`)[0] || "";
    return `<tr class="click ${sel}" data-i="${i}"><td><b>${esc(d.name || "—")}</b><div class="muted mono" style="font-size:11.5px">${esc(d.ctin)}${d.note ? ` · ${d.note === "C" ? "Credit note" : "Debit note"}` : ""}${d.sec.endsWith("A") ? " · amended" : ""}</div></td>
      <td class="mono" style="white-space:nowrap">${esc(d.num)}</td><td class="mono" style="white-space:nowrap">${fmtDate(d.dt)}</td><td class="num">${money(d.val || d.txval)}</td>
      <td class="num">${money(gstTax(d))}${d.itc === "N" ? `<div class="warn" style="font-size:11px">ITC not available</div>` : ""}</td>
      <td>${gstChip(x.st)}${note ? `<div class="muted" style="font-size:12px;max-width:260px">${esc(note)}</div>` : ""}${d.remark ? `<div style="font-size:12px">✎ ${esc(d.remark)}</div>` : ""}</td></tr>`;
  };

  const cmpTable = (d, b) => {
    const rowsDef = [["Invoice no.", d.num, b?.num, "text"], ["Date", fmtDate(d.dt), b ? fmtDate(b.dt) : "", "text"], ["Taxable value", d.txval, b?.txval, "amt"],
      ["IGST", d.igst, b?.igst, "tax"], ["CGST", d.cgst, b?.cgst, "tax"], ["SGST / UTGST", d.sgst, b?.sgst, "tax"], ["Cess", d.cess, b?.cess, "tax"], ["Invoice value", d.val, b?.val, "amt"]];
    return `<table class="cmp"><thead><tr><th></th><th class="num">GSTR-2B</th><th class="num">Tally</th><th class="num">Difference</th></tr></thead><tbody>
      ${rowsDef.map(([lbl, a, z, kind]) => {
        if (kind === "text") return `<tr><td>${lbl}</td><td class="num">${esc(a || "—")}</td><td class="num">${b ? esc(z || "—") : "—"}</td><td></td></tr>`;
        const diff = b ? Math.round(((a || 0) - (z || 0)) * 100) / 100 : null;
        const off = diff != null && Math.abs(diff) > (kind === "tax" ? tol : Math.max(tol, 1));
        return `<tr class="${off ? "off" : ""}"><td>${lbl}</td><td class="num">${money(a || 0)}</td><td class="num">${b ? money(z || 0) : "—"}</td><td class="num ${off ? "bad" : "muted"}">${diff == null ? "" : diff ? money(diff) : "✓"}</td></tr>`;
      }).join("")}</tbody></table>`;
  };

  const candidatesFor = (d) => {
    const used = new Set(s.docs.filter((x) => x.mid && x.id !== d.id).map((x) => x.mid));
    const same = books.filter((b) => !used.has(b.id) && (b.gstin === d.ctin || (!b.gstin && b.party && d.name && b.party.toLowerCase().includes(d.name.toLowerCase().split(" ")[0]))));
    return same.map((b) => ({ b, c: GM.compare(d, b, tol) })).sort((x, y) => y.c.score - x.c.score).slice(0, 12);
  };

  const panelFor = (x) => {
    if (!x) return { html: `<div class="empty">${count.all ? "Select an invoice" : "Nothing in this GSTR-2B"}</div>`, wire: () => {} };
    if (x.kind === "book") {
      const b = x.b;
      const sameParty = r.booksOnly.filter((y) => (b.gstin ? y.gstin === b.gstin : y.party === b.party));
      const missingDocs = s.docs.filter((d) => d.status === "missing" && d.ctin && d.ctin === b.gstin);
      const html = `<div class="box"><div class="bh"><span class="eyebrow">In Tally · not in GSTR-2B</span>${gstChip("books")}</div><div class="bb">
          <div class="big">${esc(b.party || "—")}</div><div class="muted mono" style="font-size:12px">${esc(b.gstin || "No GSTIN on this party in Tally")}</div>
          <div class="kv"><div><span>Supplier invoice</span><b class="mono">${esc(b.num || "—")}</b></div><div><span>Date</span><b>${fmtDate(b.dt)}</b></div>
            <div><span>Tally voucher</span><b>${esc(b.vtype || "")} ${esc(b.number || "")}</b></div><div><span>Value</span><b>${money(b.val)}</b></div><div><span>GST</span><b>${money(b.tax)}</b></div></div>
          <div class="alert warn" style="margin-top:12px">${esc(b.why || "")}. The input tax credit on it (${money(b.tax)}) is at risk until the supplier files it in GSTR-1 / IFF.</div></div></div>
        <div class="box"><div class="bh"><b>Ask the supplier</b><span class="muted">${sameParty.length} invoice${sameParty.length === 1 ? "" : "s"} of ${esc(b.party || "this party")}</span></div>
          <div class="bb"><textarea class="in" id="g-msg" rows="9" style="font-size:12.5px"></textarea>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn" id="g-copy">Copy message</button><a class="btn" id="g-wa" target="_blank" rel="noopener">Send on WhatsApp</a></div></div></div>
        ${missingDocs.length ? `<div class="box"><div class="bh"><b>Or it's one of these 2B invoices</b><span class="muted">same GSTIN, not found in Tally</span></div><div class="bb">${missingDocs.map((d) =>
          `<div class="billrow"><span class="mono">${esc(d.num)}</span><span class="muted">${fmtDate(d.dt)}</span><span class="spacer"></span><span>${money(gstTax(d))}</span><button class="btn sm" data-linkdoc="${d.id}">Link</button></div>`).join("")}</div></div>` : ""}`;
      const wire = () => {
        const text = GM.supplierMessage({ company: c.name, period: label, party: b.party || "Sir / Madam",
          items: sameParty.map((y) => ({ num: y.num || y.number, dt: fmtDate(y.dt), val: y.val, tax: y.tax, why: "not in your GSTR-1 / IFF" })) });
        $("#g-msg").value = text;
        const upd = () => { $("#g-wa").href = "https://wa.me/?text=" + encodeURIComponent($("#g-msg").value); };
        upd(); $("#g-msg").oninput = upd;
        $("#g-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#g-msg").value); toast("Copied"); } catch { $("#g-msg").select(); document.execCommand("copy"); toast("Copied"); } };
        $$("[data-linkdoc]").forEach((btn) => btn.onclick = async () => { await act(() => api(`/gstr2b/${rid}/decide`, { body: { ids: [btn.dataset.linkdoc], action: "link", mid: b.id } }), "Linked"); refresh(); });
      };
      return { html, wire };
    }
    const d = x.d, b = x.b;
    const st = x.st;
    const cands = ["missing", "probable", "mismatch"].includes(st) || !b ? candidatesFor(d).filter((y) => y.b.id !== d.mid) : [];
    const html = `<div class="box"><div class="bh"><span class="eyebrow">${esc({ B2B: "Invoice", B2BA: "Amended invoice", CDNR: "Credit / debit note", CDNRA: "Amended note", ECO: "E-commerce invoice", ECOA: "Amended e-commerce invoice", ISD: "ISD credit", IMPG: "Import of goods" }[d.sec] || d.sec)}${d.supprd ? ` · filed for ${esc(/^\d{6}$/.test(d.supprd) ? GP.periodLabel(GP.periodFromRtn(d.supprd)) : d.supprd)}` : ""}</span>${gstChip(st)}</div><div class="bb">
        <div class="big">${esc(d.name || "—")}</div><div class="muted mono" style="font-size:12px">${esc(d.ctin)}${d.pos ? ` · place of supply ${esc(d.pos)}` : ""}</div>
        ${cmpTable(d, b)}
        ${b?.breakdown ? `<details style="margin-top:12px"><summary style="cursor:pointer">How Tally taxable value was calculated</summary>
          <div class="kv" style="margin:8px 0">
            <div><span>Base (${esc({inventory:"stock items",purchase_ledger:"purchase ledger",other_debit_ledgers:"other debit ledgers"}[b.breakdown.source]||b.breakdown.source)})</span><b>${money(b.breakdown.base)}</b></div>
            <div><span>Purchase ledger total (not added twice)</span><b>${money(b.breakdown.purchase_ledger)}</b></div>
            <div><span>Separate freight / discount / charges</span><b>${money(b.breakdown.adjustments)}</b></div>
            <div><span>Correct taxable</span><b>${money(b.breakdown.taxable)}</b></div>
          </div>
          ${(b.breakdown.adjustment_lines||[]).map(a=>`<div class="small muted">${esc(a.name)}: ${money(a.amount)} (${esc(a.kind)})</div>`).join("")}
          ${(b.breakdown.unclassified||[]).length?`<p class="small warn">Unclassified ledger(s) were excluded from the stock-item taxable base. Review GST treatment: ${b.breakdown.unclassified.map(a=>esc(a.name)).join(", ")}</p>`:""}
          </details>`:""}
        ${b ? `<div class="muted" style="font-size:12.5px;margin-top:8px">Tally: ${esc(b.vtype || "")} <b>${esc(b.number || "")}</b> dated ${fmtDate(b.date)} · ${esc(b.party || "")}${d.method === "manual" ? " · linked by you" : ""}</div>` : ""}
        ${(d.notes || []).length ? `<ul class="notes">${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        ${st === "missing" && d.compare !== false ? `<div class="alert warn" style="margin-top:10px">${d.itc === "N" ? "This invoice is in GSTR-2B but its credit is not available." : `Your supplier filed this invoice but it isn't in Tally. Enter the purchase (ITC ${money(gstTax(d))}) or link it below if it's already there under another number.`}</div>` : ""}
      </div></div>
      ${cands.length ? `<div class="box"><div class="bh"><b>${b ? "Or link a different voucher" : "Vouchers of this supplier in Tally"}</b><span class="muted">best first</span></div><div class="bb">${cands.map(({ b: y, c: cmp }) =>
        `<div class="billrow"><span class="mono">${esc(y.num || y.number)}</span><span class="muted">${fmtDate(y.dt)}</span><span class="muted" style="font-size:12px">${esc(y.vtype)} ${esc(y.number || "")}</span><span class="spacer"></span>
          <span class="${cmp.ok ? "good" : ""}">${money(y.tax)}</span><button class="btn sm" data-link="${esc(y.id)}">Link</button></div>`).join("")}</div></div>` : ""}
      ${d.compare === false ? "" : `<div class="box"><div class="bb" style="display:flex;gap:8px;flex-wrap:wrap">
        ${["accepted", "ignored"].includes(st) ? `<button class="btn" id="g-reopen">Reopen</button>` : `
          ${["mismatch", "probable"].includes(st) ? `<button class="btn primary" id="g-accept" title="The difference is checked and fine">Accept <kbd>A</kbd></button>` : ""}
          ${b ? `<button class="btn" id="g-unlink" title="${d.method === "manual" ? "Undo your link" : "Not this voucher"}">${d.method === "manual" ? "Undo link" : "Not this voucher"}</button>` : ""}
          <button class="btn" id="g-ignore">Ignore <kbd>I</kbd></button>`}
        </div><div class="bb" style="border-top:1px solid var(--line)"><label class="muted" style="font-size:12px">Your remark (goes into the Excel)</label>
        <div style="display:flex;gap:6px;margin-top:4px"><input class="in" id="g-remark" value="${esc(d.remark || "")}" placeholder="e.g. supplier sending credit note"><button class="btn" id="g-note">Save</button></div></div></div>`}`;
    const wire = () => {
      const decide = async (action, extra = {}, msg) => { await act(() => api(`/gstr2b/${rid}/decide`, { body: { ids: [d.id], action, ...extra } }), msg); refresh(); };
      $$("[data-link]").forEach((btn) => btn.onclick = () => decide("link", { mid: btn.dataset.link }, "Linked"));
      $("#g-accept")?.addEventListener("click", () => decide("accept", {}, "Accepted"));
      $("#g-unlink")?.addEventListener("click", () => decide(d.method === "manual" ? "unlink" : "missing", {}, "Unlinked"));
      $("#g-ignore")?.addEventListener("click", () => decide("ignore", {}, "Ignored"));
      $("#g-reopen")?.addEventListener("click", () => decide("reopen", {}, "Reopened"));
      $("#g-note")?.addEventListener("click", () => decide("note", { note: $("#g-remark").value }, "Saved"));
      if ($("#g-accept")) keymap.a = () => decide("accept", {}, "Accepted");
      if ($("#g-ignore")) keymap.i = () => decide("ignore", {}, "Ignored");
    };
    return { html, wire };
  };

  const x = vis[GST_UI.sel];
  const panel = panelFor(x);
  const sm = summary;
  app().innerHTML = topBar([[c.name, `#/c/${c.id}/gstr2b`], [`GSTR-2B ${label}`]], c) + `<div class="bar"><span class="status">${esc(s.kind || "GSTR-2B")} · ${esc(s.gstin || c.gstin || "")} · ${esc(s.filename)}</span><div class="spacer"></div>
      <label class="muted" style="font-size:12.5px">Allow difference <select class="in" id="g-tol" style="width:auto;padding:3px 6px">${[0, 1, 5, 10, 100].map((v) => `<option value="${v}" ${+tol === v ? "selected" : ""}>₹${v}</option>`).join("")}</select></label>
      <button class="btn" id="g-tally" title="Read the purchase register from Tally again">⟳ Read Tally again</button>
      <button class="btn" id="g-sup" ${count.books ? "" : "disabled"}>Message suppliers</button>
      <button class="btn" id="g-xl">Export Excel</button>
      ${featureOn("delete_data") ? `<button class="btn" id="g-del">Delete</button>` : ""}</div>
    <div class="gsthead">
      ${card("ITC as per GSTR-2B", sm.b2b, "lead", sm.itcNo.n ? ` · ${money(sm.itcNo.tax)} not available` : "")}
      ${card("Matched", { n: sm.matched.n + sm.accepted.n, tax: sm.matched.tax + sm.accepted.tax }, "good")}
      ${card("Need a look", { n: sm.mismatch.n + sm.probable.n, tax: sm.mismatch.tax + sm.probable.tax }, sm.mismatch.n + sm.probable.n ? "bad" : "")}
      ${card("Not in Tally · to claim", sm.missing, sm.missing.n ? "warn" : "")}
      ${card("Not in GSTR-2B · at risk", sm.booksOnly, sm.booksOnly.n ? "warn" : "")}
      <div class="note">${tallyNote}${sm.info.n ? `<br><span class="muted">${sm.info.n} import / ISD entries (${money(sm.info.tax)}) are shown but not compared.</span>` : ""}${s.rejected ? `<br><span class="muted">${s.rejected} rejected on IMS — left out.</span>` : ""}</div></div>
    <div class="split bank"><div class="left">
      <div class="filters"><div class="seg">${GST_FILTERS.map(([k, l]) => `<button data-f="${k}" class="${GST_UI.filter === k ? "on" : ""}">${l} <span class="c">${count[k]}</span></button>`).join("")}</div>
        <div class="spacer"></div><input class="in" id="g-q" placeholder="Search supplier, GSTIN, invoice…" style="width:230px" value="${esc(GST_UI.q)}"></div>
      <div id="rows">${vis.length ? `<table class="grid"><thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th class="num">Value</th><th class="num">GST</th><th>Status</th></tr></thead><tbody>${vis.map(row).join("")}</tbody></table>`
        : `<div class="empty">${!ctx.books_at && !q ? "Waiting for the purchase register from Tally…" : GST_UI.filter === "need" ? "Nothing needs a look. ✓" : "Nothing here."}</div>`}</div></div>
      <div class="right" id="panel">${panel.html}</div></div>`;
  wireTop(c);
  panel.wire();
  $$(".seg button[data-f]").forEach((b) => b.onclick = () => { GST_UI.filter = b.dataset.f; GST_UI.sel = 0; route(); });
  $$("#rows tr[data-i]").forEach((tr) => tr.onclick = () => { GST_UI.sel = +tr.dataset.i; route(); });
  const qi = $("#g-q");
  qi.oninput = debounce(() => { GST_UI.q = qi.value; GST_UI.sel = 0; route().then(() => { const n = $("#g-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }, 250);
  keymap.arrowdown = () => { GST_UI.sel = Math.min(vis.length - 1, GST_UI.sel + 1); route(); };
  keymap.arrowup = () => { GST_UI.sel = Math.max(0, GST_UI.sel - 1); route(); };
  $("#g-tol").onchange = async (e) => { await act(() => api(`/gstr2b/${rid}/tolerance`, { body: { tol: +e.target.value } }), "Matching again…"); route(); };
  $("#g-tally").onclick = async () => { await act(() => api(`/gstr2b/${rid}/tally`, { body: {} }), c.tally_status === "ok" ? "Reading from Tally…" : "Queued — runs when TallyPrime is open"); refresh(); };
  if ($("#g-del")) $("#g-del").onclick = async () => { if (confirm(`Delete GSTR-2B ${label} here? Nothing in Tally changes.`)) { await api(`/gstr2b/${rid}`, { method: "DELETE" }); location.hash = `#/c/${c.id}/gstr2b`; } };
  $("#g-xl").onclick = () => gstExport({ c, s, r, sm, label, GM, XW });
  $("#g-sup").onclick = () => gstSuppliers({ c, r, label, GM });
  if (reading) every(4000, refresh);
}

function gstSuppliers({ c, r, label, GM }) {
  const groups = new Map();
  for (const b of r.booksOnly) {
    const k = b.gstin || b.party;
    if (!groups.has(k)) groups.set(k, { party: b.party, gstin: b.gstin, items: [] });
    groups.get(k).items.push(b);
  }
  const list = [...groups.values()].sort((a, z) => z.items.reduce((s, b) => s + b.tax, 0) - a.items.reduce((s, b) => s + b.tax, 0));
  const text = (g) => GM.supplierMessage({ company: c.name, period: label, party: g.party || "Sir / Madam", items: g.items.map((y) => ({ num: y.num || y.number, dt: fmtDate(y.dt), val: y.val, tax: y.tax, why: "not in your GSTR-1 / IFF" })) });
  const bg = modal(`<h2>Invoices your suppliers haven't filed</h2><p class="muted" style="font-size:12.5px;margin-top:-4px">${list.length} supplier${list.length === 1 ? "" : "s"} · a ready message for each</p>
    <div style="max-height:60vh;overflow:auto;margin:0 -4px">${list.map((g, i) => `<div class="supplier"><div><b>${esc(g.party || "—")}</b><div class="muted mono" style="font-size:11.5px">${esc(g.gstin || "no GSTIN")}</div></div>
      <div class="muted" style="font-size:12.5px">${g.items.length} invoice${g.items.length === 1 ? "" : "s"} · ${money(g.items.reduce((s, b) => s + b.tax, 0))} GST</div>
      <div style="display:flex;gap:6px"><button type="button" class="btn sm" data-copy="${i}">Copy</button><a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text(g))}">WhatsApp</a></div></div>`).join("")}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-close>Close</button></div>`, async () => {});
  $(".modal", bg).classList.add("wide");
  $$("[data-copy]", bg).forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(text(list[+b.dataset.copy])); toast("Copied"); } catch { toast("Couldn't copy — use WhatsApp instead", true); } });
}

function gstExport({ c, s, r, sm, label, GM, XW }) {
  const L = GM.HEAD_LABEL;
  const dmy = (iso) => (/^(\d{4})-(\d{2})-(\d{2})$/.test(iso || "") ? iso.split("-").reverse().join("-") : iso || "");
  const lineFor = (name, x) => [name, x.n, x.igst, x.cgst, x.sgst, x.cess, x.tax];
  const summary = [["", "Documents", "IGST", "CGST", "SGST / UTGST", "Cess", "Total GST"],
    lineFor("ITC available as per GSTR-2B", sm.b2b), lineFor("ITC not available as per GSTR-2B", sm.itcNo), lineFor("Matched with Tally", sm.matched), lineFor("Accepted by you", sm.accepted),
    lineFor("Amounts differ", sm.mismatch), lineFor("Invoice no. to check", sm.probable), lineFor("In GSTR-2B, not in Tally", sm.missing),
    lineFor("In Tally, not in GSTR-2B", sm.booksOnly), lineFor("Ignored", sm.ignored), lineFor("Imports / ISD (not compared)", sm.info), [],
    ["Company", c.name], ["GSTIN", s.gstin || c.gstin || ""], ["Return period", label], ["File", s.filename], ["Tolerance", `₹${s.tol ?? 1}`], ["Prepared", new Date().toLocaleString()]];
  const head = ["Status", "Section", "Supplier GSTIN", "Supplier", "Invoice no. (2B)", "Date (2B)", "Note type", "Invoice value (2B)", "Taxable (2B)", "IGST (2B)", "CGST (2B)", "SGST (2B)", "Cess (2B)",
    "ITC available", "Reverse charge", "Tally voucher", "Voucher date", "Supplier invoice (Tally)", "Invoice value (Tally)", "IGST (Tally)", "CGST (Tally)", "SGST (Tally)", "Cess (Tally)", "Differences", "Notes", "Your remark"];
  const recon = [head, ...s.docs.map((d) => {
    const b = d.mid ? r.byMid.get(d.mid) : null;
    return [(GST_STATUS[d.status] || ["", d.status])[1], d.sec, d.ctin, d.name, d.num, dmy(d.dt), d.note === "C" ? "Credit note" : d.note === "D" ? "Debit note" : "", d.val, d.txval, d.igst, d.cgst, d.sgst, d.cess,
      d.itc === "N" ? "No" : "Yes", d.rev ? "Yes" : "No", b ? `${b.vtype || ""} ${b.number || ""}`.trim() : "", dmy(b?.date), b?.num || "", b?.val ?? "", b?.igst ?? "", b?.cgst ?? "", b?.sgst ?? "", b?.cess ?? "",
      (d.diffs || []).map((f) => `${L[f.field] || f.field}: 2B ${f.b2b} / Tally ${f.books}`).join("; "), (d.notes || []).join("; "), d.remark || ""];
  })];
  const books = [["Supplier", "GSTIN", "Supplier invoice", "Invoice date", "Tally voucher", "Voucher date", "Invoice value", "IGST", "CGST", "SGST", "Cess", "Why"],
    ...r.booksOnly.map((b) => [b.party, b.gstin, b.num, dmy(b.dt), `${b.vtype || ""} ${b.number || ""}`.trim(), dmy(b.date), b.val, b.igst, b.cgst, b.sgst, b.cess, b.why || ""])];
  const blob = XW.workbook([
    { name: "Summary", rows: summary, widths: [34, 12, 14, 14, 14, 12, 14] },
    { name: "GSTR-2B vs Tally", rows: recon, widths: [16, 8, 18, 30, 18, 12, 11, 14, 14, 12, 12, 12, 10, 10, 10, 18, 12, 18, 14, 12, 12, 12, 10, 40, 50, 30] },
    { name: "In Tally not in 2B", rows: books, widths: [30, 18, 18, 12, 18, 12, 14, 12, 12, 12, 10, 50] },
  ]);
  XW.download(blob, `GSTR-2B reconciliation ${c.name} ${label}.xlsx`.replace(/[\\/:*?"<>|]/g, " "));
  toast("Excel downloaded");
}
