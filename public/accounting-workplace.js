/* Additional accounting review screens. Read-only until the user explicitly assigns a ledger. */
"use strict";
const AW_MONEY=x=>money(x);
const AW_NOTICE='<p class="muted small">Read-only review. No Tally entry is created, altered or deleted from these screens.</p>';

async function companyAccounting(c,el,tab){
  if(tab==="settlements")return companySettlements(c,el);
  if(tab==="actions"){
    const data=await api("/companies/"+c.id+"/action-center");
    const labels={invoices:"Invoice reviews",bank:"Bank issues",marketplace:"Marketplace",purchases:"GSTR-2B purchases",gstr2b:"GST differences",jobs:"Tally errors",settlements:"Settlement reviews"};
    el.innerHTML=AW_NOTICE+
      '<div class="card"><div class="stats" style="display:flex;gap:18px;flex-wrap:wrap">'+
      Object.entries(data.counts).map(([k,v])=>'<div><b>'+v+'</b><div class="muted small">'+esc(labels[k]||k)+'</div></div>').join("")+
      '</div></div><h3>Needs attention</h3>'+
      (data.items.length?'<table class="grid"><thead><tr><th>Area</th><th>Issue</th><th>Details</th><th></th></tr></thead><tbody>'+
      data.items.map(r=>'<tr><td>'+esc(r.kind)+'</td><td>'+esc(r.label)+'</td><td class="small">'+esc(r.description)+'</td>'+
        '<td><a class="btn sm" href="'+esc(r.link)+'">Review</a></td></tr>').join("")+'</tbody></table>':
      '<div class="card empty">No issues in the local accounting work queue.</div>')+
      '<p class="muted small">'+esc(data.note)+'</p>';
    return;
  }
  if(tab==="intercompany"){
    const companies=(await api("/companies")).filter(x=>x.id!==c.id);
    el.innerHTML=
      '<p class="muted">Open <b>both</b> companies in Tally. Pick the ledger each keeps for the other, then compare one month. Entries are paired by reference, amount (within ₹1 for round-off) and date (within 10 days); anything left over is listed with the reason.</p>'+
      '<div class="card"><div class="ic-form">'+
      '<label class="field"><span>Other company</span><select id="partner" class="in"><option value="">Choose company</option>'+
      companies.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join("")+'</select></label>'+
      '<label class="field"><span>Month</span><input type="month" class="in" id="interMonth"></label>'+
      '<label class="field"><span>In '+esc(c.name)+': the other company\'s ledger</span><input class="in" id="interLedgerA" list="interListA" placeholder="Start typing the ledger name"><datalist id="interListA"></datalist></label>'+
      '<label class="field"><span>In the other company: '+esc(c.name)+'\'s ledger</span><input class="in" id="interLedgerB" list="interListB" placeholder="Start typing the ledger name"><datalist id="interListB"></datalist></label>'+
      '<div class="field" style="grid-column:1/-1"><button class="btn primary" id="compare" style="align-self:flex-start">Read Tally &amp; compare</button></div></div></div>'+
      '<div id="interResult" style="margin-top:14px"></div>';
    const previous=new Date();previous.setMonth(previous.getMonth()-1);
    $("#interMonth",el).value=previous.toISOString().slice(0,7);
    const fill=async(companyId,text,listId)=>{
      if(!companyId)return;
      const d=await api("/companies/"+companyId+"/masters?kind=ledger&q="+encodeURIComponent(text||""),{quiet:true});
      const target=$("#"+listId,el);if(target)target.innerHTML=d.items.map(x=>'<option value="'+esc(x.name)+'"></option>').join("");
    };
    $("#partner",el).onchange=()=>{
      $("#interLedgerB",el).value="";fill($("#partner",el).value,"","interListB").catch(e=>toast(e.message,true));
    };
    $("#interLedgerA",el).oninput=debounce(()=>fill(c.id,$("#interLedgerA",el).value,"interListA"),220);
    $("#interLedgerB",el).oninput=debounce(()=>fill($("#partner",el).value,$("#interLedgerB",el).value,"interListB"),220);
    fill(c.id,"","interListA").catch(()=>{});
    const REASON={no_entry_with_this_amount:"No entry for this amount on the other side",
      same_amount_but_reference_differs:"Same amount on the other side, but the references differ and several dates or entries compete — check by hand",
      same_amount_but_date_too_far:"Same amount exists on the other side, but more than 10 days apart"};
    $("#compare",el).onclick=async()=>{
      const other=$("#partner",el).value;
      if(!other){toast("Choose the other company",true);return;}
      const body={period:$("#interMonth",el).value,ledger_a:$("#interLedgerA",el).value,ledger_b:$("#interLedgerB",el).value};
      try{
        const d=await api("/companies/"+c.id+"/intercompany/"+other+"/refresh",{body});
        const ua=d.unmatched_a.length,ub=d.unmatched_b.length;
        const row=(company,r,why)=>'<tr><td>'+esc(company)+'</td><td>'+esc(r.number||"")+(r.reference?'<div class="muted small">ref '+esc(r.reference)+'</div>':'')+'</td><td>'+fmtDate(r.date)+
          '</td><td class="num">'+AW_MONEY(r.amount)+'</td><td class="small">'+esc(REASON[why]||why||"")+'</td></tr>';
        $("#interResult",el).innerHTML=
          '<div class="out-sum" style="grid-template-columns:repeat(3,1fr)">'+
          '<div class="stat"><div class="k">Agreeing pairs</div><div class="v good">'+d.links.length+'</div><div class="s">'+d.links.filter(l=>l.confidence==="high").length+' by exact reference</div></div>'+
          '<div class="stat"><div class="k">Only in '+esc(d.company_a)+'</div><div class="v '+(ua?"bad":"")+'">'+ua+'</div><div class="s">of '+d.rows_a+' entries this month</div></div>'+
          '<div class="stat"><div class="k">Only in '+esc(d.company_b)+'</div><div class="v '+(ub?"bad":"")+'">'+ub+'</div><div class="s">of '+d.rows_b+' entries this month</div></div></div>'+
          (d.links.length?'<h3>Agreeing pairs</h3><div class="card flush"><table class="grid"><thead><tr><th>'+esc(d.company_a)+'</th><th>'+esc(d.company_b)+'</th><th class="num">Amount</th><th>How paired</th></tr></thead><tbody>'+
           d.links.map(x=>'<tr><td>'+esc(x.a.number)+' <span class="muted small">'+fmtDate(x.a.date)+'</span></td><td>'+esc(x.b.number)+' <span class="muted small">'+fmtDate(x.b.date)+'</span></td><td class="num">'+AW_MONEY(x.a.amount)+
             (x.amount_diff?'<div class="small warn">differs by '+AW_MONEY(x.amount_diff)+'</div>':'')+'</td><td><span class="conf '+esc(x.confidence)+'">'+esc(x.confidence)+'</span> <span class="muted small">'+
             esc({reference:"same reference",reference_tidied:"reference, ignoring prefix/year/zeros",amount_date:"same amount and date, no reference"}[x.method]||x.method)+'</span></td></tr>').join("")+'</tbody></table></div>':"")+
          (ua||ub?'<h3>Not paired</h3><div class="card flush"><table class="grid"><thead><tr><th>Company</th><th>Voucher</th><th>Date</th><th class="num">Amount</th><th>Why</th></tr></thead><tbody>'+
           [...d.unmatched_a.map(u=>row(d.company_a,u.row,u.reason)),...d.unmatched_b.map(r=>row(d.company_b,r,""))].slice(0,200).join("")+'</tbody></table></div>':
           (d.rows_a+d.rows_b?'<div class="alert ok">Every entry in the month has a partner.</div>':'<div class="alert warn">No entries were found in this month for these two ledgers. Check the month and that you picked the right ledger in each company.</div>'))+
          '<p class="muted small" style="margin-top:10px">'+esc(d.scope)+'</p>';
      }catch(e){toast(e.message,true);}
    };
    return;
  }
  if(tab==="diagnostics"){
    const d=await api("/diagnostics");
    const tone=d.tally_status==="ok"?"good":"bad";
    el.innerHTML=
      '<div class="out-sum" style="grid-template-columns:repeat(4,1fr)">'+
      '<div class="stat"><div class="k">Application</div><div class="v" style="font-size:17px">'+esc(d.version)+'</div><div class="s">Database: '+esc(d.database)+'</div></div>'+
      '<div class="stat"><div class="k">Tally</div><div class="v '+tone+'" style="font-size:17px">'+esc(d.tally_status==="ok"?"Connected":d.tally_status)+'</div><div class="s">'+esc(d.tally_detail||"")+'</div></div>'+
      '<div class="stat"><div class="k">Entries to send</div><div class="v" style="font-size:15px">'+d.jobs.pending+' waiting · '+d.jobs.uncertain+' uncertain</div><div class="s">'+d.jobs.failed+' failed</div></div>'+
      '<div class="stat"><div class="k">Backup</div><div class="v" style="font-size:14px">'+esc(d.backup_status)+'</div></div></div>'+
      '<p class="muted">If the database or Tally is unavailable, use the verified backup and restore option under <a href="#/account"><u>This PC</u></a>. Nothing is reset or replayed automatically.</p>';
    return;
  }
}

async function viewBankReconciliation(sid){
  const d=await api("/bank/"+sid+"/reconcile",{body:{}});
  const c=await api("/companies/"+d.statement.company_id);
  CURRENT.company=c;
  const byId=new Map(d.matches.map(m=>[m.id,m]));
  const [masters,suggestions,partySugg,patterns]=await Promise.all([
    api("/companies/"+c.id+"/masters?kind=ledger"),
    api("/bank/"+sid+"/suggestions"),
    api("/bank/"+sid+"/party-suggestions"),
    api("/bank/"+sid+"/patterns")
  ]);
  const suggestedById=new Map(suggestions.suggestions.map(x=>[x.id,x.suggested]));
  // A single combined lookup for the row-level "Select" button: a remembered narration rule
  // wins over a fuzzy party-name match, since the rule was explicitly approved before.
  const pickFor=id=>suggestedById.get(id)||partySugg[id]?.[0]?.name||null;
  const ledgerNames=masters.items.map(x=>x.name).sort();
  const options='<option value="">Select a ledger</option>'+ledgerNames.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("");
  const patternsHtml=patterns.length?
    '<div class="card"><b>Detected recurring patterns</b> — the same counterparty narration, seen more than once in this statement. '+
    'Pick a ledger once and assign every matching transaction together, instead of one at a time.'+
    '<table class="grid"><thead><tr><th>Pattern</th><th class="num">Count</th><th class="num">Total</th><th>Ledger</th><th></th><th></th></tr></thead><tbody>'+
    patterns.map((g,i)=>'<tr data-group="'+i+'"><td class="small">'+esc(g.sample)+'</td><td class="num">'+g.ids.length+
      '</td><td class="num">'+AW_MONEY(g.total)+'</td><td><select class="in group-ledger" style="min-width:200px">'+options+'</select></td>'+
      '<td class="small"><label><input type="checkbox" class="group-onacct"> On Account</label><br>'+
      '<label><input type="checkbox" class="group-remember" checked> Remember</label></td>'+
      '<td><button class="btn sm" data-assign-group="'+i+'">Assign group ('+g.ids.length+')</button></td></tr>').join("")+
    '</tbody></table></div>':"";
  app().innerHTML=topBar([[c.name,"#/c/"+c.id+"/bank"],[d.statement.name,"#/s/"+sid],["Reconciliation"]],c)+
    '<div class="page wide"><div class="bar"><h1>Bank Reconciliation</h1><div class="spacer"></div>'+
    '<button class="btn" id="recheck">Read Tally again</button><a class="btn" href="#/s/'+sid+'">Back to statement</a></div>'+
    '<div class="card"><b>'+d.counts.matched+' reference-confirmed</b> · '+d.counts.suggested+
    ' suggested · '+d.counts.unmatched+' unmatched · '+d.counts.ambiguous+' ambiguous</div>'+
    '<p class="muted small">A matched row is compared in this app only. Reconciliation dates are not written into Tally. '+
    'For entries that already exist, do not post again.</p>'+
    patternsHtml+
    '<div class="card"><b>Assign a reviewed ledger</b> to one selected ready bank transaction. This is a local draft only. '+
    'It does not create a voucher until you separately approve posting from the Bank Statement page.'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">'+
    '<select class="in" id="assignLedger" style="min-width:220px;max-width:420px">'+options+'</select>'+
    '<input class="in" id="ledgerSearch" placeholder="Find a Tally ledger" style="max-width:240px">'+

    '<label><input type="checkbox" id="onAccount"> Explicitly On Account</label>'+
    '<label><input type="checkbox" id="rememberRule"> Remember narration rule</label>'+
    '<button class="btn primary" id="assign">Assign selected transaction</button>'+
    '<button class="btn" id="allocateBills">Allocate to open bills…</button></div></div>'+
    (d.lines.length?'<table class="grid"><thead><tr><th></th><th>Date</th><th>Reference / narration</th><th class="num">Amount</th><th>Match</th><th>Ledger</th></tr></thead><tbody>'+
    d.lines.slice(0,1000).map(l=>{
      const m=byId.get(l.id)||{};
      const status=m.status||"—";
      const pick=pickFor(l.id);
      return '<tr><td><input type="radio" name="bankPick" value="'+esc(l.id)+'" '+
        (["ready","failed"].includes(l.status)?"":"disabled")+'></td><td>'+fmtDate(l.date)+'</td>'+
        '<td class="small"><b>'+esc(l.ref)+'</b> '+esc(l.narration)+'</td><td class="num">'+
        AW_MONEY(l.credit?l.credit:-l.debit)+'</td><td>'+esc(status)+'<div class="muted small">'+esc(m.reason||"")+'</div>'+(l.status==="uncertain"?'<button class="btn sm" data-release="'+esc(l.id)+'">Manually verify absent</button>':'')+'</td>'+
        '<td>'+esc(l.ledger||"")+(l.method==="manual"?" <span class=good>Reviewed</span>":"")+
          (pick?'<div class="small">'+(suggestedById.get(l.id)?"Suggest":"Party match")+': '+esc(pick)+
            ' <button class="btn sm" data-use="'+esc(l.id)+'">Select</button></div>':"")+'</td></tr>';
    }).join("")+'</tbody></table>':'<p>No rows.</p>')+
    '<p class="muted small">Ledger options show the first 200 masters. Use search for other masters.</p></div>';
  wireTop(c);
  patterns.forEach((g,i)=>{
    if(!g.suggested_ledger)return;
    const sel=$('tr[data-group="'+i+'"] .group-ledger');
    if(sel&&[...sel.options].some(o=>o.value===g.suggested_ledger))sel.value=g.suggested_ledger;
  });
  $("#recheck").onclick=()=>route();
  $$("[data-release]").forEach(bt=>bt.onclick=async()=>{
    const phrase=prompt("Open the correct company in Tally and verify this bank voucher was NOT created. Type CHECKED IN TALLY to explicitly release it:");
    if(phrase!=="CHECKED IN TALLY"){toast("Manual verification not confirmed",true);return;}
    try{
      await act(()=>api("/bank/"+sid+"/resolve-uncertain",{body:{ids:[bt.dataset.release],confirmed:true,verification:phrase}}),"Entry released for a new review");
      route();
    }catch(e){toast(e.message,true);}
  });

  document.querySelectorAll("[data-use]").forEach(bt=>bt.onclick=()=>{
    const row=bt.closest("tr");
    const radio=row?.querySelector('input[name="bankPick"]');
    if(radio && !radio.disabled)radio.checked=true;
    const name=pickFor(bt.dataset.use);
    const sel=$("#assignLedger");
    if(![...sel.options].some(o=>o.value===name))sel.add(new Option(name,name));
    sel.value=name;
  });

  $$("[data-assign-group]").forEach(bt=>bt.onclick=async()=>{
    const i=Number(bt.dataset.assignGroup);
    const g=patterns[i];
    const row=bt.closest("tr");
    const ledger=row.querySelector(".group-ledger").value;
    if(!ledger){toast("Choose a ledger for this group",true);return;}
    if(!confirm("Assign all "+g.ids.length+" transactions in this group to \""+ledger+"\"?"))return;
    try{
      await act(()=>api("/bank/"+sid+"/assign",{body:{ids:g.ids,ledger,
        on_account:row.querySelector(".group-onacct").checked,
        remember:row.querySelector(".group-remember").checked}}),"Group of "+g.ids.length+" assigned to "+ledger);
      route();
    }catch(e){toast(e.message,true);}
  });

  $("#ledgerSearch").oninput=debounce(async()=>{
    const q=$("#ledgerSearch").value.trim();
    const x=await api("/companies/"+c.id+"/masters?kind=ledger&q="+encodeURIComponent(q),{quiet:true});
    const sel=$("#assignLedger");sel.innerHTML='<option value="">Select a ledger</option>'+
      x.items.map(y=>'<option value="'+esc(y.name)+'">'+esc(y.name)+'</option>').join("");
  },220);
  $("#assign").onclick=async()=>{
    const selected=$('input[name="bankPick"]:checked');
    const ledger=$("#assignLedger").value;
    if(!selected||!ledger){toast("Select one ready bank entry and a Tally ledger",true);return;}
    if(!confirm("Confirm you checked this transaction against the bank statement and selected the correct existing Tally ledger?"))return;
    await act(()=>api("/bank/"+sid+"/assign",{body:{ids:[selected.value],ledger,
      on_account:$("#onAccount").checked,
      remember:$("#rememberRule").checked}}),"Ledger assigned");
    route();
  };
  $("#allocateBills").onclick=async()=>{
    const selected=$('input[name="bankPick"]:checked');
    const ledger=$("#assignLedger").value;
    if(!selected||!ledger){toast("Select one ready bank entry and a party ledger first",true);return;}
    const line=d.lines.find(x=>x.id===selected.value);
    let read;
    try{read=await api("/bank/"+sid+"/outstanding-bills",{body:{ledger}});}
    catch(e){toast(e.message,true);return;}
    openBillAllocationModal(sid,line,ledger,read.bills,read.notice);
  };
}

// Live bill-wise allocation: pick which open bill(s) of a party ledger a receipt/payment settles,
// leaving any uncovered amount On Account (matches bankVoucher()'s own Agst Ref / On Account split).
function openBillAllocationModal(sid,line,ledger,bills,notice){
  const amount=line.credit?line.credit:line.debit;
  const rows=bills.map((b,i)=>'<tr><td><input type="checkbox" class="bill-use" data-i="'+i+'"></td>'+
    '<td>'+esc(b.name)+'</td><td>'+fmtDate(b.date)+'</td><td class="num">'+money(b.amount)+'</td>'+
    '<td><input class="in bill-amt" data-i="'+i+'" style="width:100px" value="'+Math.min(b.amount,amount).toFixed(2)+'"></td></tr>').join("");
  let box;
  box=modal('<h2>Allocate against open bills — '+esc(ledger)+'</h2>'+
    '<p class="muted small">Transaction amount: '+money(amount)+'. '+esc(notice)+'</p>'+
    (bills.length?'<table class="grid"><thead><tr><th></th><th>Bill</th><th>Date</th><th class="num">Open</th><th>Allocate</th></tr></thead><tbody>'+rows+'</tbody></table>':
      '<p class="muted">No open bills were found for this ledger.</p>')+
    '<p class="muted small">Any part of the transaction not allocated to a bill above is posted On Account, same as today.</p>'+
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">'+
    '<button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Allocate</button></div>',
    async()=>{
      const picked=[];
      $$(".bill-use",box).forEach(cb=>{
        if(!cb.checked)return;
        const i=Number(cb.dataset.i);
        const amt=Number($('.bill-amt[data-i="'+i+'"]',box)?.value||0);
        if(amt>0)picked.push({name:bills[i].name,amount:amt});
      });
      if(!picked.length)throw new Error("Select at least one bill and enter an amount");
      const r=await api("/bank/"+sid+"/allocate-bills",{body:{id:line.id,ledger,bills:picked}});
      toast("Allocated "+money(r.allocated)+(r.residual>0.004?"; "+money(r.residual)+" left On Account":""));
      route();
    });
}


async function companySettlements(c,el){
  let sheets=[],body=null;
  const previous=await api("/companies/"+c.id+"/settlements");
  el.innerHTML=
    '<div class="alert info">Offline settlement review: select the exact report columns yourself. Marketplace files differ between versions. '+
    'Nothing is posted to Tally; you can compare payout groups with imported bank transactions.</div>'+
    '<div class="card"><h3>1. Select settlement workbook</h3>'+
    '<div style="display:flex;flex-wrap:wrap;gap:12px">'+
    '<label>Marketplace <select class="in" id="setPlatform"><option value="ME">Meesho</option><option value="FL">Flipkart</option></select></label>'+
    '<label>Report month <input class="in" type="month" id="setPeriod"></label>'+
    '<label>Excel file <input class="in" type="file" id="setFile" accept=".xlsx,.xlsm"></label></div>'+
    '<p class="muted small">Use the marketplace settlement/payment report, not the monthly GST sales report. Old .xls files must be saved as .xlsx first.</p>'+
    '<div id="setMapper"></div><div id="setPreview"></div></div>'+
    '<h3>Saved reports</h3><div id="setSaved">'+
    (previous.length?'<table class="grid"><thead><tr><th>Month</th><th>Source</th><th>Groups</th><th class="num">Payout</th><th class="num">Difference</th><th>Action</th></tr></thead><tbody>'+
    previous.map(r=>'<tr><td>'+esc(r.period)+'</td><td>'+esc(r.source_name)+' · '+esc(r.platform)+'</td><td>'+r.groups+
      '</td><td class="num">'+AW_MONEY(r.payout)+'</td><td class="num">'+AW_MONEY(r.difference)+'</td>'+
      '<td><button class="btn sm" data-set-match="'+esc(r.id)+'">Find bank payouts</button></td></tr>').join("")+'</tbody></table>':
     '<div class="card empty">No settlement reports saved.</div>')+'</div><div id="setBankMatches"></div>';
  $("#setPeriod",el).value=new Date().toISOString().slice(0,7);
  function renderMapping(){
    const sheetNo=Number($("#setSheet",el)?.value||0);
    const source=sheets[sheetNo];if(!source)return;
    const max=Math.min(source.rows.length-1,50),head=Math.min(max,Number($("#setHeader",el)?.value||0));
    const headers=source.rows[head]||[];
    const names=[["settlement_id","Settlement / payment ID (required)"],["date","Settlement / transaction date"],
      ["gross","Gross sales including GST (required)"],["refund","Refunds / returns deducted"],
      ["commission","Marketplace commission"],["shipping","Shipping fees deducted"],
      ["other","Other marketplace deductions"],["tcs","TCS withheld"],["tds","TDS withheld"],
      ["payout","Bank payout amount (required)"]];
    const choose='<option value="">Not present / unmapped</option>'+
      headers.map((h,i)=>'<option value="'+i+'">'+esc(String(h||"Column "+(i+1)).slice(0,90))+'</option>').join("");
    $("#setMapFields",el).innerHTML='<h3>2. Map source columns</h3>'+
      '<div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px">'+
      names.map(([key,label])=>'<label>'+esc(label)+'<select class="in" data-set-field="'+key+'">'+choose+'</select></label>').join("")+
      '</div><p class="muted small">Unmapped deductions are displayed in the results so differences are never silently treated as correct.</p>'+
      '<label>Payout column meaning <select class="in" id="setMode">'+
        '<option value="">Choose the report layout</option>'+
        '<option value="per_row">A separate payout amount on every order/row</option>'+
        '<option value="per_settlement">The same total payout repeated for all rows of a settlement ID</option>'+
      '</select></label> <button class="btn primary" id="setAnalyze">Analyze locally</button>';
    $("#setAnalyze",el).onclick=async()=>{
      const mapping={};
      $$("[data-set-field]",el).forEach(s=>{if(s.value!=="")mapping[s.dataset.setField]=Number(s.value);});
      const mode=$("#setMode",el).value;
      body={platform:$("#setPlatform",el).value,period:$("#setPeriod",el).value,filename:$("#setFile",el).files[0].name,
        rows:[headers,...source.rows.slice(head+1).filter(r=>r.some(v=>String(v??"").trim()))].slice(0,10001),
        mapping,payout_mode:mode};
      try{
        const report=await api("/companies/"+c.id+"/settlements/analyze",{body});
        const bad=report.groups.filter(x=>!x.balanced).length;
        $("#setPreview",el).innerHTML='<div class="card"><h3>3. Review reconciliation</h3>'+
          '<p><b>'+report.groups.length+' settlement groups</b> · Gross '+AW_MONEY(report.totals.gross)+
          ' · Computed '+AW_MONEY(report.totals.expected)+' · Reported payout '+AW_MONEY(report.totals.payout)+
          ' · Difference '+AW_MONEY(report.totals.difference)+'</p>'+
          '<p class="muted">Unmapped: '+esc(report.unmapped.join(", ")||"None")+
          ' · Non-balancing groups: '+bad+' · Invalid source rows: '+report.issues.length+'</p>'+
          (report.groups.length?'<table class="grid"><tr><th>Settlement ID</th><th>Rows</th><th class="num">Expected</th><th class="num">Reported</th><th class="num">Difference</th></tr>'+
          report.groups.slice(0,100).map(g=>'<tr><td>'+esc(g.id)+'</td><td>'+g.rows+'</td><td class="num">'+AW_MONEY(g.expected)+
           '</td><td class="num">'+AW_MONEY(g.payout)+'</td><td class="num">'+AW_MONEY(g.difference)+'</td></tr>').join("")+'</table>':"")+
          '<p class="muted small">'+esc(report.notice)+'</p>'+
          '<label><input type="checkbox" id="setReviewed"> I reviewed source columns and understand that this is not a Tally posting</label>'+
          ' <button class="btn primary" id="setSave">Save report for bank comparison</button></div>';
        $("#setSave",el).onclick=async()=>{
          if(!$("#setReviewed",el).checked){toast("Confirm the source-column review first",true);return;}
          if(!confirm("Save this reviewed settlement analysis locally? No Tally entry will be created."))return;
          const result=await api("/companies/"+c.id+"/settlements/save",{body:{...body,confirmed:true}});
          toast(result.existing?"Report already saved":"Settlement report saved");
          await companySettlements(c,el);
        };
      }catch(e){toast(e.message,true);}
    };
  }
  $("#setFile",el).onchange=async()=>{
    const file=$("#setFile",el).files?.[0];if(!file)return;
    try{
      sheets=await Ingest.workbook(file);
      $("#setMapper",el).innerHTML='<div style="display:flex;gap:12px;flex-wrap:wrap">'+
        '<label>Sheet <select class="in" id="setSheet">'+sheets.map((s,i)=>'<option value="'+i+'">'+esc(s.name)+'</option>').join("")+'</select></label>'+
        '<label>Header row <select class="in" id="setHeader">'+Array.from({length:Math.min(50,sheets[0].rows.length)},(_,i)=>
          '<option value="'+i+'">'+(i+1)+'</option>').join("")+'</select></label></div><div id="setMapFields"></div>';
      $("#setSheet",el).onchange=()=>{const source=sheets[Number($("#setSheet",el).value)];$("#setHeader",el).innerHTML=
        Array.from({length:Math.min(50,source.rows.length)},(_,i)=>'<option value="'+i+'">'+(i+1)+'</option>').join("");renderMapping();};
      $("#setHeader",el).onchange=renderMapping;
      renderMapping();
    }catch(e){toast("Could not read Excel: "+e.message,true);}
  };
  $$("[data-set-match]",el).forEach(bt=>bt.onclick=async()=>{
    const result=await api("/companies/"+c.id+"/settlements/"+bt.dataset.setMatch+"/bank-matches",{body:{}});
    $("#setBankMatches",el).innerHTML='<div class="card"><h3>Candidate bank payouts</h3>'+
      '<p class="muted small">'+esc(result.warning)+'</p>'+
      '<table class="grid"><thead><tr><th>Settlement</th><th>Payout</th><th>Match quality</th><th>Bank candidates</th></tr></thead><tbody>'+
      result.matches.slice(0,150).map(g=>'<tr><td>'+esc(g.id)+'</td><td>'+AW_MONEY(g.payout)+'</td><td>'+
        esc(g.match)+'</td><td>'+g.bank_candidates.map(x=>fmtDate(x.date)+' · '+esc(x.ref||x.narration)).join(" / ")+'</td></tr>').join("")+
      '</tbody></table></div>';
  });
}

// Combined inbox across every company owned by the currently signed-in user.
async function viewGlobalActionCenter(){
  const companies=await api("/companies");
  const all=await Promise.all(companies.map(async c=>{
    try{return {company:c,review:await api("/companies/"+c.id+"/action-center")};}
    catch(e){return {company:c,error:e.message};}
  }));
  const items=all.flatMap(x=>(x.review?.items||[]).map(item=>({...item,
    company:x.company.name,companyId:x.company.id})));
  const total=items.length;
  app().innerHTML=topBar([["Accounting Action Center"]])+
    '<div class="page wide"><div class="bar"><h1>Accounting Action Center</h1><div class="spacer"></div>'+
    '<button class="btn" id="reloadGlobal">Refresh</button></div>'+
    '<p class="muted">Combined exceptions from your local Tally companies. This is not a reconciliation-complete certificate; refresh each source before closing accounts.</p>'+
    '<div class="card"><b>'+total+' items to review</b> across '+companies.length+' accessible companies</div>'+
    (all.some(x=>x.error)?'<div class="alert warn">'+all.filter(x=>x.error).map(x=>esc(x.company.name)+': '+esc(x.error)).join('; ')+'</div>':'')+
    (items.length?'<table class="grid"><thead><tr><th>Company</th><th>Area</th><th>Issue</th><th>Description</th><th></th></tr></thead><tbody>'+
      items.slice(0,600).map(x=>'<tr><td>'+esc(x.company)+'</td><td>'+esc(x.kind)+'</td><td>'+esc(x.label)+'</td>'+
      '<td class="small">'+esc(x.description)+'</td><td><a class="btn sm" href="'+esc(x.link)+'">Review</a></td></tr>').join("")+
      '</tbody></table>':'<div class="card empty">No locally recorded exceptions for your accessible companies.</div>')+
    '</div>';
  wireTop();
  $("#reloadGlobal").onclick=()=>route();
}
