/* Accounting control centre. Loaded before app.js so its dashboard route is registered safely.
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
    '<div class="muted small">'+data.unresolved+' unresolved entries · '+data.learned+' learned mappings</div>'+
    '<button class="btn sm" id="ccExportMappings" style="margin-top:9px">Download remembered mappings CSV</button></div>'+
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
  $('#ccExportMappings')?.addEventListener('click',async()=>{
    try{
      const result=await api('/companies/'+c.id+'/smart-maps/export');
      const csv=[['Type','Source','Tally Master'],...(result.mappings||[]).map(m=>[m.kind,m.key,m.value])]
        .map(row=>row.map(x=>'"'+String(x||'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
      const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;
      a.download='InvoiceTotally_Mappings_'+c.name.replace(/[^a-z0-9-]/gi,'_')+'.csv';
      a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
    }catch(e){toast(e.message,true);}
  });
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
// Display the evidence behind each GSTR-1 comparison, not just one net difference.
function gstr1Breakup(x){
  const b=x.breakdown,portal=x.portal||{},tally=x.tally||{};
  const heads=[["taxable","Taxable value"],["igst","IGST"],["cgst","CGST"],["sgst","SGST"],["cess","Cess"]];
  const line=(label,amount)=>'<tr><td>'+label+'</td><td class="mono" style="text-align:right">'+CC.amount(amount)+'</td></tr>';
  const title='<div class="small muted" style="margin:8px 0">Tally voucher '+esc(x.tally_number||"—")+
    (x.party?' · '+esc(x.party):'')+(x.tally_date?' · '+esc(x.tally_date):'')+
    (x.portal_date?' · GSTR-1 date '+esc(x.portal_date):'')+'</div>';
  const base=b?'<b>Taxable calculation from Tally</b><table class="grid"><tbody>'+
    line(b.base_source==="inventory"?"Stock/item total":"Sales ledger base",b.base)+
    line("Less: sales discount",-(b.discount||0))+
    line("Add: freight / transport",b.freight||0)+
    line("Add: packing / other charges",b.other_charges||0)+
    line("<b>Calculated taxable value</b>",b.taxable)+
    line("GST total",(tally.igst||0)+(tally.cgst||0)+(tally.sgst||0)+(tally.cess||0))+
    line("Round off (outside taxable)",b.round_off||0)+
    line("<b>Estimated voucher total</b>",b.estimated_invoice_value)+'</tbody></table>':
    '<p class="muted small">Detailed Tally adjustments are not cached. Read Tally sales again and compare to refresh the breakdown.</p>';
  const tax='<b>Side-by-side GSTR-1 vs Tally</b><table class="grid"><thead><tr><th>Field</th><th>Tally</th><th>GSTR-1</th><th>Difference</th></tr></thead><tbody>'+
    heads.map(([key,label])=>'<tr><td>'+label+'</td><td>'+CC.amount(tally[key]??null)+'</td>'+
      '<td>'+CC.amount(portal[key]??null)+'</td>'+
      '<td class="'+(Math.abs((tally[key]||0)-(portal[key]||0))>1?'bad':'good')+'">'+
        (tally[key]===undefined||portal[key]===undefined?'—':CC.amount(tally[key]-portal[key]))+
      '</td></tr>').join("")+'</tbody></table>';
  const adjustments=(b?.ledger_lines||[]).length?
    '<b>Individual Tally adjustment ledgers</b><table class="grid"><thead><tr><th>Ledger</th><th>Classification</th><th>Amount (signed)</th></tr></thead><tbody>'+
    b.ledger_lines.map(l=>'<tr><td>'+esc(l.name)+'</td><td>'+esc(({
      discount:"Reduces taxable",freight:"Adds to taxable",other_charge:"Adds to taxable",
      round_off:"Outside taxable",unclassified:"Check mapping / GST treatment"
    })[l.kind]||l.kind)+'</td><td>'+CC.amount(l.amount)+'</td></tr>').join("")+'</tbody></table>':"";
  const differences=(x.differences||[]).length?
    '<p class="small bad">Fields that differ: '+x.differences.map(d=>esc(d.label)).join(", ")+'</p>':"";
  return '<details class="small" style="min-width:220px"><summary style="cursor:pointer">View calculation &amp; ledger lines</summary>'+
    '<div style="min-width:340px;max-width:740px;padding:8px 0">'+title+
    '<p class="small">'+esc(x.explanation||"")+'</p>'+differences+base+tax+adjustments+
    ((b?.unclassified||[]).length?'<p class="small bad">Unclassified ledger line(s) require manual review. They were not silently added to taxable value.</p>':"")+
    '</div></details>';
}
const GST_INVOICE_STATUS={matched:"Matched",tax_mismatch:"Amount mismatch",gstin_mismatch:"Buyer GSTIN mismatch",
  review_unclassified:"Check ledger mapping",missing_in_tally:"Not in Tally",missing_in_gstr1:"Not in GSTR-1"};
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
      '</div><div class="field" style="margin:10px 0"><label>Import '+kind.toUpperCase()+' '+(kind==="gstr3b"?"filed return PDF":"GST portal JSON")+' (offline)</label>'+
      (kind==="gstr3b"?
        '<input class="in" data-gstr3b-pdf="1" type="file" accept=".pdf,application/pdf">'+
        '<p class="muted small">Choose the <b>filed</b> GSTR-3B PDF (not the system-generated draft). Reads Table 3.1(a) and Table 4(C) Net ITC. Review all amounts and click Save.</p>'+
        '<div id="ccGstr3bPdfPreview" class="muted small" aria-live="polite"></div>':
        '<input class="in" data-json="'+kind+'" type="file" accept=".json,application/json">')+
      '</div><button class="btn primary" data-save="'+kind+'">Save '+kind.toUpperCase()+' figures</button></div>';
  };
  // Show source invoices and the reason for each difference by GST head.
  const itcExplanation=(head,mode)=>{
    const all=r.itcDiagnostics,d=all?.heads?.[head];
    if(!d)return "";
    const books=mode==="books",lines=books?d.evidence_lines:d.eligible_lines;
    const total=(label,val)=>'<div style="display:flex;justify-content:space-between;gap:12px;margin:4px 0"><span>'+label+'</span><b>'+CC.amount(val)+'</b></div>';
    const stats=books?
      total("Tally GST in selected month",d.tally)+total("GSTR-2B eligible GST",d.gstr2b)+
      total("Tally-only (+)",d.tally_only_total)+total("2B invoices not in monthly books (−)",-d.portal_only_total)+
      total("Paired invoices with GST-head differences",d.matched_difference_total)+
      total("Explained difference (Tally − 2B)",d.books_vs_2b_explained_delta):
      total("Eligible GSTR-2B ITC",d.gstr2b)+total("Claimed GSTR-3B ITC",d.gstr3b)+
      total("Difference (2B − 3B)",d.gstr2b_vs_3b);
    const intro=books?
      'Each row contributes to Tally minus 2B. A supplier invoice appearing in this return might have been booked in an earlier month.':
      'These are the invoices and credit notes behind the GSTR-2B total. GSTR-3B provides only a claim total; it does not identify which invoice explains the claim difference.';
    const warning=(books&&!all.complete?'<p class="small warn">Read Tally again to refresh invoice-level details; the difference is not fully traceable from old or truncated data.</p>':"")+
      (b?.evidence_truncated?'<p class="small warn">Some GSTR-2B source invoices are not shown because the list is large.</p>':"");
    const table=lines?.length?
      '<div style="overflow:auto;max-height:340px"><table class="grid"><thead><tr>'+
      '<th>Source and reason</th><th>Supplier / invoice</th><th>Invoice date</th><th>Tally voucher / date</th><th>Amount</th></tr></thead><tbody>'+
      lines.map(x=>'<tr><td>'+esc(x.source||"GSTR-2B")+
        '<div class="muted small" style="max-width:270px">'+esc(x.reason||"")+'</div></td>'+
        '<td><b>'+esc(x.party||"")+'</b><div class="mono small">'+esc(x.num||"")+'</div>'+
        '<div class="muted small">'+esc(x.gstin||"")+'</div></td>'+
        '<td>'+esc(x.date||"—")+'</td><td>'+esc(x.tally_voucher||"—")+
        '<div class="muted small">'+esc(x.booked_date||"")+'</div></td>'+
        '<td class="mono">'+CC.amount(x.value)+'</td></tr>').join("")+
      '</tbody></table></div>':'<p class="muted small">No contributing invoice records found for this tax head.</p>';
    return '<details style="margin:5px 0 9px"><summary style="cursor:pointer" class="small">View source invoices &amp; why</summary>'+
      '<div style="padding:10px 0;min-width:270px"><p class="small muted">'+esc(intro)+'</p>'+stats+warning+table+
      (b?.return_id?'<p class="small"><a href="#/c/'+esc(c.id)+'/gstr2b">Open full GSTR-2B panel</a></p>':"")+
      '</div></details>';
  };
  const comparison=(label,report,mode="")=>{
    if(!report)return "";
    return '<div class="card" style="flex:1;min-width:300px;padding:14px"><b>'+label+'</b>'+
      (mode?'<p class="muted small">'+(mode==="books"?
        'Tally purchase vouchers by booking date versus supplier invoices in this GSTR-2B filing month.':
        'Eligible GSTR-2B versus GSTR-3B claimed credit; adjustments cannot be identified from the summary alone.')+'</p>':"")+
      '<table class="grid"><tbody>'+Object.entries(report).map(([key,value])=>
        '<tr><td>'+CC.field(key)+'</td><td class="'+CC.safeClass(value.status)+'">'+
        (value.status==="missing"?"Not available":value.status==="matched"?"Matched":'Diff '+CC.amount(value.difference))+
        (mode?itcExplanation(key,mode):"")+'</td></tr>').join('')+
      '</tbody></table></div>';
  };
  const r=s.result||{},b=s.gstr2b,ts=s.tally_sales,tp=s.tally_purchases;
  const oldSales=Boolean(ts&&ts.calculation_version!==2);
  const missingPurchaseEvidence=Boolean(tp&&!Array.isArray(tp.docs));
  $('#ccGstControl').innerHTML='<div style="display:flex;flex-wrap:wrap;gap:12px;margin:16px 0">'+
    inputForm("gstr1",GST_HEADERS,s.portal_gstr1)+inputForm("gstr3b",GST_HEADERS.concat(GST_ITC),s.portal_gstr3b)+'</div>'+
    (oldSales?'<div class="alert warn" style="margin-bottom:12px"><b>Re-read Tally sales to apply the discount/freight correction.</b> The saved sales snapshot uses the older calculation; previous invoice mismatches are hidden until you click “Read Tally sales & purchases”, then “Compare all three returns”.</div>':"")+
    (missingPurchaseEvidence?'<div class="alert warn" style="margin-bottom:12px"><b>Read Tally again for purchase invoice details.</b> Old purchase totals have no voucher-level breakdown, so the difference cannot yet be fully explained.</div>':"")+
    '<div class="card" style="padding:14px;margin-bottom:12px"><b>Available Tally and GSTR-2B evidence</b>'+
    '<div class="kv" style="margin:10px 0">'+
      '<div><span>Sales taxable value</span><b>'+CC.amount(oldSales?null:ts?.taxable)+'</b></div>'+
      '<div><span>Sales output GST</span><b>'+CC.amount(oldSales?null:ts?ts.igst+ts.cgst+ts.sgst+ts.cess:null)+'</b></div>'+
      '<div><span>Purchase input GST</span><b>'+CC.amount(tp?tp.igst+tp.cgst+tp.sgst+tp.cess:null)+'</b></div>'+
      '<div><span>GSTR-2B eligible ITC</span><b>'+CC.amount(b?.itc?
        b.itc.igst+b.itc.cgst+b.itc.sgst+b.itc.cess:null)+'</b></div></div>'+
    '<button class="btn" id="ccReadGst">⟳ Read Tally sales &amp; purchases</button> '+
    '<button class="btn primary" id="ccReconcileGst">Compare all three returns</button> '+
    '<a class="btn" href="#/c/'+c.id+'/gstr2b">Open GSTR-2B</a></div>'+
    ((r.warnings||[]).length?'<div class="alert warn" style="margin:12px 0">'+r.warnings.map(esc).join(" · ")+'</div>':'')+
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin:16px 0">'+
      comparison("Tally Sales vs GSTR-1",oldSales?null:r.salesToPortal)+comparison("GSTR-1 vs GSTR-3B",r.portalTo3b)+
      comparison("GSTR-2B ITC vs GSTR-3B",r.itc2bVs3b,"portal")+comparison("Tally purchase ITC vs GSTR-2B",r.itcBooksVs2b,"books")+'</div>'+
    (!oldSales&&(r.invoices||[]).length?(()=>{
      const invoices=r.invoices||[],mismatches=invoices.filter(x=>x.status!=="matched"),matches=invoices.filter(x=>x.status==="matched");
      const ordered=[...mismatches,...matches];
      return '<details style="margin-bottom:18px" open><summary style="cursor:pointer"><b>GSTR-1 B2B invoices checked ('+
        invoices.length+') — '+matches.length+' matched, '+mismatches.length+' need attention</b></summary>'+
        '<p class="muted small" style="margin:10px 0">Differences are Tally minus GSTR-1. Voucher-level discounts reduce taxable; taxable freight and charges increase it. Click the breakdown on any invoice for its actual ledger amounts.</p>'+
        '<div style="overflow:auto;margin-top:10px"><table class="grid"><thead><tr>'+
        '<th>Invoice / Tally no.</th><th>Buyer GSTIN</th><th>Status &amp; reason</th>'+
        '<th>Tally taxable</th><th>GSTR-1 taxable</th><th>Taxable difference</th><th>GST difference</th><th>Details</th></tr></thead><tbody>'+
        ordered.slice(0,500).map(x=>'<tr><td><b>'+esc(x.number)+'</b>'+
          (x.tally_number&&x.tally_number!==x.number?'<div class="muted small">Tally '+esc(x.tally_number)+'</div>':"")+
          '</td><td class="mono small">'+esc(x.gstin||"")+'</td>'+
          '<td class="'+(x.status==="matched"?"good":x.status==="review_unclassified"?"muted":"bad")+'">'+
          esc(GST_INVOICE_STATUS[x.status]||x.status||"Unknown")+
          '<div class="small muted" style="max-width:280px">'+esc(x.explanation||"")+'</div></td>'+
          '<td>'+CC.amount(x.tally?.taxable??null)+'</td>'+
          '<td>'+CC.amount(x.portal?.taxable??null)+'</td>'+
          '<td>'+CC.amount(x.taxable_difference)+'</td><td>'+CC.amount(x.tax_difference)+'</td>'+
          '<td>'+gstr1Breakup(x)+'</td></tr>').join('')+
        '</tbody></table></div>'+
        (ordered.length>500?'<p class="muted small">Showing first 500 invoices; totals above include all checked invoices.</p>':"")+
        '</details>';
    })():'')+
    '<p class="muted small">GST control is a reconciliation aid, not an official filing or legal ITC determination. Unclassified stock/sales ledgers and unusual journals must be reviewed by your accountant.</p>';
  $$("[data-json]",el).forEach(input=>input.onchange=async()=>{
    const file=input.files?.[0],kind=input.dataset.json;
    if(!file)return;
    try{
      if(!/\.json$/i.test(file.name)||file.size>12*1024*1024)
        throw new Error("Choose a GSTR-1 portal JSON file under 12 MB");
      const {parsePortalJson}=await import("/gst-control-parse.js");
      const data=parsePortalJson(JSON.parse(await file.text()),kind,{period,gstin:c.gstin});
      if(!confirm("Import "+kind.toUpperCase()+" from "+file.name+"? Detected "+data.records+
        " records. Taxable "+CC.amount(data.summary.taxable)+
        "; CGST "+CC.amount(data.summary.cgst)+"; SGST "+CC.amount(data.summary.sgst)+
        "; IGST "+CC.amount(data.summary.igst)+". Please verify the month and GSTIN."))return;
      await api("/companies/"+c.id+"/gst-control/"+period+"/portal",{body:{
        kind,summary:data.summary,docs:data.docs||[]
      }});
      toast(kind.toUpperCase()+" portal JSON read offline and saved");companyGstControl(c,el);
    }catch(e){toast(e.message,true);input.value="";}
  });
  const pdfInput=$('[data-gstr3b-pdf]',el);
  if(pdfInput)pdfInput.onchange=async()=>{
    const file=pdfInput.files?.[0];if(!file)return;
    const preview=$('#ccGstr3bPdfPreview',el);
    try{
      preview.textContent="Reading GSTR-3B PDF locally…";
      const {readGstr3bPdf}=await import("/gstr3b-pdf.js");
      const report=await readGstr3bPdf(file,{period,gstin:c.gstin});
      for(const field of $('.ccGstNum[data-kind="gstr3b"]',el)){
        const amount=report.summary[field.dataset.head];
        if(Number.isFinite(amount))field.value=String(amount);
      }
      preview.innerHTML='<div class="alert warn" style="margin-top:8px"><b>PDF figures extracted — not yet saved.</b>'+
        '<div>File: '+esc(file.name)+' · GSTIN '+esc(report.gstin)+' · Month '+esc(report.period)+'</div>'+
        '<div>Table '+esc(report.evidence.outward.table)+' page '+report.evidence.outward.page+
        ' · Table '+esc(report.evidence.itc.table)+' page '+report.evidence.itc.page+'</div>'+
        '<div>Please verify taxable and all GST-head values against the filed PDF before clicking Save GSTR-3B figures. No external service was contacted.</div></div>';
      toast("GSTR-3B PDF read offline. Verify values and Save.");
    }catch(error){preview.textContent=error.message;toast(error.message,true);}
  };
  $('[data-save]',el).forEach(btn=>btn.onclick=async()=>{
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
