/* Vipul Workplace — GST control workspace.
 * All views reflect stored portal/Tally evidence; nothing is filed or posted.
 * Reading/refreshing registers is done only with an explicit button. */
const GSTWorkplace=(()=>{
  const safe=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const cur=x=>x==null?"—":Number(x).toLocaleString("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2});
  const heads=["igst","cgst","sgst","cess"];
  const tax=v=>heads.reduce((n,h)=>n+(Number(v?.[h])||0),0);
  const table=(columns,rows)=>'<div style="overflow:auto;max-height:420px"><table class="grid"><thead><tr>'+columns.map(c=>'<th>'+safe(c)+'</th>').join("")+
    '</tr></thead><tbody>'+rows.join("")+'</tbody></table></div>';
  const rowsOf=(xs,fn)=>xs.map((x,i)=>'<tr>'+fn(x,i).map(v=>'<td>'+v+'</td>').join("")+'</tr>');
  const chip=(ready,label)=>'<span class="'+(ready?"good":"warn")+'" style="margin-right:12px">'+(ready?"✓ ":"○ ")+safe(label)+'</span>';
  const disclosure=(name,body,open=false)=>'<details class="card" style="padding:14px;margin:10px 0"'+(open?" open":"")+'><summary style="cursor:pointer"><b>'+safe(name)+'</b></summary><div style="padding-top:12px">'+body+'</div></details>';
  const alert=(msg)=>'<p class="muted small">'+safe(msg)+'</p>';
  const moneyRow=(head,a,b,c)=>'<tr><td>'+head.toUpperCase()+'</td><td>'+cur(a)+'</td><td>'+cur(b)+'</td><td class="'+(c!=null&&Math.abs(c)>1?"bad":"good")+'">'+cur(c)+'</td></tr>';
  const totals=(v)=>v?Object.values(v).reduce((n,x)=>n+(Number(x)||0),0):null;
  const asMoney=x=>cur(x);
  function itcDetails(record){
    const r=record.reversal,c=record.claim||{};
    const gross=r?.available,back=r?.reversed,net=r?.net;
    const disclaimer=r?.changed_after_import?"Net claim was edited after PDF extraction. Original Table 4 amounts remain as evidence.":null;
    const hdr='<p class="muted small">Table 4(A) gross eligible ITC, 4(B) reversals and 4(C) net available ITC from the filed GSTR-3B. The GSTR-2B gap is not automatically an error or a recoverable claim.</p>';
    const lines=heads.map(h=>'<tr><td>'+h.toUpperCase()+'</td><td>'+cur(gross?.[h])+'</td><td>'+cur(back?.[h])+'</td><td>'+cur(net?.[h])+'</td>'+
      '<td>'+cur(c.gstr2b?.[h])+'</td><td>'+cur(c.gstr3b?.[h])+'</td><td>'+cur(c.gstr2b&&c.gstr3b?c.gstr2b[h]-c.gstr3b[h]:null)+'</td></tr>');
    const t=table(["Head","4(A) Available","4(B) Reversed","4(C) Net","2B eligible","3B filed claim","2B − 3B"],lines);
    return hdr+(r?'<p class="'+(r.verified?"good":"warn")+'">PDF 4(A) − 4(B) = 4(C): '+(r.verified?"Verified within ₹1":"Unverified; inspect return")+'</p>':
      '<p class="warn">No Table 4(A/B) source data has been saved yet. Import a filed GSTR-3B PDF and save its reviewed figures to enable reversal analysis.</p>')+
      (disclaimer?'<p class="warn">'+safe(disclaimer)+'</p>':"")+t;
  }
  function investigator(record){
    const result=record.reconciliation||{};
    const invoices=(result.invoices||[]).filter(x=>x.status!=="matched");
    const diagnostics=result.itcDiagnostics;
    const issues=[];
    for(const h of heads){
      const d=diagnostics?.heads?.[h];
      if(!d)continue;
      const gap=d.books_vs_2b==null?"not available":cur(d.books_vs_2b);
      const claim=d.gstr2b_vs_3b==null?"not available":cur(d.gstr2b_vs_3b);
      issues.push('<tr><td><b>'+h.toUpperCase()+'</b></td><td>'+gap+'</td><td>'+claim+'</td><td>'+
        (d.evidence_lines||[]).length+' source line(s) · '+(d.eligible_count||0)+' eligible portal records</td></tr>');
    }
    const invoiceLines=rowsOf(invoices.slice(0,100),x=>[
      safe(x.number),safe(x.gstin),safe(x.status),safe(x.explanation),
      cur(x.taxable_difference),cur(x.tax_difference),
      (x.differences||[]).map(d=>safe(d.label)+": "+cur(d.tally)+" vs "+cur(d.portal)).join("; ")
    ]);
    const itcRows=[];
    for(const h of heads)for(const x of (diagnostics?.heads?.[h]?.evidence_lines||[])){
      itcRows.push({head:h,...x});
    }
    itcRows.sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
    return '<p class="muted small">GSTR-1 is invoice-based. The GSTR-2B/3B ITC claims are filing-period totals; where a specific GSTR-3B adjustment cannot be identified from source documents, it remains unexplained rather than being assigned to a supplier.</p>'+
      table(["Tax head","Tally − 2B","2B − 3B","Evidence"],issues)+
      (invoices.length?'<h4>GSTR-1 / Tally sales exceptions ('+invoices.length+')</h4>'+
        table(["Invoice","GSTIN","Type","Explanation","Taxable gap","GST gap","Field breakdown"],invoiceLines):
        '<p class="good">No invoice-level GSTR-1 exceptions in the cached reconciliation.</p>')+
      (itcRows.length?'<h4>Purchase ITC source exceptions ('+itcRows.length+')</h4>'+
        table(["GST head","Supplier","Invoice","Voucher/date","Reason","Contribution"],rowsOf(itcRows.slice(0,130),x=>[
          safe(x.head.toUpperCase()),safe(x.party),safe(x.num),
          safe(x.tally_voucher||"—")+" · "+safe(x.booked_date||x.date||"—"),
          safe(x.reason),cur(x.value)
        ])):'<p class="muted small">No invoice-level ITC exceptions in current evidence, or Tally has not been refreshed.</p>');
  }
  function crossMonth(record){
    const cross=record.cross_month||[],miss=record.unlinked||[];
    return '<p class="muted small">Different GST filing months and Tally booking months are separated, not treated as incorrect entries. A match requires a stored voucher link. Unlinked invoices must be checked rather than automatically matched by date or amount.</p>'+
      '<h4>Verified links across months ('+(record.cross_month_total||0)+')</h4>'+
      (cross.length?table(["Supplier","Invoice","GSTR-2B month","Tally voucher","Booking month","GST"],rowsOf(cross,x=>[
        safe(x.name),safe(x.num),safe(x.filing_period),safe(x.voucher),safe(x.booking_period),cur(x.tax)
      ])):'<p class="muted small">No cross-month voucher links saved for this return.</p>')+
      '<h4>GSTR-2B bills without a verified link ('+(record.unlinked_total||0)+')</h4>'+
      (miss.length?table(["Supplier","Invoice","GSTIN","Invoice date","GST"],rowsOf(miss,x=>[
        safe(x.name),safe(x.num),safe(x.gstin),safe(x.invoice_date),cur(x.tax)
      ])):'<p class="muted small">Every eligible document is either linked or there are no eligible documents.</p>');
  }
  function duplicateSection(record){
    const ds=record.duplicates||[];
    return alert(record.duplicates_scope)+
      (ds.length?table(["Side","Party / GSTIN","Invoice","Distinct vouchers","Reason"],rowsOf(ds,x=>[
        safe(x.type),safe(x.supplier)+"<div class='muted small'>"+safe(x.gstin)+"</div>",
        safe(x.invoice),x.vouchers.map(y=>safe(y.number)+" ("+safe(y.date)+")").join(", "),
        safe(x.reason)
      ])):'<p class="good">No high-confidence repeated GSTIN + invoice numbers found in the available cached registers.</p>');
  }
  function suppliersPanel(suppliers){
    return '<p class="muted small">'+safe(suppliers?.note||"Supplier scorecard uses imported returns only.")+'</p>'+
      '<h4>Supplier filing and matching scorecard — FY '+safe(suppliers?.fy||"")+' ('+(suppliers?.periods||0)+' GSTR-2B months imported)</h4>'+
      (!suppliers?.suppliers?.length?'<p>No supplier data in this financial year. Import the GSTR-2B returns first.</p>':
      table(["Supplier / GSTIN","Documents","Not matched in Tally","Need review","ITC unavailable","Other filing month","Eligible GST"],
        rowsOf(suppliers.suppliers.slice(0,100),x=>[
          '<b>'+safe(x.name)+'</b><div class="small muted">'+safe(x.gstin)+'</div>',
          x.invoices,x.missing_tally,x.mismatch,x.itc_not_available,x.other_period,cur(x.eligible_gst)
        ])));
  }
  function annualPanel(yearly){
    const x=yearly||{months:[],totals:{},count:{}};
    const get=(m,k)=>cur(m[k]);
    const cells=(m)=>[safe(m.period),get(m,"gstr1_taxable"),get(m,"tally_sales_taxable"),get(m,"output_gstr1"),get(m,"output_gstr3b"),
      get(m,"itc_gstr2b"),get(m,"itc_gstr3b"),get(m,"itc_gap")];
    const rows=[...rowsOf(x.months||[],cells),'<tr><td><b>Available-month total</b></td>'+
      ["gstr1_taxable","tally_sales_taxable","output_gstr1","output_gstr3b","itc_gstr2b","itc_gstr3b","itc_gap"].map(k=>'<td><b>'+get(x.totals||{},k)+'</b></td>').join("")+'</tr>'];
    const foot='<p class="small '+(x.complete?"good":"warn")+'">Months with evidence: GSTR-1 '+(x.count?.gstr1||0)+
      '/12, GSTR-2B '+(x.count?.gstr2b||0)+'/12, GSTR-3B '+(x.count?.gstr3b||0)+
      '/12, Tally '+(x.count?.tally||0)+'/12. Incomplete months are NOT assumed to be zero.</p>'+
      '<p class="muted small">'+safe(x.warning||"")+'</p>';
    return foot+table(["Month","GSTR-1 taxable","Tally sales taxable","GSTR-1 GST","GSTR-3B GST","GSTR-2B ITC","GSTR-3B ITC","ITC gap"],rows)+
      '<button class="btn sm" id="vwYearCsv">Export annual CSV</button>';
  }
  function rulesPanel(record){
    const roles=[["auto","Auto (original treatment)"],["base","Sales/Purchase base"],["discount","Discount — reduces taxable"],["freight","Freight — adds taxable"],["other_charge","Other taxable charge"],["round_off","Round off — outside taxable"],["ignore","Exclude from GST taxable"],["igst","IGST ledger"],["cgst","CGST ledger"],["sgst","SGST ledger"],["cess","Cess ledger"]];
    const ledgerOptions=(record?.ledgers||[]).map(x=>'<option value="'+safe(x.name)+'">'+safe(x.name)+
      " — "+safe(x.primary_group||x.parent||"")+'</option>').join("");
    return '<p class="muted small">Override a ledger only when you know its GST treatment. Mapping is company-specific and used on the next Tally read and GSTR-2B rematch; it never changes masters or posts vouchers. For unusual rules, consult your accountant.</p>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+
      '<select class="in" id="vwLedger" style="max-width:350px"><option value="">Choose imported Tally ledger</option>'+ledgerOptions+'</select>'+
      '<select class="in" id="vwRole">'+roles.map(([v,n])=>'<option value="'+v+'">'+safe(n)+'</option>').join("")+'</select>'+
      '<button id="vwSaveRole" class="btn primary">Save mapping</button></div>'+
      (record?.rules?.length?table(["Ledger","GST role","Updated"],rowsOf(record.rules,x=>[
        safe(x.ledger_name),safe(x.role),x.updated_at?new Date(x.updated_at*1000).toLocaleDateString("en-IN"):"—"
      ])):'<p class="muted small">No custom mappings. Tally master groups and standard ledger names remain in effect.</p>');
  }
  function csvEncode(value){
    const s=value==null?"":String(value);
    return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
  }
  function exportAnnual(yearly){
    const keys=["period","gstr1_taxable","tally_sales_taxable","gstr3b_taxable","output_gstr1","output_gstr3b",
      "itc_gstr2b","itc_gstr3b","tally_purchase_tax","itc_gap"];
    const rows=[keys,...(yearly.months||[]).map(m=>keys.map(k=>m[k])),["AVAILABLE MONTH TOTAL",...keys.slice(1).map(k=>yearly.totals?.[k])]];
    const data="\ufeff"+rows.map(row=>row.map(csvEncode).join(",")).join("\r\n");
    const blob=new Blob([data],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob),link=document.createElement("a");
    link.href=url;link.download="Vipul-Workplace-GST-FY-"+yearly.fy+".csv";
    document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function mount(company,period,parentEl){
    const node=document.querySelector("#vwGstSuite");
    if(!node)return;
    node.innerHTML='<div class="card" style="padding:14px"><h3>Vipul Workplace GST Workspace</h3><p class="muted small">Loading locally saved GST evidence…</p></div>';
    const fy=Number(period.slice(0,4))-(Number(period.slice(5,7))<4?1:0);
    const base="/companies/"+encodeURIComponent(company.id)+"/gst-suite";
    let monthData,yearly,suppliers,rules;
    try{
      [monthData,yearly,suppliers,rules]=await Promise.all([
        api(base+"/"+period),api(base+"/year/"+fy),api(base+"/suppliers/"+fy),api(base+"/rules")
      ]);
    }catch(e){node.innerHTML='<div class="alert warn">Unable to load GST Workspace: '+safe(e.message)+'</div>';return;}
    if(!node.isConnected)return;
    node.innerHTML='<div class="card" style="padding:14px;margin:14px 0"><h3 style="margin:0 0 8px">Monthly GST Workspace · '+safe(period)+'</h3>'+
      '<p style="margin:6px 0">'+chip(monthData.has_gstr1,"GSTR-1")+chip(monthData.has_gstr2b,"GSTR-2B")+
      chip(monthData.has_gstr3b,"GSTR-3B PDF / saved claim")+chip(monthData.has_tally,"Tally register")+'</p>'+
      '<p class="muted small">One-click refresh re-reads this month from Tally and compares available portal data. Import your GSTR-1, 2B and filed GSTR-3B using the existing upload controls first. No portal API or posting action is performed.</p>'+
      '<button id="vwRun" class="btn primary">Read Tally &amp; reconcile this month</button> '+
      '<span class="muted small" id="vwRunStatus"></span></div>'+
      disclosure("GST difference investigator — source-level exceptions",investigator(monthData),true)+
      disclosure("ITC available, reversals &amp; claimed (Table 4)",itcDetails(monthData))+
      disclosure("Cross-month GSTR-2B ↔ Tally matching",crossMonth(monthData))+
      disclosure("Potential duplicate purchase &amp; sales invoices ("+(monthData.duplicates?.length||0)+")",duplicateSection(monthData))+
      disclosure("Company GST ledger mapping ("+(rules.rules?.length||0)+")",rulesPanel(rules))+
      disclosure("Supplier GST compliance dashboard",suppliersPanel(suppliers))+
      disclosure("Financial-year GST reconciliation (FY "+fy+"–"+String(fy+1).slice(-2)+")",annualPanel(yearly));
    const run=document.querySelector("#vwRun");run.onclick=async()=>{
      run.disabled=true;document.querySelector("#vwRunStatus").textContent="Reading Tally and comparing cached portal returns…";
      try{
        const out=await api(base+"/"+period+"/run",{body:{}});
        toast("Tally GST refreshed: "+out.read.sales+" sales and "+out.read.purchases+" purchases. Reconciliation updated.");
        companyGstControl(company,parentEl);
      }catch(e){run.disabled=false;document.querySelector("#vwRunStatus").textContent=e.message;toast(e.message,true);}
    };
    const save=document.querySelector("#vwSaveRole");save.onclick=async()=>{
      const ledger=document.querySelector("#vwLedger").value,role=document.querySelector("#vwRole").value;
      if(!ledger){toast("Choose an imported Tally ledger",true);return;}
      if(!confirm("Apply GST treatment '"+role+"' to ledger '"+ledger+"' for "+company.name+"? A fresh Tally read and 2B match are required."))return;
      save.disabled=true;
      try{await api(base+"/rules",{body:{ledger_name:ledger,role}});toast("GST mapping saved. Re-read Tally to apply.");await mount(company,period,parentEl);}
      catch(e){save.disabled=false;toast(e.message,true);}
    };
    const exportBtn=document.querySelector("#vwYearCsv");if(exportBtn)exportBtn.onclick=()=>exportAnnual(yearly);
  }
  return {mount};
})();