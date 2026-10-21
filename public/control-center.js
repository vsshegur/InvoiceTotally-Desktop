/* Accounting control centre. Classic script loaded by InvoiceTotally after app.js.
 * Read-only overviews, user-approved mappings, local-only GST summary review. */
const CC={
  amount(x){return x===null||x===undefined?"—":Number(x).toLocaleString("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2});},
  ago(x){return x?new Date(x*1000).toLocaleString("en-IN"):"Not refreshed"},
  field(n){return {taxable:"Taxable value",igst:"IGST",cgst:"CGST",sgst:"SGST",cess:"Cess",
    itcIgst:"ITC IGST",itcCgst:"ITC CGST",itcSgst:"ITC SGST",itcCess:"ITC Cess"}[n]||n;},
  safeClass(st){return st==="matched"?"good":st==="different"?"bad":"muted";}
};
async function viewDashboard(){
  const data=await api("/dashboard");
  const cards=data.companies||[];
  app().innerHTML=topBar([["Multi-company dashboard"]])+
    '<div class="page wide"><div class="bar" style="border:0;padding:0 0 14px"><h1>Multi-company accounts</h1><div class="spacer"></div>'+
    '<span class="muted small">Ledger balances are from last read-only Tally snapshot; never live bank feeds.</span></div>'+
    (!cards.length?'<div class="card empty">No companies available. Add a Tally company first.</div>':
      '<div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">'+
        cards.map(c=>{
          const b=c.balances||{},counts=c.counts||{},jobs=counts.jobs||{},invoices=counts.invoices||{},gst=counts.gst||{};
          const label=(name,value)=>'<div><span>'+name+'</span><b>'+CC.amount(value)+'</b></div>';
          return '<div class="card" style="padding:18px"><h2 style="margin:0">'+esc(c.name)+'</h2>'+
            '<div class="muted small">'+esc(c.gstin||"GSTIN not configured")+'</div>'+
            '<p class="muted small" style="margin:8px 0">Tally ledger snapshot: '+CC.ago(c.fetched_at)+'</p>'+
            (c.balances?'<div class="kv">'+
              label("Bank/cash ledger net",b.bank)+label("Debtors net",b.receivables)+label("Creditors net",b.payables)+
              label("Sales Accounts balances",b.sales)+label("Purchase Accounts balances",b.purchases)+
              label("Duties & Taxes net ledger",b.taxLedger)+'</div>':
              '<div class="alert warn">No Tally ledger balance snapshot saved. Read it below.</div>')+
            '<p class="muted small" style="margin:12px 0">'+(invoices.review||0)+' invoices to review · '+
            (jobs.pending||0)+' pending Tally jobs · '+(gst.mismatch||0)+' 2B mismatches</p>'+
            '<button class="btn sm" data-refresh="'+esc(c.id)+'">⟳ Read Tally balances</button> '+
            '<a class="btn sm primary" href="#/c/'+esc(c.id)+'">Open company</a></div>';
        }).join("")+'</div>')+
    '<p class="muted small" style="margin-top:18px">These are net ledger closing balances, not final P&L, bank statement balances or filed GST liabilities. Read-only Tally refresh uses local port 9000 and does not change vouchers.</p></div>';
  wireTop();
  $$("[data-refresh]").forEach(btn=>btn.onclick=async()=>{
    btn.disabled=true;
    try{const res=await api("/dashboard/refresh/"+btn.dataset.refresh,{body:{}});toast(res.ledgers+" ledger balances refreshed");route();}
    catch(e){toast(e.message,true);btn.disabled=false;}
  });
}
async function companySmartMappings(c,el){
  const data=await api("/companies/"+c.id+"/smart-maps");
  const rows=data.pending||[];
  el.innerHTML='<div class="card" style="margin-bottom:16px;padding:16px"><h2 style="margin:0 0 6px">Smart ledger &amp; stock matching</h2>'+
    '<p class="muted">Suggested by name, GSTIN, HSN, GST rate and units. Hard conflicts cannot be approved. Every decision is reviewed and remembered only for this company; no master is created or altered in Tally.</p>'+
    '<div class="muted small">'+data.unresolved+' unresolved entries · '+data.learned+' learned mappings</div></div>'+
    (rows.length?'<div style="overflow:auto"><table class="grid"><thead><tr><th>Type</th><th>Invoice line / party</th><th>Tally master suggestions</th><th></th></tr></thead><tbody>'+
      rows.map((r,i)=>{
        const choices=r.candidates||[];
        const opts='<option value="">— choose a compatible match —</option>'+
          choices.map(p=>'<option value="'+esc(p.name)+'" '+(p.conflicts?.length?'disabled':'')+'>'+
            esc(p.name)+' · '+Math.round(p.score||0)+'%'+(p.conflicts?.length?' (conflict: '+esc(p.conflicts.join("; "))+')':'')+'</option>').join('');
        return '<tr><td>'+esc(r.kind)+'</td><td><b>'+esc(r.description||"")+'</b>'+
          '<div class="muted small">Invoice '+esc(r.invoice_id.slice(0,9))+
          (r.context?.hsn?' · HSN '+esc(r.context.hsn):'')+
          (r.context?.unit?' · Unit '+esc(r.context.unit):'')+
          (r.context?.gstin?' · GSTIN '+esc(r.context.gstin):'')+'</div></td>'+
          '<td><select class="in cc-suggest" data-suggest="'+i+'" style="min-width:220px">'+opts+'</select></td>'+
          '<td><button class="btn sm" data-remember="'+i+'">Remember</button></td></tr>';
      }).join('')+'</tbody></table></div>':
      '<div class="card empty">All reviewed invoice parties, stock items and charge ledgers are resolved.</div>');
  $$("[data-remember]",el).forEach(btn=>btn.onclick=async()=>{
    const i=+btn.dataset.remember,r=rows[i];
    const name=el.querySelector('[data-suggest="'+i+'"]')?.value;
    if(!name)return toast("Select one compatible Tally master",true);
    if(!confirm('Remember "'+r.description+'" → "'+name+'" for '+c.name+'? This can rematch pending invoices, but never posts to Tally.'))return;
    btn.disabled=true;
    try{
      await api("/companies/"+c.id+"/smart-maps/learn",{body:{
        kind:r.kind,invoice_id:r.invoice_id,line_id:r.line_id||null,master:name
      }});
      toast("Mapping remembered and pending invoice rechecked");refresh();
    }catch(e){toast(e.message,true);btn.disabled=false;}
  });
}
async function companyAudit(c,el){
  const data=await api("/companies/"+c.id+"/posting-audit?limit=500");
  const rows=data.rows||[],integrity=data.integrity||{};
  const phase={attempt:"Attempted",created:"Created",rejected:"Rejected",uncertain:"Check in Tally",
    duplicate_blocked:"Duplicate blocked",not_sent:"Not sent"};
  el.innerHTML='<div class="card" style="margin-bottom:16px;padding:16px"><h2 style="margin:0 0 6px">Tally posting audit &amp; recovery</h2>'+
    '<p class="muted">Every Tally write attempt and response is recorded locally with a payload hash. Rejections and uncertain outcomes remain visible; never retry an uncertain voucher until you check Tally first.</p>'+
    '<p class="'+(integrity.ok?'good':'bad')+'">'+(integrity.ok?'✓ Audit chain verified':'⚠ Audit log integrity check failed')+
    ' · '+(integrity.events||0)+' events</p>'+
    '<button class="btn" id="ccExportAudit">Export displayed audit as CSV</button></div>'+
    (rows.length?'<div style="overflow:auto"><table class="grid"><thead><tr><th>When</th><th>Operation</th><th>Result</th><th>Details</th><th>Voucher/Job</th></tr></thead><tbody>'+
      rows.map(r=>'<tr><td class="muted">'+CC.ago(r.at)+'</td><td>'+esc(r.kind)+'</td>'+
        '<td class="'+(r.phase==="created"?"good":r.phase==="rejected"||r.phase==="uncertain"?"bad":"muted")+'">'+
        esc(phase[r.phase]||r.phase)+'</td><td class="small">'+esc(r.detail||"")+'</td>'+
        '<td class="mono small">'+esc((r.invoice_id||r.job_id||"").slice(0,16))+'</td></tr>').join('')+'</tbody></table></div>':
      '<div class="card empty">No Tally posting events recorded yet. Earlier versions did not maintain this audit log.</div>');
  $('#ccExportAudit')?.addEventListener('click',()=>{
    const header=["Date","Company","Job","Voucher","Kind","Phase","Details","Payload SHA256","Entry hash"];
    const quote=x=>'"'+String(x??"").replace(/"/g,'""')+'"';
    const csv=[header,...rows.map(r=>[new Date(r.at*1000).toISOString(),c.name,r.job_id,r.invoice_id,r.kind,r.phase,r.detail,r.payload_sha256,r.entry_hash])]
      .map(row=>row.map(quote).join(",")).join("\r\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download="InvoiceTotally_Tally_Audit_"+c.name.replace(/[^a-z0-9-]/gi,"_")+".csv";a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  });
}
const GST_HEADERS=["taxable","igst","cgst","sgst","cess"];
const GST_ITC=["itcIgst","itcCgst","itcSgst","itcCess"];
async function companyGstControl(c,el){
  const d=new Date(),defaultPeriod=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
  const period=sessionStorage.getItem("it_gst_control_period_"+c.id)||defaultPeriod;
  el.innerHTML='<div class="card" style="padding:16px"><h2 style="margin:0 0 8px">GSTR-1 / GSTR-2B / GSTR-3B reconciliation</h2>'+
    '<p class="muted">Read sales and purchases from Tally, enter portal filing summary figures for GSTR-1 and 3B, and compare ITC against your existing GSTR-2B imports. Nothing is filed or posted.</p>'+
    '<div class="field" style="max-width:220px"><label>GST return month</label><input id="ccGstMonth" type="month" class="in" value="'+esc(period)+'"></div>'+
    '<div id="ccGstControl"></div></div>';
  $('#ccGstMonth').onchange=()=>{
    sessionStorage.setItem("it_gst_control_period_"+c.id,$('#ccGstMonth').value);companyGstControl(c,el);
  };
  const s=await api("/companies/"+c.id+"/gst-control/"+period);
  const inputForm=(kind,keys,values)=>{
    return '<div class="card" style="flex:1;min-width:320px;padding:14px"><b>'+kind.toUpperCase()+' portal figures</b>'+
      '<p class="muted small">Enter amounts from the official return summary for this exact month. Blank means unavailable, not zero.</p>'+
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">'+keys.map(k=>
        '<label class="field"><span class="small">'+CC.field(k)+'</span><input class="in ccGstNum" data-kind="'+kind+
        '" data-head="'+k+'" type="number" step="0.01" value="'+(values?.[k]??"")+'" placeholder="Not provided"></label>').join('')+
      '</div><button class="btn primary" data-save="'+kind+'">Save '+kind.toUpperCase()+' figures</button></div>';
  };
  const comparison=(label,report)=>{
    if(!report)return "";
    return '<div class="card" style="flex:1;min-width:300px;padding:14px"><b>'+label+'</b>'+
      '<table class="grid"><tbody>'+Object.entries(report).map(([key,value])=>
        '<tr><td>'+CC.field(key)+'</td><td class="'+CC.safeClass(value.status)+'">'+
        (value.status==="missing"?"Not available":value.status==="matched"?"Matched":'Diff '+CC.amount(value.difference))+'</td></tr>').join('')+
      '</tbody></table></div>';
  };
  const r=s.result||{},b=s.gstr2b,ts=s.tally_sales,tp=s.tally_purchases;
  $('#ccGstControl').innerHTML='<div style="display:flex;flex-wrap:wrap;gap:12px;margin:16px 0">'+
    inputForm("gstr1",GST_HEADERS,s.portal_gstr1)+inputForm("gstr3b",GST_HEADERS.concat(GST_ITC),s.portal_gstr3b)+'</div>'+
    '<div class="card" style="padding:14px;margin-bottom:12px"><b>Available Tally and GSTR-2B evidence</b>'+
    '<div class="kv" style="margin:10px 0">'+
      '<div><span>Sales taxable value</span><b>'+CC.amount(ts?.taxable)+'</b></div>'+
      '<div><span>Sales output GST</span><b>'+CC.amount(ts?ts.igst+ts.cgst+ts.sgst+ts.cess:null)+'</b></div>'+
      '<div><span>Purchase input GST</span><b>'+CC.amount(tp?tp.igst+tp.cgst+tp.sgst+tp.cess:null)+'</b></div>'+
      '<div><span>GSTR-2B eligible ITC</span><b>'+CC.amount(b?.itc?
        b.itc.igst+b.itc.cgst+b.itc.sgst+b.itc.cess:null)+'</b></div></div>'+
    '<button class="btn" id="ccReadGst">⟳ Read Tally sales &amp; purchases</button> '+
    '<button class="btn primary" id="ccReconcileGst">Compare all three returns</button> '+
    '<a class="btn" href="#/c/'+c.id+'/gstr2b">Open GSTR-2B</a></div>'+
    ((r.warnings||[]).length?'<div class="alert warn" style="margin:12px 0">'+r.warnings.map(esc).join(" · ")+'</div>':'')+
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin:16px 0">'+
      comparison("Tally Sales vs GSTR-1",r.salesToPortal)+comparison("GSTR-1 vs GSTR-3B",r.portalTo3b)+
      comparison("GSTR-2B ITC vs GSTR-3B",r.itc2bVs3b)+comparison("Tally purchase ITC vs GSTR-2B",r.itcBooksVs2b)+'</div>'+
    '<p class="muted small">GST control is a reconciliation aid, not an official filing or legal ITC determination. Unclassified stock/sales ledgers and unusual journals must be reviewed by your accountant.</p>';
  $$('[data-save]',el).forEach(btn=>btn.onclick=async()=>{
    const kind=btn.dataset.save;
    const fields=$$('.ccGstNum[data-kind="'+kind+'"]',el);
    const summary=Object.fromEntries(fields.map(f=>[f.dataset.head,f.value===""?null:Number(f.value)]));
    btn.disabled=true;
    try{await api("/companies/"+c.id+"/gst-control/"+period+"/portal",{body:{kind,summary}});toast(kind.toUpperCase()+" totals saved");companyGstControl(c,el);}
    catch(e){toast(e.message,true);btn.disabled=false;}
  });
  $('#ccReadGst').onclick=async()=>{
    const btn=$('#ccReadGst');btn.disabled=true;
    try{await api("/companies/"+c.id+"/gst-control/"+period+"/refresh",{body:{}});toast("Read Tally GST vouchers");companyGstControl(c,el);}
    catch(e){toast(e.message,true);btn.disabled=false;}
  };
  $('#ccReconcileGst').onclick=async()=>{
    const btn=$('#ccReconcileGst');btn.disabled=true;
    try{await api("/companies/"+c.id+"/gst-control/"+period+"/reconcile",{body:{}});toast("GST comparison updated");companyGstControl(c,el);}
    catch(e){toast(e.message,true);btn.disabled=false;}
  };
}
