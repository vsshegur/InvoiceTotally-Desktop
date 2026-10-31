// GSTR-2B → Tally: every document (purchases, reverse charge, supplier credit/debit notes, ISD, imports).
// The invoice reader for images/PDFs is separate and unaffected.
"use strict";
const g2bMoney=n=>Number(n||0).toLocaleString("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2});
const G2B_UI={id:"",selected:new Set(),approved:false,dateApproved:false,busy:false,status:"todo",type:"all",q:""};
const G2B_TYPES=["Purchase","Debit Note","Credit Note"];
const G2B_MAP_LABEL={igst:"Input IGST",cgst:"Input CGST",sgst:"Input SGST",cess:"Input Cess",round:"Round Off",
  rcm_igst:"RCM IGST payable",rcm_cgst:"RCM CGST payable",rcm_sgst:"RCM SGST payable",rcm_cess:"RCM Cess payable",
  impg_credit:"Credit for import IGST (customs / agent)"};
const G2B_JOURNAL={rcm:"RCM GST journal",isd:"ISD credit journal",isd_cn:"ISD credit note journal",impg:"Import IGST journal"};
async function viewGstr2bPurchaseChoose(cid){
  const [c,returns,batches]=await Promise.all([
    api("/companies/"+cid),api("/companies/"+cid+"/gstr2b"),api("/companies/"+cid+"/gstr2b-purchases")
  ]);
  const prepared=new Map(batches.map(x=>[x.return_id,x.id]));
  app().innerHTML=topBar([[c.name,"#/c/"+cid],["Invoices","#/c/"+cid],["Upload GSTR-2B"]],c)+
    '<div class="bar"><span class="status">GSTR-2B → Tally (every entry)</span><div class="spacer"></div>'+
    '<a class="btn" href="#/c/'+cid+'">Back</a> '+
    '<a class="btn primary" href="#/c/'+cid+'/gstr2b-purchase/upload">Upload GSTR-2B Excel/JSON</a></div>'+
    '<div class="page wide"><h1>Prepare Tally vouchers from GSTR-2B</h1>'+
    '<div class="card" style="padding:14px;margin:12px 0"><b>Every GSTR-2B entry goes to Tally</b>'+
    '<p class="muted small">Invoices → Purchase · reverse charge (RCM) → Purchase + RCM GST journal · supplier credit note → Debit Note · '+
    'supplier debit note → Credit Note · ISD credit and import IGST → Journal. Taxable value goes to one purchase ledger per GST rate '+
    '(GSTR2B 5%, GSTR2B 12%, GSTR2B 18%, GSTR2B 28%, GSTR2B RCM 5%…), each created in Tally with its rate, so Tally\'s GST reports classify them. '+
    'Entries already matched in GSTR-2B reconciliation are not posted again. Nothing posts without your confirmation.</p></div><h3>Use an imported GSTR-2B return</h3>'+
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
/** An obvious ledger for a GST head when none is saved yet ("Input CGST", "CGST", "Round Off"…). */
function g2bGuess(k,list){
  const head=k.replace(/^rcm_/,"");
  const re={igst:/igst|integrated/i,cgst:/cgst|central/i,sgst:/sgst|utgst|state tax/i,cess:/\bcess\b/i,round:/round/i}[head];
  if(!re)return "";
  const hits=list.filter(n=>re.test(n));
  if(k.startsWith("rcm_"))return hits.find(n=>/rcm|reverse|payable|output/i.test(n))||hits.find(n=>!/input/i.test(n))||hits[0]||"";
  return hits.find(n=>/input/i.test(n))||hits.find(n=>!/output|rcm|payable/i.test(n))||hits[0]||"";
}
const g2bKind=r=>r.vtype==="Journal"?"Journal":r.rcm?"RCM":r.vtype;
const g2bPostable=r=>["ready","failed"].includes(r.status);
function g2bFilter(rows){
  const q=G2B_UI.q.trim().toLowerCase();
  return rows.filter(r=>{
    const st=G2B_UI.status;
    if(st==="todo"&&!["ready","failed","review"].includes(r.status))return false;
    if(st==="ready"&&!g2bPostable(r))return false;
    if(st==="review"&&r.status!=="review")return false;
    if(st==="blocked"&&r.status!=="blocked")return false;
    if(st==="posted"&&r.status!=="synced")return false;
    if(st==="problem"&&!["uncertain","duplicate","failed"].includes(r.status))return false;
    if(st==="wrongrate"&&!r.wrong_rate)return false;
    if(G2B_UI.type!=="all"&&g2bKind(r)!==G2B_UI.type)return false;
    if(q&&!(r.supplier_name+" "+r.supplier_gstin+" "+r.supplier_invoice+" "+(r.party_ledger||"")).toLowerCase().includes(q))return false;
    return true;
  });
}
function g2bEntry(r,mapping){
  const type=r.vtype,heads=["igst","cgst","sgst","cess"];
  const line=(name,amount,side)=>'<div>'+esc(side)+' '+esc(name||"(choose ledger)")+': '+g2bMoney(amount)+'</div>';
  const out=[];
  if(type==="Journal"){
    const rev=r.jkind==="isd_cn";
    for(const h of heads)if(+r[h])out.push(line(mapping[h]||"Input "+h.toUpperCase(),r[h],rev?"Cr":"Dr"));
    const total=heads.reduce((a,h)=>a+(+r[h]||0),0);
    if(r.jkind==="rcm")for(const h of heads){if(+r[h])out.push(line(mapping["rcm_"+h]||"RCM "+h.toUpperCase()+" payable",r[h],"Cr"));}
    else out.push(line(r.jkind==="impg"?mapping.impg_credit:r.party_ledger,total,rev?"Dr":"Cr"));
    return out.join("");
  }
  const back=type==="Debit Note";
  out.push(line(r.party_ledger||"Supplier",r.rcm?r.taxable:r.invoice,back?"Dr":"Cr"));
  for(const l of r.ledgers||[])out.push(line(l.name,l.taxable,back?"Cr":"Dr"));
  if(!r.rcm){
    for(const h of heads)if(+r[h])out.push(line(mapping[h]||"Input "+h.toUpperCase(),r[h],back?"Cr":"Dr"));
    if(Math.abs(+r.round_off||0)>.004)out.push(line(mapping.round||"Round Off",r.round_off,(r.round_off>0)!==back?"Dr":"Cr"));
  }
  return out.join("");
}
function g2bRow(r,d){
  const postable=g2bPostable(r),mapping=d.mapping||{};
  const options=d.supplierOptions?.[r.supplier_gstin]||[];
  const issue=d.supplierIssues?.[r.id];
  const needsParty=r.vtype!=="Journal"||r.jkind==="isd"||r.jkind==="isd_cn";
  const party=!needsParty?'<span class="muted small">—</span>':r.party_ledger?'<b>'+esc(r.party_ledger)+'</b>':
    options.length?'<select class="in" data-party="'+esc(r.id)+'" style="max-width:220px"><option value="">Choose…</option>'+
      options.map(x=>'<option>'+esc(x)+'</option>').join("")+'</select> <button class="btn sm" data-saveparty="'+esc(r.id)+'">Select</button>':
    '<span class="bad small">No supplier with this GSTIN</span>'+
      (issue&&issue.code!=="missing"?'<p class="muted small" style="max-width:240px;margin:4px 0">'+esc(issue.message)+'</p>':'')+
      (issue?.canCreate?'<button class="btn sm" data-create-supplier="'+esc(r.id)+'">+ Create supplier</button>':'');
  const tags=[r.rcm?'<span class="pill warn">RCM</span>':'',r.itc_n?'<span class="pill warn" title="ITC not available as per GSTR-2B">ITC N/A</span>':'',
    /A$/.test(r.source_section||"")?'<span class="pill">Amended'+(r.original_invoice?" (was "+esc(r.original_invoice)+")":"")+'</span>':''].join(" ");
  const gst=["igst","cgst","sgst","cess"].reduce((a,h)=>a+(+r[h]||0),0);
  const changeable=r.vtype!=="Journal"&&["ready","review","failed"].includes(r.status);
  const typeCell=changeable?'<select class="in" data-vtype="'+esc(r.id)+'" style="max-width:150px">'+
      G2B_TYPES.map(t=>'<option'+(t===r.vtype?' selected':'')+'>'+t+'</option>').join("")+'</select>':
    '<b>'+esc(r.vtype==="Journal"?G2B_JOURNAL[r.jkind]||"Journal":r.vtype)+'</b>';
  const stateClass=["blocked","uncertain","duplicate","failed"].includes(r.status)?"bad":r.status==="synced"?"good":r.status==="review"?"warn":"";
  const ledgers=(r.ledgers||[]).map(l=>esc(l.name)).join("<br>");
  return '<tr data-row="'+esc(r.id)+'"><td><input type="checkbox" aria-label="Select '+esc(r.supplier_invoice)+'" data-pick="'+esc(r.id)+'"'+
    (G2B_UI.selected.has(r.id)?' checked':'')+(postable?'':' disabled')+'></td>'+
    '<td><b>'+esc(r.supplier_name||"")+'</b><div class="mono muted small">'+esc(r.supplier_gstin)+'</div></td>'+
    '<td>'+esc(r.supplier_invoice)+'<div class="small muted">'+esc(r.date||"")+' · '+esc(r.source_section||"")+'</div>'+(tags.trim()?'<div>'+tags+'</div>':'')+'</td>'+
    '<td>'+party+'</td><td class="small">'+(ledgers||'<span class="muted">—</span>')+'</td>'+
    '<td class="num">'+g2bMoney(r.taxable)+'</td><td class="num">'+g2bMoney(gst)+'</td><td class="num">'+g2bMoney(r.invoice)+'</td>'+
    '<td>'+typeCell+'<div class="small '+stateClass+'">'+esc(r.status==="synced"?"posted":r.status==="review"?"needs supplier":r.status)+'</div>'+
    (r.wrong_rate?'<div class="small bad" style="max-width:280px">⚠ '+esc(r.wrong_rate.message)+'</div>':'')+
    (r.error&&!(r.status==="review"&&needsParty&&!r.party_ledger)?'<div class="small '+stateClass+'" style="max-width:260px">'+esc(r.error)+'</div>':'')+'</td>'+
    '<td><div style="display:flex;flex-direction:column;align-items:flex-start;gap:5px">'+
    (postable?'<button class="btn sm primary" data-post-one="'+esc(r.id)+'">Post</button>':'')+
    (changeable&&r.vtype!=="Debit Note"&&["ECO","ECOA","B2BA"].includes(r.source_section)?'<button class="btn sm" data-mark-credit="'+esc(r.id)+'">It\'s a credit note</button>':'')+
    '<details><summary class="small" style="cursor:pointer">Entry</summary><div class="small" style="min-width:220px;padding:6px 0">'+
    '<div class="muted">'+esc(r.voucher_number)+'</div>'+g2bEntry(r,mapping)+'</div></details></div></td></tr>';
}
async function viewGstr2bPurchaseBatch(id){
  const d=await api("/gstr2b-purchases/"+id);
  const c=await api("/companies/"+d.company.id);
  if(G2B_UI.id!==id){Object.assign(G2B_UI,{id,approved:false,dateApproved:false,status:"todo",type:"all",q:""});G2B_UI.selected.clear();}
  const rows=d.rows||[],masters=d.masters||[],mapping=d.mapping||{};
  const byId=new Map(rows.map(r=>[r.id,r]));
  const eligibleIds=new Set(rows.filter(g2bPostable).map(r=>r.id));
  for(const x of [...G2B_UI.selected])if(!eligibleIds.has(x))G2B_UI.selected.delete(x);
  const count=s=>rows.filter(r=>s(r)).length;
  const stats=[["Ready",count(g2bPostable)],["Need supplier",count(r=>r.status==="review")],["Posted",count(r=>r.status==="synced")],
    ["Queued",count(r=>r.status==="queued")],["Check",count(r=>["uncertain","duplicate"].includes(r.status))],["Not posted",count(r=>r.status==="blocked")]]
    .filter(([,n])=>n).map(([k,n])=>esc(k)+": "+n).join(" · ");
  const ledgerRows=(d.ledgers||[]).map(l=>'<span class="pill '+(l.state==="present"?"good":l.state==="pending"?"warn":"bad")+'">'+esc(l.name)+
    (l.state==="present"?" ✓":l.state==="pending"?" · creating…":" · missing")+'</span>').join(" ");
  const missingLedgers=(d.ledgers||[]).filter(l=>l.state==="missing").length;
  const missingSuppliers=new Set(rows.filter(r=>d.supplierIssues?.[r.id]?.code==="missing").map(r=>r.supplier_gstin)).size;
  const taxMasters=masters.filter(x=>/duties|tax/i.test(x.primary_group||x.parent||"")).map(x=>x.name);
  const otherMasters=masters.filter(x=>!/^gstr2b /i.test(x.name)).map(x=>x.name);
  const maps=(d.mappingNeeded||[]).map(k=>{
    const list=k==="round"?otherMasters.filter(n=>/round/i.test(n)).concat(otherMasters.filter(n=>!/round/i.test(n))):k==="impg_credit"?otherMasters:taxMasters;
    return '<div class="field" style="display:inline-flex;flex-direction:column;gap:5px;margin:6px 12px 6px 0"><label>'+esc(G2B_MAP_LABEL[k]||k)+'</label>'+
      '<select class="in" data-map="'+k+'" style="max-width:270px;min-width:180px"><option value="">Choose Tally ledger…</option>'+
      list.map(x=>'<option'+(x===(mapping[k]||g2bGuess(k,list))?' selected':'')+'>'+esc(x)+'</option>').join("")+'</select></div>';
  }).join("");
  const allMapped=(d.mappingNeeded||[]).every(k=>mapping[k]);
  const filterSel=(id,val,opts)=>'<select class="in" id="'+id+'" style="max-width:240px">'+opts.map(([v,l])=>'<option value="'+v+'"'+(v===val?' selected':'')+'>'+esc(l)+'</option>').join("")+'</select>';
  app().innerHTML=topBar([[c.name,"#/c/"+c.id],["Invoices","#/c/"+c.id],["GSTR-2B review"]],c)+
    '<div class="bar"><span class="status">'+esc(d.period)+' · '+stats+'</span><div class="spacer"></div>'+
    '<a class="btn" href="#/c/'+c.id+'/gstr2b-purchase">Back</a> '+
    '<button class="btn" id="g2bRefresh">↻ Refresh</button></div>'+
    '<div class="page wide"><h1>GSTR-2B → Tally</h1>'+
    (d.wrong_rate?'<div class="alert bad" style="margin:10px 0"><b>'+d.wrong_rate+' posted entr'+(d.wrong_rate===1?'y went':'ies went')+' to the wrong GST-rate ledger</b> (small bills, e.g. bank charges: 18% GST was put on the 12% ledger). '+
      'Pick “Posted at the wrong GST rate” in the filter below to see them; in Tally, alter each voucher and change the ledger as shown. Nothing else in them is wrong.</div>':'')+
    '<p class="muted small">Source: '+esc(d.return?.filename||"")+' · '+rows.length+' entries, all on this page. '+
    '<b>Ready</b> means checked and mapped, not yet posted. After posting, GSTR-2B reconciliation matches each one to its Tally voucher.</p>'+
    '<div class="card" style="padding:14px;margin:12px 0"><h3 style="margin:0 0 6px">1. Purchase ledgers by GST rate</h3>'+
    (ledgerRows||'<span class="muted small">None needed.</span>')+
    (missingLedgers?'<p><button class="btn primary" id="g2bCreateLedger">Create '+missingLedgers+' ledger(s) in Tally</button> '+
      '<span class="muted small">Under Purchase Accounts, GST applicable at the rate in the name (RCM ones: reverse charge, services).</span></p>':
      d.ledgersPending?'<p class="warn small">Tally is creating them — press Refresh in a moment.</p>':'')+'</div>'+
    '<div class="card" style="padding:14px;margin:12px 0"><h3 style="margin:0 0 6px">2. Suppliers</h3>'+
    (missingSuppliers?'<p><button class="btn primary" id="g2bCreateSuppliers">Create all '+missingSuppliers+' missing supplier(s) in Tally</button></p>'+
      '<p class="muted small">Each is created under Sundry Creditors with its GSTIN, state (from the GSTIN), registration type Regular and bill-by-bill. '+
      'A name already used in Tally is not duplicated — correct that ledger\'s GSTIN in Tally and Import masters instead.</p>':
      '<p class="muted small">'+(count(r=>r.status==="review")?"Pick the supplier on each row below, or fix the ledger in Tally and Import masters.":"Every supplier is matched by GSTIN.")+'</p>')+'</div>'+
    '<div class="card" style="padding:14px;margin:12px 0"><h3 style="margin:0 0 6px">3. GST ledgers</h3>'+
    (maps||'<p class="muted">No GST ledger mapping needed for the remaining entries.</p>')+
    ((d.mappingNeeded||[]).length?'<div><button class="btn" id="g2bSaveMapping">Save GST ledgers</button> '+
      (allMapped?'<span class="good small">✓ Saved</span>':'<span class="warn small">Not saved yet — Save, or just Post: the ledgers shown are saved first</span>')+'</div>':'')+'</div>'+
    '<div class="g2b-sticky card" style="padding:12px;margin:14px 0">'+
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">'+
    '<div><b>4. Post to Tally</b> <span class="muted small" id="g2bSelection"></span></div>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn primary" id="g2bPost"></button>'+
    '<button class="btn" id="g2bRecheck" title="Uncertain or duplicate entries: check again in Tally">Recheck uncertain</button>'+
    '<button class="btn" id="g2bRecheckPosted" title="Entries deleted in Tally become ready to post again">Check posted are still in Tally</button></div></div>'+
    '<div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:9px">'+
    '<label class="small"><input type="checkbox" id="g2bApprove"'+(G2B_UI.approved?' checked':'')+
    '> I checked the supplier documents, GST and amounts</label>'+
    '<label class="small"><input type="checkbox" id="g2bDate"'+(G2B_UI.dateApproved?' checked':'')+
    '> Post on each document\'s own date, even in an earlier period</label></div></div>'+
    '<div class="filters" style="display:flex;align-items:center;gap:10px;margin:10px 0;flex-wrap:wrap">'+
    filterSel("g2bStatus",G2B_UI.status,[["todo","To do"],...(d.wrong_rate?[["wrongrate","Posted at the wrong GST rate ("+d.wrong_rate+")"]]:[]),["ready","Ready"],["review","Need supplier"],["problem","Uncertain / duplicate / failed"],["posted","Posted"],["blocked","Not posted (reason shown)"],["all","All entries"]])+
    filterSel("g2bType",G2B_UI.type,[["all","All types"],["Purchase","Purchase"],["RCM","Reverse charge"],["Debit Note","Debit Note"],["Credit Note","Credit Note"],["Journal","GST journals"]])+
    '<input class="in" id="g2bSearch" placeholder="Search supplier, GSTIN, invoice…" value="'+esc(G2B_UI.q)+'" style="max-width:260px">'+
    '<span class="spacer"></span><label class="small"><input type="checkbox" id="g2bAll"> Select all ready shown</label>'+
    '<span class="muted small" id="g2bShown"></span></div>'+
    '<div style="overflow:auto"><table class="grid"><thead><tr><th></th><th>Supplier / GSTIN</th>'+
    '<th>Document / date</th><th>Tally supplier</th><th>Purchase ledger</th><th>Taxable</th><th>GST</th><th>Value</th>'+
    '<th>Voucher / status</th><th></th></tr></thead><tbody id="g2bBody"></tbody></table></div>'+
    '<p class="muted small" style="margin:12px 0">Tally is checked for the same document before every post (by supplier GSTIN and invoice number, '+
    'and for amended invoices also the original number). Supplier credit notes post as Debit Notes and supplier debit notes as Credit Notes. '+
    'Reverse charge: the supplier is credited the taxable value only; the GST goes in the RCM journal (ITC and liability). '+
    'ITC N/A entries are posted as in GSTR-2B and flagged in the narration so the ITC can be reversed.</p></div>';
  wireTop(c);
  let shown=[];
  const updateCount=()=>{
    const n=G2B_UI.selected.size;
    $("#g2bSelection").textContent=n+" selected · "+eligibleIds.size+" ready";
    $("#g2bPost").textContent="Post "+n+" selected to Tally";
    const ready=shown.filter(r=>eligibleIds.has(r.id));
    $("#g2bAll").checked=ready.length>0&&ready.every(r=>G2B_UI.selected.has(r.id));
  };
  const renderBody=()=>{
    shown=g2bFilter(rows);
    $("#g2bBody").innerHTML=shown.length?shown.map(r=>g2bRow(r,d)).join(""):'<tr><td colspan="10" class="muted">Nothing here with these filters.</td></tr>';
    $("#g2bShown").textContent=shown.length+" of "+rows.length+" shown";
    updateCount();
  };
  renderBody();
  const run=async(action,body,msg)=>{
    if(G2B_UI.busy)return null;
    G2B_UI.busy=true;
    try{
      const result=await api("/gstr2b-purchases/"+id+"/"+action,{body:body||{}});
      toast(typeof msg==="function"?msg(result):msg);
      await route();return result;
    }catch(e){toast(e.message,true);return null;}
    finally{G2B_UI.busy=false;}
  };
  $("#g2bRefresh").onclick=()=>route();
  $("#g2bStatus").onchange=e=>{G2B_UI.status=e.target.value;renderBody();};
  $("#g2bType").onchange=e=>{G2B_UI.type=e.target.value;renderBody();};
  let typing;
  $("#g2bSearch").oninput=e=>{clearTimeout(typing);typing=setTimeout(()=>{G2B_UI.q=e.target.value;renderBody();},200);};
  $("#g2bAll").onchange=e=>{
    for(const r of shown)if(eligibleIds.has(r.id)){if(e.target.checked)G2B_UI.selected.add(r.id);else G2B_UI.selected.delete(r.id);}
    $$("[data-pick]").forEach(n=>{if(eligibleIds.has(n.dataset.pick))n.checked=G2B_UI.selected.has(n.dataset.pick);});
    updateCount();
  };
  $("#g2bApprove").onchange=e=>{G2B_UI.approved=e.target.checked;};
  $("#g2bDate").onchange=e=>{G2B_UI.dateApproved=e.target.checked;};
  $("#g2bCreateLedger")?.addEventListener("click",()=>{
    const names=(d.ledgers||[]).filter(l=>l.state==="missing").map(l=>l.name).join(", ");
    if(confirm("Create these ledgers under Purchase Accounts in Tally?\n\n"+names))
      run("ensure-ledger",{},"Ledger creation sent to Tally — refresh in a moment");
  });
  $("#g2bCreateSuppliers")?.addEventListener("click",()=>{
    if(!confirm("Create "+missingSuppliers+" supplier ledger(s) in Tally under Sundry Creditors, each with its GSTIN and state?"))return;
    run("create-suppliers",{},r=>r.created+" supplier(s) sent to Tally"+(r.skipped?.length?" · "+r.skipped.length+" skipped (name already in Tally)":"")+" — refresh in a moment");
  });
  $("#g2bSaveMapping")?.addEventListener("click",()=>{
    const fields={};$$("[data-map]").forEach(el=>fields[el.dataset.map]=el.value);
    run("mapping",fields,"GST ledgers saved");
  });
  const submit=async(ids,single)=>{
    if(!ids.length)return toast("Select ready entries first (checkboxes on the left).",true);
    if(!single&&(!G2B_UI.approved||!G2B_UI.dateApproved))
      return toast("Tick BOTH confirmations above the table before posting.",true);
    const selected=ids.map(x=>byId.get(x)).filter(Boolean);
    const byType={};for(const r of selected){const k=r.vtype==="Journal"?G2B_JOURNAL[r.jkind]||"Journal":r.vtype;byType[k]=(byType[k]||0)+1;}
    const desc=selected.length===1?
      selected[0].vtype+" "+selected[0].supplier_invoice+" · "+selected[0].supplier_name+" · "+g2bMoney(selected[0].invoice)+" dated "+selected[0].date:
      Object.entries(byType).map(([k,n])=>n+" × "+k).join("\n");
    if(!confirm("POST TO TALLY:\n"+desc+"\n\nEach is posted on its own document date. Tally is checked for the same document before each one. Continue?"))return;
    // the GST ledgers chosen on screen are saved first, so a pick that wasn't saved never blocks posting
    const fields={};$$("[data-map]").forEach(el=>fields[el.dataset.map]=el.value);
    if(Object.keys(fields).length&&Object.entries(fields).some(([k,v])=>v!==(mapping[k]||""))){
      try{await api("/gstr2b-purchases/"+id+"/mapping",{body:fields});}
      catch(e){return toast("GST ledgers: "+e.message,true);}
    }
    const result=await run("post",{ids,confirmed:true,confirmedDate:true},r=>"Queued "+r.queued+" for Tally"+
      (r.skipped_count?" · "+r.skipped_count+" held back — the reason is on each (filter: All entries)":""));
    if(result)for(const x of ids)G2B_UI.selected.delete(x);
  };
  $("#g2bPost").onclick=()=>submit([...G2B_UI.selected].filter(x=>eligibleIds.has(x)),false);
  $("#g2bRecheck").onclick=()=>{
    if(confirm("Check uncertain or duplicate entries against Tally again? Nothing is posted."))
      run("recheck",{},r=>"Checked "+r.checked+": "+r.present+" in Tally, "+r.ready+" ready again");
  };
  $("#g2bRecheckPosted").onclick=()=>{
    if(confirm("Check every posted entry is still in Tally? Any deleted in Tally become ready to post again. Nothing is posted."))
      run("recheck",{includePosted:true},r=>r.removed+" no longer in Tally (ready again) · "+r.posted+" still there");
  };
  // one listener for the whole table (1000+ rows)
  const body=$("#g2bBody");
  body.addEventListener("change",e=>{
    const t=e.target;
    if(t.dataset.pick){if(t.checked)G2B_UI.selected.add(t.dataset.pick);else G2B_UI.selected.delete(t.dataset.pick);updateCount();return;}
    if(t.dataset.vtype){
      const r=byId.get(t.dataset.vtype),type=t.value;
      if(!r||type===r.vtype)return;
      const portalCredit=["CDNR","CDNRA"].includes(r.source_section)&&r.source_note==="C";
      const amended=["ECOA","CDNRA","B2BA"].includes(r.source_section);
      if(type==="Debit Note"&&!portalCredit&&!confirm("Is "+r.supplier_invoice+" from "+r.supplier_name+" really a supplier CREDIT note (a reduction in purchases and ITC)?"+
        (amended?"\n\nIt is an amended document: confirm it has not already been entered.":""))){t.value=r.vtype;return;}
      run("type",{id:r.id,vtype:type,confirmCredit:true,confirmAmendment:amended},r.supplier_invoice+" will post as "+type);
    }
  });
  body.addEventListener("click",e=>{
    const t=e.target.closest("button");
    if(!t)return;
    if(t.dataset.postOne)return submit([t.dataset.postOne],true);
    if(t.dataset.saveparty){
      const node=document.querySelector('[data-party="'+t.dataset.saveparty+'"]');
      if(!node?.value)return toast("Choose a matching supplier",true);
      return run("party",{id:t.dataset.saveparty,ledger:node.value},"Supplier matched (also on this supplier's other entries)");
    }
    if(t.dataset.createSupplier){
      const r=byId.get(t.dataset.createSupplier);
      if(!r||!confirm("Create supplier '"+r.supplier_name+"' in Tally under Sundry Creditors with GSTIN "+r.supplier_gstin+
        "?\n\nIf this supplier already exists in Tally, CANCEL and add the GSTIN to that ledger instead."))return;
      return run("create-supplier",{id:r.id},"Supplier sent to Tally — refresh in a moment");
    }
    if(t.dataset.markCredit){
      const r=byId.get(t.dataset.markCredit);
      if(!r)return;
      const amended=["ECOA","CDNRA","B2BA"].includes(r.source_section);
      if(!confirm("Supplier credit note?\n\n"+r.supplier_name+" — "+r.supplier_invoice+"\nValue "+g2bMoney(r.invoice)+" · "+r.date+
        "\n\nConfirm you checked the supplier's ORIGINAL credit note. It will post as a Tally DEBIT NOTE."+
        (amended?"\n\nAmended document: confirm it has NOT already been entered.":"")))return;
      return run("type",{id:r.id,vtype:"Debit Note",confirmCredit:true,confirmAmendment:amended},"Will post as Debit Note");
    }
  });
  if(rows.some(r=>r.status==="queued")||d.ledgersPending)every(7000,()=>{if(location.hash==="#/p2b/"+id&&!G2B_UI.busy)route();});
}
