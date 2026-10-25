/* Additional accounting review screens. Read-only until the user explicitly assigns a ledger. */
"use strict";
const AW_MONEY=x=>money(x);
const AW_NOTICE='<p class="muted small">Read-only review. No Tally entry is created, altered or deleted from these screens.</p>';

async function companyAccounting(c,el,tab){
  if(tab==="actions"){
    const data=await api("/companies/"+c.id+"/action-center");
    const labels={invoices:"Invoice reviews",bank:"Bank issues",marketplace:"Marketplace",purchases:"GSTR-2B purchases",gstr2b:"GST differences",jobs:"Tally errors"};
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
      '<div class="field"><span>Compare</span><div class="seg" id="interScope"><button type="button" data-m="month" class="on">One month</button><button type="button" data-m="fy">Financial year</button></div></div>'+
      '<label class="field" id="icMonthF"><span>Month</span><input type="month" class="in" id="interMonth"></label>'+
      '<label class="field" id="icFyF" hidden><span>Financial year (1 Apr – 31 Mar)</span><select class="in" id="interFy"></select></label>'+
      '<label class="field"><span>In '+esc(c.name)+': the other company\'s ledger</span><input class="in" id="interLedgerA" list="interListA" placeholder="Start typing the ledger name"><datalist id="interListA"></datalist></label>'+
      '<label class="field"><span>In the other company: '+esc(c.name)+'\'s ledger</span><input class="in" id="interLedgerB" list="interListB" placeholder="Start typing the ledger name"><datalist id="interListB"></datalist></label>'+
      '<div class="field" style="grid-column:1/-1"><button class="btn primary" id="compare" style="align-self:flex-start">Read Tally &amp; compare</button></div></div></div>'+
      '<div id="interResult" style="margin-top:14px"></div>';
    const previous=new Date();previous.setMonth(previous.getMonth()-1);
    $("#interMonth",el).value=previous.toISOString().slice(0,7);
    const nowD=new Date(),curFy=nowD.getMonth()>=3?nowD.getFullYear():nowD.getFullYear()-1;
    $("#interFy",el).innerHTML=[0,1,2,3,4,5].map(k=>curFy-k).map(y=>'<option value="'+y+'">FY '+y+'-'+String(y+1).slice(2)+'</option>').join("");
    let icMode="month";
    $$("#interScope button",el).forEach(b=>b.onclick=()=>{
      icMode=b.dataset.m;
      $$("#interScope button",el).forEach(x=>x.classList.toggle("on",x===b));
      $("#icMonthF",el).hidden=icMode!=="month";$("#icFyF",el).hidden=icMode!=="fy";
    });
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
      const body={...(icMode==="fy"?{fy:Number($("#interFy",el).value)}:{period:$("#interMonth",el).value}),ledger_a:$("#interLedgerA",el).value,ledger_b:$("#interLedgerB",el).value};
      try{
        const d=await api("/companies/"+c.id+"/intercompany/"+other+"/refresh",{body});
        const ua=d.unmatched_a.length,ub=d.unmatched_b.length;
        const row=(company,r,why)=>'<tr><td>'+esc(company)+'</td><td>'+esc(r.number||"")+(r.reference?'<div class="muted small">ref '+esc(r.reference)+'</div>':'')+'</td><td>'+fmtDate(r.date)+
          '</td><td class="num">'+AW_MONEY(r.amount)+'</td><td class="small">'+esc(REASON[why]||why||"")+'</td></tr>';
        $("#interResult",el).innerHTML=
          '<div class="out-sum" style="grid-template-columns:repeat(3,1fr)">'+
          '<div class="stat"><div class="k">Agreeing pairs</div><div class="v good">'+d.links.length+'</div><div class="s">'+d.links.filter(l=>l.confidence==="high").length+' by exact reference</div></div>'+
          '<div class="stat"><div class="k">Only in '+esc(d.company_a)+'</div><div class="v '+(ua?"bad":"")+'">'+ua+'</div><div class="s">of '+d.rows_a+' entries in '+esc(d.scope_label||'the month')+'</div></div>'+
          '<div class="stat"><div class="k">Only in '+esc(d.company_b)+'</div><div class="v '+(ub?"bad":"")+'">'+ub+'</div><div class="s">of '+d.rows_b+' entries in '+esc(d.scope_label||'the month')+'</div></div></div>'+
          (d.links.length?'<h3>Agreeing pairs</h3><div class="card flush"><table class="grid"><thead><tr><th>'+esc(d.company_a)+'</th><th>'+esc(d.company_b)+'</th><th class="num">Amount</th><th>How paired</th></tr></thead><tbody>'+
           d.links.map(x=>'<tr><td>'+esc(x.a.number)+' <span class="muted small">'+fmtDate(x.a.date)+'</span></td><td>'+esc(x.b.number)+' <span class="muted small">'+fmtDate(x.b.date)+'</span></td><td class="num">'+AW_MONEY(x.a.amount)+
             (x.amount_diff?'<div class="small warn">differs by '+AW_MONEY(x.amount_diff)+'</div>':'')+'</td><td><span class="conf '+esc(x.confidence)+'">'+esc(x.confidence)+'</span> <span class="muted small">'+
             esc({reference:"same reference",reference_tidied:"reference, ignoring prefix/year/zeros",amount_date:"same amount and date, no reference"}[x.method]||x.method)+'</span></td></tr>').join("")+'</tbody></table></div>':"")+
          (ua||ub?'<h3>Not paired</h3><div class="card flush"><table class="grid"><thead><tr><th>Company</th><th>Voucher</th><th>Date</th><th class="num">Amount</th><th>Why</th></tr></thead><tbody>'+
           [...d.unmatched_a.map(u=>row(d.company_a,u.row,u.reason)),...d.unmatched_b.map(r=>row(d.company_b,r,""))].slice(0,200).join("")+'</tbody></table></div>':
           (d.rows_a+d.rows_b?'<div class="alert ok">Every entry in the period has a partner.</div>':'<div class="alert warn">No entries were found in this period for these two ledgers. Check the period and that you picked the right ledger in each company.</div>'))+
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
    api("/companies/"+c.id+"/masters?kind=ledger&limit=5000"),
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
      '</td><td class="num">'+AW_MONEY(g.total)+'</td><td><select class="in group-ledger" data-search style="min-width:220px">'+options+'</select></td>'+
      '<td class="small"><label><input type="checkbox" class="group-onacct"> On Account</label><br>'+
      '<label><input type="checkbox" class="group-remember" checked> Remember</label></td>'+
      '<td><button class="btn sm" data-assign-group="'+i+'">Assign group ('+g.ids.length+')</button> <button class="btn sm" data-steps-group="'+i+'">One by one</button></td></tr>').join("")+
    '</tbody></table></div>':"";
  app().innerHTML=topBar([[c.name,"#/c/"+c.id+"/bank"],[d.statement.name,"#/s/"+sid],["Reconciliation"]],c)+
    '<div class="page wide"><div class="bar"><h1>Bank Reconciliation</h1><div class="spacer"></div>'+
    '<button class="btn primary" id="stepsAll">Go through transactions one by one</button><button class="btn" id="recheck">Read Tally again</button><a class="btn" href="#/s/'+sid+'">Back to statement</a></div>'+
    '<div class="card"><b>'+d.counts.matched+' reference-confirmed</b> · '+d.counts.suggested+
    ' suggested · '+d.counts.unmatched+' unmatched · '+d.counts.ambiguous+' ambiguous</div>'+
    '<p class="muted small">A matched row is compared in this app only. Reconciliation dates are not written into Tally. '+
    'For entries that already exist, do not post again.</p>'+
    patternsHtml+
    '<div class="card"><b>Assign a reviewed ledger</b> to one selected ready bank transaction. This is a local draft only. '+
    'It does not create a voucher until you separately approve posting from the Bank Statement page.'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">'+
    '<select class="in" id="assignLedger" data-search style="min-width:260px;max-width:420px">'+options+'</select>'+

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
    '<p class="muted small">Type in any ledger box to search all your Tally ledgers.</p></div>';
  wireTop(c);
  patterns.forEach((g,i)=>{
    if(!g.suggested_ledger)return;
    const sel=$('tr[data-group="'+i+'"] .group-ledger');
    if(sel&&[...sel.options].some(o=>o.value===g.suggested_ledger))sel.value=g.suggested_ledger;
  });
  $("#recheck").onclick=()=>route();
  const steps=ids=>openBankSteps({sid,lines:d.lines,ids,ledgers:masters.items,partySugg});
  $("#stepsAll").onclick=()=>steps(null);
  $$("[data-steps-group]").forEach(bt=>bt.onclick=()=>steps(patterns[Number(bt.dataset.stepsGroup)].ids));
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
