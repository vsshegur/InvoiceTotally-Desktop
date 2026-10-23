// GSTR-2B purchase/debit-note posting. Existing invoice reader remains independent.
"use strict";
const g2bMoney=n=>Number(n||0).toLocaleString("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2});
const G2B_UI={id:"",page:0,selected:new Set(),approved:false,dateApproved:false,busy:false};
async function viewGstr2bPurchaseChoose(cid){
  const [c,returns,batches]=await Promise.all([
    api("/companies/"+cid),api("/companies/"+cid+"/gstr2b"),api("/companies/"+cid+"/gstr2b-purchases")
  ]);
  const prepared=new Map(batches.map(x=>[x.return_id,x.id]));
  app().innerHTML=topBar([[c.name,"#/c/"+cid],["Invoices","#/c/"+cid],["Upload GSTR-2B"]],c)+
    '<div class="bar"><span class="status">GSTR-2B → Purchase / Debit Note in Tally</span><div class="spacer"></div>'+
    '<a class="btn" href="#/c/'+cid+'">Back</a> '+
    '<a class="btn primary" href="#/c/'+cid+'/gstr2b-purchase/upload">Upload GSTR-2B Excel/JSON</a></div>'+
    '<div class="page wide"><h1>Prepare Tally vouchers from GSTR-2B</h1>'+
    '<div class="card" style="padding:14px;margin:12px 0"><b>Fixed purchase ledger: PURCHASE-GSTR2B</b>'+
    '<p class="muted small">Ordinary B2B invoices create Purchase vouchers. Supplier credit notes create Debit Notes that reverse the purchase and Input GST amounts. '+
    'For an ECO/Flipkart credit document, you must explicitly verify and classify it as a supplier credit first. '+
    'No stock items or quantities are invented. Nothing posts without your confirmation.</p></div><h3>Use an imported GSTR-2B return</h3>'+
    (returns.some(r=>r.kind==="GSTR-2B"&&r.stage!=="uploading")?
      '<table class="grid"><thead><tr><th>Return month</th><th>Portal file</th><th>Documents</th><th>Action</th></tr></thead><tbody>'+
      returns.filter(r=>r.kind==="GSTR-2B"&&r.stage!=="uploading").map(r=>
        '<tr><td>'+esc(r.period)+'</td><td>'+esc(r.filename||"")+'</td><td>'+r.docs+'</td>'+
        '<td><button class="btn sm primary" data-prepare="'+esc(r.id)+'">'+
        (prepared.has(r.id)?"Open prepared vouchers":"Prepare vouchers")+'</button></td></tr>').join("")+'</tbody></table>':
      '<div class="card empty">No saved GSTR-2B. Upload the official portal Excel or JSON file to begin.</div>')+
    (batches.length?'<h3 style="margin-top:20px">Prepared batches</h3>'+
      batches.map(b=>'<p><a class="btn sm" href="#/p2b/'+esc(b.id)+'">'+esc(b.period)+
        ' · '+esc(b.filename||"GSTR-2B")+'</a> <span class="muted">'+
        Object.entries(b.counts||{}).map(([k,v])=>esc(k)+": "+v).join(" · ")+'</span></p>').join(""):'')+'</div>';
  wireTop(c);
  $$("[data-prepare]").forEach(btn=>btn.onclick=async()=>{
    btn.disabled=true;
    try{
      const r=await api("/companies/"+cid+"/gstr2b-purchases/prepare",{body:{return_id:btn.dataset.prepare}});
      location.hash="#/p2b/"+r.id;
    }catch(e){btn.disabled=false;toast(e.message,true);}
  });
}
async function viewGstr2bPurchaseBatch(id){
  const d=await api("/gstr2b-purchases/"+id);
  const c=await api("/companies/"+d.company.id);
  if(G2B_UI.id!==id){G2B_UI.id=id;G2B_UI.page=0;G2B_UI.selected.clear();G2B_UI.approved=false;G2B_UI.dateApproved=false;}
  const rows=d.rows||[],masters=d.masters||[],mapping=d.mapping||{},pageSize=60;
  const lastPage=Math.max(0,Math.ceil(rows.length/pageSize)-1);
  G2B_UI.page=Math.min(G2B_UI.page,lastPage);
  const shown=rows.slice(G2B_UI.page*pageSize,(G2B_UI.page+1)*pageSize);
  const eligible=rows.filter(x=>["ready","failed"].includes(x.status));
  const eligibleIds=new Set(eligible.map(x=>x.id));
  for(const id of G2B_UI.selected)if(!eligibleIds.has(id))G2B_UI.selected.delete(id);
  const stats=Object.entries(d.stats||{}).map(([s,n])=>esc(s)+": "+n).join(" · ");
  const heads=["igst","cgst","sgst","cess"];
  const used=heads.filter(k=>eligible.some(r=>Math.abs(+r[k]||0)>.004));
  if(eligible.some(r=>Math.abs(+r.round_off||0)>.004))used.push("round");
  const ledgerReady=d.ledgerPresent,allMapped=used.every(k=>mapping[k]);
  const selectable=(dataAttr,options,value)=>{
    return '<select class="in" '+dataAttr+' style="max-width:270px;min-width:180px">'+
      '<option value="">Choose Tally ledger…</option>'+options.map(x=>
        '<option value="'+esc(x)+'"'+(x===value?' selected':'')+'>'+esc(x)+'</option>').join("")+'</select>';
  };
  const maps=used.map(k=>{
    const candidates=masters.filter(x=>k==="round"?/round/i.test(x.name)||!/duties|tax/i.test(x.primary_group||x.parent||""):
      /duties|tax/i.test(x.primary_group||x.parent||""));
    return '<div class="field" style="display:inline-flex;flex-direction:column;gap:5px;margin:6px 12px 6px 0"><label>'+
      esc(k==="round"?"Round Off":"Input "+k.toUpperCase())+'</label>'+
      selectable('data-map="'+k+'"',candidates.map(x=>x.name),mapping[k])+'</div>';
  }).join("");
  const purchaseStatus=ledgerReady?'<span class="good">✓ Available under Purchase Accounts</span>':
    d.ledgerPending?'<span class="warn">Creation is queued. Refresh after Tally finishes.</span>':
      '<span class="bad">Not found in imported Tally masters</span>';
  const tableRows=shown.map(r=>{
    const isReady=["ready","failed"].includes(r.status);
    const type=r.vtype||"Purchase";
    const options=d.supplierOptions?.[r.supplier_gstin]||[];
    const issue=d.supplierIssues?.[r.id];
    const party=r.party_ledger?'<b>'+esc(r.party_ledger)+'</b>':
      options.length?selectable('data-party="'+esc(r.id)+'"',options,"")+
        ' <button class="btn sm" data-saveparty="'+esc(r.id)+'">Select</button>':
        '<span class="bad small">No supplier ledger with matching GSTIN</span>'+
        (issue?'<p class="muted small" style="max-width:250px;margin:5px 0">'+esc(issue.message)+'</p>':'')+
        (issue?.canCreate?'<button class="btn sm" data-create-supplier="'+esc(r.id)+'">+ Create supplier in Tally</button>':'');
    const taxes=heads.filter(k=>+r[k]).map(k=>k.toUpperCase()+": "+g2bMoney(r[k])).join(" · ");
    const signed=(val)=>g2bMoney(type==="Debit Note"?val:-val);
    const breakdown='<details><summary class="small" style="cursor:pointer">See journal entry</summary>'+
      '<div class="small" style="min-width:200px;padding:8px 0">'+
      '<div>'+esc(type)+' · '+esc(r.voucher_number)+'</div>'+
      '<div>Supplier '+(type==="Debit Note"?"debit":"credit")+': '+g2bMoney(r.invoice)+'</div>'+
      '<div>PURCHASE-GSTR2B '+(type==="Debit Note"?"credit":"debit")+': '+g2bMoney(r.taxable)+'</div>'+
      '<div>Input GST '+(type==="Debit Note"?"reversed / credited":"debited")+': '+esc(taxes||"Nil")+'</div>'+
      '<div>Signed round off in voucher: '+signed(r.round_off)+'</div>'+
      '</div></details>';
    const canClassify=(["ECO","ECOA","B2BA"].includes(r.source_section)||(r.source_section==="CDNRA"&&r.source_note==="C"))&&type!=="Debit Note"&&
      ["blocked","review","ready","failed"].includes(r.status);
    const post='<button class="btn sm primary" data-post-one="'+esc(r.id)+'">Post '+esc(type)+'</button>';
    const change=canClassify?'<button class="btn sm" data-mark-credit="'+esc(r.id)+'">Record as Debit Note</button>':'';
    const stateClass=["blocked","uncertain","duplicate","failed"].includes(r.status)?"bad":r.status==="synced"?"good":
      r.status==="review"?"warn":"";
    return '<tr><td><input type="checkbox" aria-label="Select voucher '+esc(r.supplier_invoice)+'" data-pick="'+esc(r.id)+'"'+
      (G2B_UI.selected.has(r.id)?' checked':'')+(isReady?'':' disabled')+'></td>'+
      '<td><b>'+esc(r.supplier_name||"")+'</b><div class="mono muted small">'+esc(r.supplier_gstin)+'</div></td>'+
      '<td>'+esc(r.supplier_invoice)+'<div class="small muted">'+esc(r.date||"")+'</div>'+
      '<div class="small muted">'+esc(r.source_section||"")+'</div></td>'+
      '<td>'+party+'</td><td class="num">'+g2bMoney(r.taxable)+'</td>'+
      '<td class="num">'+g2bMoney(r.invoice)+'</td>'+
      '<td><b>'+esc(type)+'</b><div class="small '+stateClass+'">'+esc(r.status)+'</div>'+
      (r.error?'<div class="small '+stateClass+'" style="max-width:240px">'+esc(r.error)+'</div>':'')+'</td>'+
      '<td><div style="display:flex;flex-direction:column;align-items:flex-start;gap:5px">'+
      (isReady?post:'')+change+(!isReady&&!change&&r.status==="review"?'<span class="small warn">Match supplier first</span>':'')+
      breakdown+'</div></td></tr>';
  }).join("");
  app().innerHTML=topBar([[c.name,"#/c/"+c.id],["Invoices","#/c/"+c.id],["GSTR-2B review"]],c)+
    '<div class="bar"><span class="status">'+esc(d.period)+' · '+stats+'</span><div class="spacer"></div>'+
    '<a class="btn" href="#/c/'+c.id+'/gstr2b-purchase">Back</a> '+
    '<button class="btn" id="g2bRefresh">↻ Refresh</button></div>'+
    '<div class="page wide"><h1>GSTR-2B Purchase &amp; Debit Note review</h1>'+
    '<p class="muted small">Source: '+esc(d.return?.filename||"")+
    ' · <b>Ready</b> means mapped and eligible, not posted. Use the <b>Post Purchase</b> or <b>Post Debit Note</b> button alongside any ready row.</p>'+
    '<div class="card" style="padding:14px;margin:12px 0"><b>Fixed purchase ledger: PURCHASE-GSTR2B</b> · '+purchaseStatus+
    (!ledgerReady&&!d.ledgerPending?'<p><button class="btn primary" id="g2bCreateLedger">Create PURCHASE-GSTR2B in Tally</button></p>':'')+
    '<p class="muted small">If a supplier is missing, choose <b>Create supplier in Tally</b> alongside the row. '+
    'If a ledger already exists but its GSTIN is missing or different, correct that ledger in Tally and click <b>Import masters</b> at the top.</p></div>'+
    '<div class="card" style="padding:14px;margin:12px 0"><h3>Input GST and round-off mapping</h3>'+
    (maps||'<p class="muted">No tax/round-off mapping needed for the current eligible vouchers.</p>')+
    (used.length?'<div><button class="btn" id="g2bSaveMapping">Save GST ledger mapping</button> '+
      (allMapped?'<span class="good small">✓ Mapped</span>':'<span class="warn small">Save the missing ledgers before posting</span>')+'</div>':'')+'</div>'+
    '<div class="g2b-sticky card" style="padding:12px;margin:14px 0">'+
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">'+
    '<div><b>Post selected vouchers</b> <span class="muted small" id="g2bSelection">'+G2B_UI.selected.size+' selected · '+eligible.length+' eligible</span></div>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn primary" id="g2bPost">Post '+G2B_UI.selected.size+' selected to Tally</button>'+
    '<button class="btn" id="g2bRecheck">Recheck uncertain/duplicate</button></div></div>'+
    '<div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:9px">'+
    '<label class="small"><input type="checkbox" id="g2bApprove"'+(G2B_UI.approved?' checked':'')+
    '> I checked the original supplier documents, GST and amounts</label>'+
    '<label class="small"><input type="checkbox" id="g2bDate"'+(G2B_UI.dateApproved?' checked':'')+
    '> I approve posting on each document date, even in an earlier period</label></div></div>'+
    '<div class="filters" style="display:flex;align-items:center;gap:10px;margin:10px 0">'+
    '<label><input type="checkbox" id="g2bAll"> Select all ready on this page</label><span class="spacer"></span>'+
    '<button class="btn sm" id="g2bPrev"'+(G2B_UI.page?'':' disabled')+'>← Previous</button>'+
    'Page '+(G2B_UI.page+1)+' / '+(lastPage+1)+
    '<button class="btn sm" id="g2bNext"'+(G2B_UI.page<lastPage?'':' disabled')+'>Next →</button></div>'+
    '<div style="overflow:auto"><table class="grid"><thead><tr><th></th><th>Supplier / GSTIN</th>'+
    '<th>Supplier document / date</th><th>Tally supplier</th><th>Taxable</th><th>Value</th>'+
    '<th>Voucher / status</th><th>Action</th></tr></thead><tbody>'+tableRows+'</tbody></table></div>'+
    '<p class="muted small" style="margin:12px 0">The app checks Tally for duplicates before every create. '+
    'Supplier credit notes are Debit Notes (supplier debit, purchase and input-tax credit). '+
    'ECO documents require explicit verification as credit notes; amendments may supersede existing transactions.</p></div>';
  wireTop(c);
  const run=async(action,body,msg)=>{
    if(G2B_UI.busy)return null;
    G2B_UI.busy=true;
    try{
      const result=await api("/gstr2b-purchases/"+id+"/"+action,{body:body||{}});
      toast(msg);
      await route();return result;
    }catch(e){toast(e.message,true);return null;}
    finally{G2B_UI.busy=false;}
  };
  $("#g2bRefresh").onclick=()=>route();
  $("#g2bPrev").onclick=()=>{G2B_UI.page=Math.max(0,G2B_UI.page-1);route();};
  $("#g2bNext").onclick=()=>{G2B_UI.page=Math.min(lastPage,G2B_UI.page+1);route();};
  const updateCount=()=>{
    const num=G2B_UI.selected.size;
    $("#g2bSelection").textContent=num+" selected · "+eligible.length+" eligible";
    $("#g2bPost").textContent="Post "+num+" selected to Tally";
  };
  $$("[data-pick]").forEach(el=>el.onchange=()=>{
    if(el.checked)G2B_UI.selected.add(el.dataset.pick);else G2B_UI.selected.delete(el.dataset.pick);
    updateCount();
  });
  $("#g2bAll").onchange=e=>{
    for(const r of shown.filter(x=>eligibleIds.has(x.id))){
      if(e.target.checked)G2B_UI.selected.add(r.id);else G2B_UI.selected.delete(r.id);
      const node=document.querySelector('[data-pick="'+r.id+'"]');if(node)node.checked=e.target.checked;
    }
    updateCount();
  };
  $("#g2bApprove").onchange=e=>{G2B_UI.approved=e.target.checked;};
  $("#g2bDate").onchange=e=>{G2B_UI.dateApproved=e.target.checked;};
  $("#g2bCreateLedger")?.addEventListener("click",()=>{
    if(confirm("Create PURCHASE-GSTR2B under Purchase Accounts in the selected Tally company?"))
      run("ensure-ledger",{},"Purchase ledger creation requested");
  });
  $("#g2bSaveMapping")?.addEventListener("click",()=>{
    const fields={};$$("[data-map]").forEach(el=>fields[el.dataset.map]=el.value);
    run("mapping",fields,"Tax ledger mapping saved");
  });
  $$("[data-saveparty]").forEach(btn=>btn.onclick=()=>{
    const node=document.querySelector('[data-party="'+btn.dataset.saveparty+'"]');
    if(!node?.value)return toast("Choose a matching supplier creditor",true);
    run("party",{id:btn.dataset.saveparty,ledger:node.value},"Supplier ledger matched");
  });
  $$("[data-create-supplier]").forEach(btn=>btn.onclick=()=>{
    const r=rows.find(x=>x.id===btn.dataset.createSupplier);
    if(!r)return;
    if(!confirm("Create new supplier ledger '"+r.supplier_name+"' in Tally under Sundry Creditors with GSTIN "+r.supplier_gstin+
      "?\n\nIf this supplier already exists in Tally, CANCEL and update its existing GSTIN instead."))return;
    run("create-supplier",{id:r.id},"Supplier ledger creation queued; refresh when Tally finishes");
  });
  $$("[data-mark-credit]").forEach(btn=>btn.onclick=()=>{
    const r=rows.find(x=>x.id===btn.dataset.markCredit);
    if(!r)return;
    const amended=["ECOA","CDNRA"].includes(r.source_section);
    const message="Supplier credit-note verification:\n\n"+r.supplier_name+" — "+r.supplier_invoice+
      "\nValue "+g2bMoney(r.invoice)+" · date "+r.date+
      "\n\nConfirm that you have checked the ORIGINAL supplier-issued credit note and that this is a genuine reduction in purchases/ITC. "+
      "The app will classify it as a Tally DEBIT NOTE, not a Purchase."+
      (amended?"\n\nWARNING: This is an amended ECO document. Confirm it is a credit adjustment that has NOT already been entered, not merely a revised invoice.":"");
    if(!confirm(message))return;
    run("type",{id:r.id,vtype:"Debit Note",confirmCredit:true,confirmAmendment:amended},
      "Classified as Debit Note. Verify supplier GSTIN and post only after review.");
  });
  const submit=async(ids,single)=>{
    if(!ids.length)return toast("Select ready vouchers first (checkboxes on the left).",true);
    if(ids.length>120)return toast("Post no more than 120 at once.",true);
    if(!single&&(!G2B_UI.approved||!G2B_UI.dateApproved))
      return toast("Tick BOTH confirmations above the table before bulk posting.",true);
    const selected=ids.map(x=>rows.find(r=>r.id===x)).filter(Boolean);
    const desc=selected.length===1?
      selected[0].vtype+" "+selected[0].supplier_invoice+" · "+selected[0].supplier_name+
      " · "+g2bMoney(selected[0].invoice)+" dated "+selected[0].date:
      selected.length+" reviewed vouchers";
    if(!confirm("POST TO TALLY:\n"+desc+"\n\nI confirm that I checked the original supplier documents and accounting totals, approve the "+
      "supplier document dates (including any earlier financial year), and understand this CREATE action may change Tally books. "+
      "\n\nDuplicates are checked before sending. Continue?"))return;
    const result=await run("post",{ids,confirmed:true,confirmedDate:true},"Queued "+ids.length+" voucher(s) for Tally");
    if(result)for(const iid of ids)G2B_UI.selected.delete(iid);
  };
  $("#g2bPost").onclick=()=>submit([...G2B_UI.selected].filter(x=>eligibleIds.has(x)),false);
  $$("[data-post-one]").forEach(btn=>btn.onclick=()=>submit([btn.dataset.postOne],true));
  $("#g2bRecheck").onclick=()=>{
    if(confirm("Check uncertain or previously duplicated vouchers against live Tally? This does NOT post any voucher."))
      run("recheck",{},"Tally duplicate status rechecked");
  };
  if(rows.some(r=>r.status==="queued"))every(7000,()=>{if(location.hash==="#/p2b/"+id)route();});
}
