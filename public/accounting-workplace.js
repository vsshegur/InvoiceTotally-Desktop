/* Additional accounting review screens. Read-only until the user explicitly assigns a ledger. */
"use strict";
const AW_MONEY=x=>money(x);
const AW_NOTICE='<p class="muted small">Read-only review. No Tally entry is created, altered or deleted from these screens.</p>';

async function companyAccounting(c,el,tab){
  if(tab==="settlements")return companySettlements(c,el);
  if(tab==="actions"){
    const data=await api("/companies/"+c.id+"/action-center");
    const labels={invoices:"Invoice reviews",bank:"Bank issues",marketplace:"Marketplace",purchases:"GSTR-2B purchases",gstr2b:"GST differences",jobs:"Tally errors",settlements:"Settlement reviews",overdue:"Overdue bills"};
    el.innerHTML='<h2>Accounting Action Center</h2>'+AW_NOTICE+
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
  if(tab==="outstandings"){
    const render=async()=>{
      const d=await api("/companies/"+c.id+"/outstandings");
      el.innerHTML='<div class="bar"><h2>Outstanding Receipts & Payments</h2><div class="spacer"></div>'+
        '<button class="btn primary" id="refreshOutstanding">Read fresh Tally bills</button></div>'+
        '<div class="card" style="margin-bottom:16px"><b>Receivable '+AW_MONEY(d.totals.receivable)+
        '</b> · <b>Payable '+AW_MONEY(d.totals.payable)+'</b>'+
        '<div class="muted small">Overdue: receivable '+AW_MONEY(d.totals.overdue_receivable)+
        ' / payable '+AW_MONEY(d.totals.overdue_payable)+
        ' · Last reading: '+esc(d.fetched_at?ago(d.fetched_at):"Never")+'</div></div>'+
        (d.rows.length?'<table class="grid"><thead><tr><th>Type</th><th>Party</th><th>Bill</th><th>Due</th><th>Age</th><th class="num">Amount</th></tr></thead><tbody>'+
         d.rows.map(b=>'<tr><td>'+esc(b.side)+'</td><td>'+esc(b.party)+'</td><td>'+esc(b.name)+'</td><td>'+fmtDate(b.due)+
           '</td><td>'+ (b.days_overdue?b.days_overdue+" overdue":"—")+'</td><td class="num">'+AW_MONEY(b.amount)+'</td></tr>').join("")+
         '</tbody></table>':'<div class="card empty">No bill-wise snapshot. Choose “Read fresh Tally bills”.</div>')+
        '<p class="muted small">'+esc(d.note)+'</p>';
      $("#refreshOutstanding",el).onclick=async()=>{
        await act(()=>api("/companies/"+c.id+"/outstandings/refresh",{body:{}}),"Tally bills refreshed");
        await render();
      };
    };return render();
  }
  if(tab==="gstlinks"){
    const data=await api("/companies/"+c.id+"/gst-links");
    el.innerHTML='<h2>GSTR-2B ↔ Uploaded Invoices</h2>'+AW_NOTICE+
     '<p class="muted">Only documents with matching supplier GSTIN, invoice number and amount can be confirmed as source links. Verify the original invoice date, source and Tally posting separately.</p>'+
     (data.rows.length?'<table class="grid"><thead><tr><th>Portal period</th><th>Supplier GSTIN</th><th>Invoice</th><th class="num">Total</th><th>Matched upload</th><th>Action</th></tr></thead><tbody>'+
     data.rows.map(d=>'<tr><td>'+esc(d.period)+'</td><td class="mono small">'+esc(d.ctin)+'</td><td>'+esc(d.num)+'</td><td class="num">'+AW_MONEY(d.val)+'</td>'+
      '<td>'+esc(d.linked?"Confirmed local link":d.level==="unique"?"One candidate":d.level==="ambiguous"?"Multiple candidates":"Not found")+'</td>'+
      '<td>'+(d.linked?'<span class="good">Linked</span>':
        d.candidates.length===1?'<button class="btn sm" data-link="'+esc(d.id)+'" data-iid="'+esc(d.candidates[0].id)+'">Review & link</button>':
        d.candidates.length>1?'<select class="in sm" data-candidates="'+esc(d.id)+'"><option value="">Select invoice</option>'+
         d.candidates.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.number)+' · '+esc(x.status)+' · '+esc(x.date)+'</option>').join("")+
         '</select> <button class="btn sm" data-link="'+esc(d.id)+'">Review & link</button>':"—")+
       '</td></tr>').join("")+'</tbody></table>':'<div class="card empty">No uploaded GSTR-2B documents.</div>');
    $$("[data-link]",el).forEach(bt=>bt.onclick=async()=>{
      const doc=bt.dataset.link;
      const iid=bt.dataset.iid||$('select[data-candidates="'+doc+'"]',el)?.value;
      if(!iid){toast("Select a source invoice",true);return;}
      if(!confirm("I have checked the original source invoice and its GSTIN, number and total. Link locally? This does not post anything to Tally."))return;
      await act(()=>api("/companies/"+c.id+"/gst-links/confirm",{body:{doc_id:doc,invoice_id:iid}}),"Source linked");
      companyAccounting(c,el,"gstlinks");
    });
    return;
  }
  if(tab==="intercompany"){
    const companies=(await api("/companies")).filter(x=>x.id!==c.id);
    el.innerHTML='<h2>Live Inter-Company Ledger Reconciliation</h2>'+AW_NOTICE+
      '<p>Open <b>both</b> companies in Tally. Choose the reciprocal party or current-account ledger in each firm, then compare all vouchers for one month.</p>'+
      '<div class="card"><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:end">'+
      '<label>Other company <select id="partner" class="in" style="max-width:300px"><option value="">Choose company</option>'+
      companies.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join("")+'</select></label>'+
      '<label>Month <input type="month" class="in" id="interMonth"></label>'+
      '<label>In '+esc(c.name)+': other company ledger <input class="in" id="interLedgerA" list="interListA" placeholder="Find exact Tally ledger"><datalist id="interListA"></datalist></label>'+
      '<label>In other company: '+esc(c.name)+' ledger <input class="in" id="interLedgerB" list="interListB" placeholder="Find exact Tally ledger"><datalist id="interListB"></datalist></label>'+
      '<button class="btn primary" id="compare">Read Tally & compare</button></div></div>'+
      '<div id="interResult"></div>';
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
    $("#compare",el).onclick=async()=>{
      const other=$("#partner",el).value;
      if(!other){toast("Choose another company",true);return;}
      const body={period:$("#interMonth",el).value,ledger_a:$("#interLedgerA",el).value,ledger_b:$("#interLedgerB",el).value};
      try{
        const d=await api("/companies/"+c.id+"/intercompany/"+other+"/refresh",{body});
        $("#interResult",el).innerHTML='<div class="card"><b>Possible reciprocal vouchers:</b> '+d.links.length+
          ' · Unmatched in '+esc(d.company_a)+': <b>'+d.unmatched_a.length+'</b> · Unmatched in '+
          esc(d.company_b)+': <b>'+d.unmatched_b.length+'</b>'+
          '<p class="muted small">'+esc(d.scope)+'</p></div>'+
         (d.links.length?'<table class="grid"><tr><th>First company voucher</th><th>Second company voucher</th><th>Amount</th></tr>'+
         d.links.map(x=>'<tr><td>'+esc(x.a.number)+' ('+fmtDate(x.a.date)+')</td><td>'+
          esc(x.b.number)+' ('+fmtDate(x.b.date)+')</td><td>'+AW_MONEY(x.a.amount)+'</td></tr>').join("")+'</table>':"")+
         (d.unmatched_a.length||d.unmatched_b.length?'<h3>Unmatched source entries</h3><table class="grid">'+
          [...d.unmatched_a.map(x=>({company:d.company_a,row:x.row})),
           ...d.unmatched_b.map(x=>({company:d.company_b,row:x}))].slice(0,100).map(x=>
            '<tr><td>'+esc(x.company)+'</td><td>'+esc(x.row.number)+'</td><td>'+fmtDate(x.row.date)+
            '</td><td>'+AW_MONEY(x.row.amount)+'</td></tr>').join("")+'</table>':"");
      }catch(e){toast(e.message,true);}
    };
    return;
  }
  if(tab==="diagnostics"){
    const d=await api("/diagnostics");
    el.innerHTML='<h2>Startup & Recovery Diagnostics</h2>'+AW_NOTICE+
      '<div class="card"><b>Application:</b> '+esc(d.version)+' · <b>Database:</b> '+esc(d.database)+
      ' · <b>Tally:</b> '+esc(d.tally_status)+'<div class="small muted">'+esc(d.tally_detail)+'</div>'+
      '<p><b>Pending:</b> '+d.jobs.pending+' · <b>Uncertain:</b> '+d.jobs.uncertain+
      ' · <b>Failed:</b> '+d.jobs.failed+'</p><p>Backup: '+esc(d.backup_status)+'</p></div>'+
      '<p class="muted">If the database or Tally is unavailable, use the existing verified backup/restore option in This PC. No automatic database reset or replay will occur.</p>';
    return;
  }
}

async function viewBankReconciliation(sid){
  const d=await api("/bank/"+sid+"/reconcile",{body:{}});
  const c=await api("/companies/"+d.statement.company_id);
  CURRENT.company=c;
  const byId=new Map(d.matches.map(m=>[m.id,m]));
  const [masters,billSnapshot,suggestions]=await Promise.all([
    api("/companies/"+c.id+"/masters?kind=ledger"),
    api("/companies/"+c.id+"/outstandings"),
    api("/bank/"+sid+"/suggestions")
  ]);
  const suggestedById=new Map(suggestions.suggestions.map(x=>[x.id,x.suggested]));
  const ledgerNames=masters.items.map(x=>x.name).sort();
  const options='<option value="">Select a ledger</option>'+ledgerNames.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("");
  app().innerHTML=topBar([[c.name,"#/c/"+c.id+"/bank"],[d.statement.name,"#/s/"+sid],["Reconciliation"]],c)+
    '<div class="page wide"><div class="bar"><h1>Bank Reconciliation</h1><div class="spacer"></div>'+
    '<button class="btn" id="recheck">Read Tally again</button><a class="btn" href="#/s/'+sid+'">Back to statement</a></div>'+
    '<div class="card"><b>'+d.counts.matched+' reference-confirmed</b> · '+d.counts.suggested+
    ' suggested · '+d.counts.unmatched+' unmatched · '+d.counts.ambiguous+' ambiguous</div>'+
    '<p class="muted small">A matched row is compared in this app only. Reconciliation dates are not written into Tally. '+
    'For entries that already exist, do not post again.</p>'+
    '<div class="card"><b>Assign a reviewed ledger</b> to one selected ready bank transaction. This is a local draft only. '+
    'It does not create a voucher until you separately approve posting from the Bank Statement page.'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">'+
    '<select class="in" id="assignLedger" style="min-width:220px;max-width:420px">'+options+'</select>'+
    '<input class="in" id="ledgerSearch" placeholder="Find a Tally ledger" style="max-width:240px">'+
    '<input class="in" id="assignBill" list="billOptions" placeholder="Exact outstanding bill (optional)" style="min-width:180px"><datalist id="billOptions"></datalist>'+
    '<label><input type="checkbox" id="onAccount"> Explicitly On Account</label>'+
    '<label><input type="checkbox" id="rememberRule"> Remember narration rule</label>'+
    '<button class="btn primary" id="assign">Assign selected transaction</button></div></div>'+
    (d.lines.length?'<table class="grid"><thead><tr><th></th><th>Date</th><th>Reference / narration</th><th class="num">Amount</th><th>Match</th><th>Ledger</th></tr></thead><tbody>'+
    d.lines.slice(0,1000).map(l=>{
      const m=byId.get(l.id)||{};
      const status=m.status||"—";
      return '<tr><td><input type="radio" name="bankPick" value="'+esc(l.id)+'" '+
        (["ready","failed"].includes(l.status)?"":"disabled")+'></td><td>'+fmtDate(l.date)+'</td>'+
        '<td class="small"><b>'+esc(l.ref)+'</b> '+esc(l.narration)+'</td><td class="num">'+
        AW_MONEY(l.credit?l.credit:-l.debit)+'</td><td>'+esc(status)+'<div class="muted small">'+esc(m.reason||"")+'</div>'+(l.status==="uncertain"?'<button class="btn sm" data-release="'+esc(l.id)+'">Manually verify absent</button>':'')+'</td>'+
        '<td>'+esc(l.ledger||"")+(l.method==="manual"?" <span class=good>Reviewed</span>":"")+
          (suggestedById.get(l.id)?'<div class="small">Suggest: '+esc(suggestedById.get(l.id))+
            ' <button class="btn sm" data-use="'+esc(l.id)+'">Select</button></div>':"")+'</td></tr>';
    }).join("")+'</tbody></table>':'<p>No rows.</p>')+
    '<p class="muted small">Ledger options show the first 200 masters. Use search for other masters.</p></div>';
  wireTop(c);
  $("#recheck").onclick=()=>route();
  $$("[data-release]").forEach(bt=>bt.onclick=async()=>{
    const phrase=prompt("Open the correct company in Tally and verify this bank voucher was NOT created. Type CHECKED IN TALLY to explicitly release it:");
    if(phrase!=="CHECKED IN TALLY"){toast("Manual verification not confirmed",true);return;}
    try{
      await act(()=>api("/bank/"+sid+"/resolve-uncertain",{body:{ids:[bt.dataset.release],confirmed:true,verification:phrase}}),"Entry released for a new review");
      route();
    }catch(e){toast(e.message,true);}
  });

  const fillBills=()=>{
    const ledger=$("#assignLedger").value.toUpperCase();
    $("#billOptions").innerHTML=billSnapshot.rows.filter(x=>String(x.party||"").toUpperCase()===ledger)
       .slice(0,100).map(x=>'<option value="'+esc(x.name)+'"></option>').join("");
  };
  $("#assignLedger").onchange=fillBills;
  document.querySelectorAll("[data-use]").forEach(bt=>bt.onclick=()=>{
    const row=bt.closest("tr");
    const radio=row?.querySelector('input[name="bankPick"]');
    if(radio && !radio.disabled)radio.checked=true;
    const name=suggestedById.get(bt.dataset.use);
    const sel=$("#assignLedger");
    if(![...sel.options].some(o=>o.value===name))sel.add(new Option(name,name));
    sel.value=name;fillBills();
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
      bill_ref:$("#assignBill").value.trim(),on_account:$("#onAccount").checked,
      remember:$("#rememberRule").checked}}),"Ledger assigned");
    route();
  };
}


async function companySettlements(c,el){
  let sheets=[],body=null;
  const previous=await api("/companies/"+c.id+"/settlements");
  el.innerHTML='<h2>Meesho / Flipkart Settlement Reconciliation</h2>'+
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
