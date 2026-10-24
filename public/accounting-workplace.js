/* Additional accounting review screens. Read-only until the user explicitly assigns a ledger. */
"use strict";
const AW_MONEY=x=>money(x);
const AW_NOTICE='<p class="muted small">Read-only review. No Tally entry is created, altered or deleted from these screens.</p>';

async function companyAccounting(c,el,tab){
  if(tab==="actions"){
    const data=await api("/companies/"+c.id+"/action-center");
    const labels={invoices:"Invoice reviews",bank:"Bank issues",marketplace:"Marketplace",purchases:"GSTR-2B purchases",gstr2b:"GST differences",jobs:"Tally errors"};
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
    el.innerHTML='<h2>Inter-Company Reconciliation</h2>'+AW_NOTICE+
      '<p>Compare two company purchase/sales vouchers already read for GST reconciliation. Only exact reciprocal party identities and matching invoice references are considered.</p>'+
      '<div class="card"><label>Compare '+esc(c.name)+' against </label> '+
      '<select id="partner" class="in" style="max-width:300px"><option value="">Choose another company</option>'+
      companies.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join("")+'</select> '+
      '<button class="btn primary" id="compare">Compare cached vouchers</button></div><div id="interResult"></div>';
    $("#compare",el).onclick=async()=>{
      const other=$("#partner",el).value;
      if(!other){toast("Choose another company",true);return;}
      const d=await api("/companies/"+c.id+"/intercompany/"+other);
      $("#interResult",el).innerHTML='<div class="card">Possible reciprocal records: <b>'+d.links.length+
        '</b> · Unmatched in '+esc(d.company_a)+': <b>'+d.unmatched_a.length+'</b> · Unmatched in '+
        esc(d.company_b)+': <b>'+d.unmatched_b.length+'</b></div>'+
       '<p class="muted small">'+esc(d.scope)+'</p>'+
       (d.links.length?'<table class="grid"><tr><th>First company voucher</th><th>Other company voucher</th><th>Amount</th></tr>'+
       d.links.map(x=>'<tr><td>'+esc(x.a.number)+'</td><td>'+esc(x.b.number)+'</td><td>'+AW_MONEY(x.a.amount)+'</td></tr>').join("")+'</table>':"");
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
  const masters=await api("/companies/"+c.id+"/masters?kind=ledger");
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
    '<label><input type="checkbox" id="rememberRule"> Remember narration rule</label>'+
    '<button class="btn primary" id="assign">Assign selected transaction</button></div></div>'+
    (d.lines.length?'<table class="grid"><thead><tr><th></th><th>Date</th><th>Reference / narration</th><th class="num">Amount</th><th>Match</th><th>Ledger</th></tr></thead><tbody>'+
    d.lines.slice(0,1000).map(l=>{
      const m=byId.get(l.id)||{};
      const status=m.status||"—";
      return '<tr><td><input type="radio" name="bankPick" value="'+esc(l.id)+'" '+
        (["ready","failed"].includes(l.status)?"":"disabled")+'></td><td>'+fmtDate(l.date)+'</td>'+
        '<td class="small"><b>'+esc(l.ref)+'</b> '+esc(l.narration)+'</td><td class="num">'+
        AW_MONEY(l.credit?l.credit:-l.debit)+'</td><td>'+esc(status)+'<div class="muted small">'+esc(m.reason||"")+'</div></td>'+
        '<td>'+esc(l.ledger||"")+(l.method==="manual"?" <span class=good>Reviewed</span>":"")+'</td></tr>';
    }).join("")+'</tbody></table>':'<p>No rows.</p>')+
    '<p class="muted small">Ledger options show the first 200 masters. Use search for other masters.</p></div>';
  wireTop(c);
  $("#recheck").onclick=()=>route();
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
    await act(()=>api("/bank/"+sid+"/assign",{body:{ids:[selected.value],ledger,remember:$("#rememberRule").checked}}),"Ledger assigned");
    route();
  };
}
