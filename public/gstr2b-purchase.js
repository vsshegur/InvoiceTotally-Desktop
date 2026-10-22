// GSTR-2B → purchase vouchers, kept separate from the existing invoice reader.
"use strict";
const g2bMoney=n=>Number(n||0).toLocaleString("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2});
const G2B_UI={id:"",page:0,selected:new Set()};
async function viewGstr2bPurchaseChoose(cid){
  const [c,returns,batches]=await Promise.all([
    api("/companies/"+cid),api("/companies/"+cid+"/gstr2b"),api("/companies/"+cid+"/gstr2b-purchases")
  ]);
  const prepared=new Map(batches.map(x=>[x.return_id,x.id]));
  app().innerHTML=topBar([[c.name,"#/c/"+cid],["Invoices","#/c/"+cid],["Upload GSTR-2B"]],c)+
    '<div class="bar"><span class="status">GSTR-2B → Purchase in Tally</span><div class="spacer"></div>'+
    '<a class="btn" href="#/c/'+cid+'">Back</a> '+
    '<a class="btn primary" href="#/c/'+cid+'/gstr2b-purchase/upload">Upload GSTR-2B Excel/JSON</a></div>'+
    '<div class="page wide"><h1>Prepare Purchase vouchers from GSTR-2B</h1>'+
    '<div class="card" style="padding:14px;margin:12px 0"><b>Fixed purchase ledger: PURCHASE-GSTR2B</b>'+
    '<p class="muted small">Accounting-mode Purchase voucher per eligible B2B invoice, using supplier invoice date. No stock items or quantities are invented. '+
    'Supplier GSTIN must match your Tally ledger. Credit/debit notes, reverse charge, ineligible ITC and amendments require separate handling. '+
    'Nothing is posted without review and approval.</p></div><h3>Use an imported GSTR-2B return</h3>'+
    (returns.some(r=>r.kind==="GSTR-2B"&&r.stage!=="uploading")?
      '<table class="grid"><thead><tr><th>Return month</th><th>Portal file</th><th>Documents</th><th>Action</th></tr></thead><tbody>'+
      returns.filter(r=>r.kind==="GSTR-2B"&&r.stage!=="uploading").map(r=>
        '<tr><td>'+esc(r.period)+'</td><td>'+esc(r.filename||"")+'</td><td>'+r.docs+'</td>'+
        '<td><button class="btn sm primary" data-prepare="'+esc(r.id)+'">'+
        (prepared.has(r.id)?"Open prepared purchases":"Prepare purchase vouchers")+'</button></td></tr>').join("")+'</tbody></table>':
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
  if(G2B_UI.id!==id){G2B_UI.id=id;G2B_UI.page=0;G2B_UI.selected.clear();}
  const rows=d.rows||[],m=d.masters||[],map=d.mapping||{},pageSize=60;
  const lastPage=Math.max(0,Math.ceil(rows.length/pageSize)-1);
  G2B_UI.page=Math.min(G2B_UI.page,lastPage);
  const shown=rows.slice(G2B_UI.page*pageSize,(G2B_UI.page+1)*pageSize);
  const elig=rows.filter(x=>["ready","failed"].includes(x.status));
  const counts=Object.entries(d.stats||{}).map(([s,n])=>esc(s)+": "+n).join(" · ");
  const taxHeads=["igst","cgst","sgst","cess"];
  const used=taxHeads.filter(k=>rows.some(r=>Math.abs(+r[k]||0)>.004));
  if(rows.some(r=>Math.abs(+r.round_off||0)>.004))used.push("round");
  const select=(id,opts,selected)=>{
    return '<select class="in" data-'+id+' style="max-width:270px;min-width:150px">'+
      '<option value="">Select…</option>'+opts.map(x=>
        '<option value="'+esc(x)+'"'+(x===selected?' selected':'')+'>'+esc(x)+'</option>').join("")+'</select>';
  };
  const mapUi=used.map(k=>{
    const candidates=m.filter(x=>k==="round"?/round/i.test(x.name)||!/duties|tax/i.test(x.primary_group||x.parent||""):
      /duties|tax/i.test(x.primary_group||x.parent||""));
    return '<div class="field" style="display:inline-flex;flex-direction:column;gap:5px;margin:6px 12px 6px 0"><label>'+
      esc(k==="round"?"Round Off":"Input "+k.toUpperCase())+'</label>'+
      select('map="'+k+'"',candidates.map(x=>x.name),map[k])+'</div>';
  }).join("");
  const ledgerStatus=d.ledgerPresent?'<span class="good">✓ Available under Purchase Accounts</span>':
    d.ledgerPending?'<span class="warn">Creation queued: refresh after Tally finishes</span>':
      '<span class="bad">Not found in imported Tally masters</span>';
  const tableRows=shown.map(r=>{
    const can=["ready","failed"].includes(r.status);
    const opts=d.supplierOptions?.[r.supplier_gstin]||[];
    const party=r.party_ledger?'<b>'+esc(r.party_ledger)+'</b>':
      opts.length?select('party="'+esc(r.id)+'"',opts,"")+
        '<button class="btn sm" data-saveparty="'+esc(r.id)+'">Set</button>':
        '<span class="bad small">Supplier GSTIN not found in Tally masters</span>';
    const tax=taxHeads.filter(k=>+r[k]).map(k=>k.toUpperCase()+": "+g2bMoney(r[k])).join(" · ");
    const breakdown='<details><summary class="small" style="cursor:pointer">See ledgers</summary>'+
      '<div class="small" style="min-width:200px;padding:8px 0">'+
      '<div>Purchase-GSTR2B debit: '+g2bMoney(r.taxable)+'</div>'+
      '<div>Input GST debits: '+esc(tax||"Nil")+'</div>'+
      '<div>Round-off signed: '+g2bMoney(r.round_off)+'</div>'+
      '<div>Supplier credit: '+g2bMoney(r.invoice)+'</div>'+
      '<p>Voucher: '+esc(r.voucher_number)+'</p></div></details>';
    return '<tr><td><input type="checkbox" data-pick="'+esc(r.id)+'"'+
      (G2B_UI.selected.has(r.id)?' checked':'')+(can?'':' disabled')+'></td>'+
      '<td><b>'+esc(r.supplier_name||"")+'</b><div class="mono muted small">'+esc(r.supplier_gstin)+'</div></td>'+
      '<td>'+esc(r.supplier_invoice)+'<div class="small muted">'+esc(r.date||"")+'</div></td>'+
      '<td>'+party+'</td><td class="num">'+g2bMoney(r.taxable)+'</td><td class="num">'+g2bMoney(r.invoice)+'</td>'+
      '<td>'+esc(r.status)+(r.error?'<div class="small bad" style="max-width:250px">'+esc(r.error)+'</div>':'')+'</td>'+
      '<td>'+breakdown+'</td></tr>';
  }).join("");
  app().innerHTML=topBar([[c.name,"#/c/"+c.id],["Invoices","#/c/"+c.id],["GSTR-2B purchase review"]],c)+
    '<div class="bar"><span class="status">'+esc(d.period)+' · '+counts+'</span><div class="spacer"></div>'+
    '<a class="btn" href="#/c/'+c.id+'/gstr2b-purchase">Back</a> <button class="btn" id="g2bRefresh">Refresh</button></div>'+
    '<div class="page wide"><h1>Review GSTR-2B Purchase vouchers</h1>'+
    '<p class="muted small">Source: '+esc(d.return?.filename||"")+' · This will create accounting vouchers, not stock entries.</p>'+
    '<div class="card" style="padding:14px;margin:12px 0"><b>Fixed purchase ledger: PURCHASE-GSTR2B</b> · '+ledgerStatus+
    (!d.ledgerPresent&&!d.ledgerPending?'<p><button class="btn primary" id="g2bCreateLedger">Create PURCHASE-GSTR2B in Tally</button></p>':'')+
    '<p class="muted small">Ledger is created under Purchase Accounts on your approval. If suppliers are missing, correct their GSTIN/ledger in Tally and click Import Masters.</p></div>'+
    '<div class="card" style="padding:14px;margin:12px 0"><h3>Map Input GST &amp; Round Off</h3>'+
    (mapUi||'<p class="muted">No tax/round-off amounts.</p>')+
    (used.length?'<div><button class="btn" id="g2bSaveMapping">Save ledger mapping</button></div>':'')+'</div>'+
    '<div class="card" style="padding:14px;margin:12px 0"><h3>Approve Tally posting</h3>'+
    '<p class="muted small">Every voucher receives a fresh Tally duplicate check immediately before posting. No automatic retry after an uncertain response.</p>'+
    '<p><label><input type="checkbox" id="g2bApprove"> I verified invoice totals, supplier, tax ledgers and amounts</label></p>'+
    '<p><label><input type="checkbox" id="g2bDate"> I approve booking at the supplier invoice date, including earlier months if applicable</label></p>'+
    '<button class="btn primary" id="g2bPost">Queue selected Purchases to Tally</button> '+
    '<button class="btn" id="g2bRecheck">Recheck uncertain/duplicate</button>'+
    '<span class="muted small" id="g2bSelection"> '+G2B_UI.selected.size+' selected</span></div>'+
    '<div class="filters" style="display:flex;align-items:center;gap:10px">'+
    '<label><input type="checkbox" id="g2bAll"> Select eligible on page</label><span class="spacer"></span>'+
    '<button class="btn sm" id="g2bPrev"'+(G2B_UI.page?'':' disabled')+'>←</button>'+
    'Page '+(G2B_UI.page+1)+' / '+(lastPage+1)+
    '<button class="btn sm" id="g2bNext"'+(G2B_UI.page<lastPage?'':' disabled')+'>→</button></div>'+
    '<div style="overflow:auto"><table class="grid"><thead><tr><th></th><th>Supplier / GSTIN</th><th>Supplier invoice / date</th>'+
    '<th>Tally party ledger</th><th>Taxable</th><th>Invoice value</th><th>Status</th><th>Voucher preview</th></tr></thead>'+
    '<tbody>'+tableRows+'</tbody></table></div></div>';
  wireTop(c);
  const call=async(action,body,msg)=>{
    try{const v=await api("/gstr2b-purchases/"+id+"/"+action,{body:body||{}});toast(msg);route();return v;}
    catch(e){toast(e.message,true);return null;}
  };
  $("#g2bRefresh").onclick=()=>route();
  $("#g2bPrev").onclick=()=>{G2B_UI.page=Math.max(0,G2B_UI.page-1);route();};
  $("#g2bNext").onclick=()=>{G2B_UI.page=Math.min(lastPage,G2B_UI.page+1);route();};
  const selectionCount=()=>{$("#g2bSelection").textContent=G2B_UI.selected.size+" selected";};
  $$("[data-pick]").forEach(el=>el.onchange=()=>{
    if(el.checked)G2B_UI.selected.add(el.dataset.pick);else G2B_UI.selected.delete(el.dataset.pick);
    selectionCount();
  });
  $("#g2bAll").onchange=e=>{
    for(const r of shown.filter(x=>["ready","failed"].includes(x.status))){
      if(e.target.checked)G2B_UI.selected.add(r.id);else G2B_UI.selected.delete(r.id);
      const node=document.querySelector('[data-pick="'+r.id+'"]');if(node)node.checked=e.target.checked;
    }
    selectionCount();
  };
  $("#g2bCreateLedger")?.addEventListener("click",()=>{
    if(confirm("Create PURCHASE-GSTR2B under Purchase Accounts in the selected Tally company?"))
      call("ensure-ledger",{},"Purchase ledger creation requested");
  });
  $("#g2bSaveMapping")?.addEventListener("click",()=>{
    const fields={};$$("[data-map]").forEach(el=>fields[el.dataset.map]=el.value);
    call("mapping",fields,"Ledger mapping saved");
  });
  $$("[data-saveparty]").forEach(btn=>btn.onclick=()=>{
    const sel=document.querySelector('[data-party="'+btn.dataset.saveparty+'"]');
    if(!sel?.value)return toast("Choose a matching supplier ledger",true);
    call("party",{id:btn.dataset.saveparty,ledger:sel.value},"Supplier ledger saved");
  });
  $("#g2bPost").onclick=async()=>{
    const ids=[...G2B_UI.selected].filter(v=>elig.some(x=>x.id===v));
    if(!ids.length)return toast("Select at least one eligible invoice",true);
    if(ids.length>120)return toast("Post no more than 120 reviewed invoices at a time",true);
    if(!$("#g2bApprove").checked||!$("#g2bDate").checked)
      return toast("Tick both confirmation boxes before posting",true);
    if(!confirm("Queue "+ids.length+" reviewed Purchase vouchers to "+d.company.tally_company+
      " using PURCHASE-GSTR2B? Duplicate checks will run on each one."))return;
    const result=await call("post",{ids,confirmed:true,confirmedDate:true},"Tally posting jobs queued");
    if(result)G2B_UI.selected.clear();
  };
  $("#g2bRecheck").onclick=()=>{
    if(confirm("Recheck uncertain/duplicate vouchers against Tally? No vouchers will be posted by this action."))
      call("recheck",{},"Tally voucher status checked");
  };
  if(rows.some(r=>r.status==="queued"))every(7000,()=>{if(location.hash==="#/p2b/"+id)route();});
}
