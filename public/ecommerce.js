/* E-Commerce → Tally screens. All Excel decoding is local in Ingest.workbook().
 * Only normalized rows are sent to InvoiceTotally's localhost process. */
const EC = {
  money(v) { return Number(v || 0).toLocaleString("en-IN", { style:"currency",currency:"INR",maximumFractionDigits:2 }); },
  opts(choices, selected) {
    return '<option value="">— select an existing Tally master —</option>' +
      choices.map(x => '<option value="' + esc(x.name) + '"' + (x.name === selected ? ' selected' : '') + '>' +
        esc(x.name) + (x.primary_group ? ' · ' + esc(x.primary_group) : '') + '</option>').join('');
  },
  label(platform) { return { ME:"Meesho", FL:"Flipkart", AZ:"Amazon" }[platform] || platform; },
  status(s) { return {ready:"Ready",queued:"Waiting for Tally",synced:"In Tally",failed:"Failed",duplicate:"Already in Tally",uncertain:"Check in Tally"}[s] || s; }
};

async function companyEcommerce(c, el) {
  const rows = await api('/companies/' + c.id + '/ecommerce');
  el.innerHTML =
    '<div class="card" style="margin:0 0 18px;padding:18px"><h2 style="margin:0 0 8px">Offline Meesho, Flipkart &amp; Amazon → Tally</h2>' +
    '<p class="muted">Read marketplace GST Excel files locally, review consolidated monthly sales and GST, map ledgers from this company, then post individual vouchers straight to TallyPrime. No AI or internet API is used for conversion.</p>' +
    '<p class="muted small">Monthly consolidated accounting, not one voucher per order. Marketplace settlement, commissions and payouts are separate.</p>' +
    '<a class="btn primary" href="#/c/' + c.id + '/ecommerce/upload">⇪ Import marketplace files</a></div>' +
    (rows.length ? '<table class="grid"><thead><tr><th>Month</th><th>Marketplace</th><th class="num">Total sales incl. GST</th><th>Vouchers</th><th>Status</th></tr></thead><tbody>' +
      rows.map(r => '<tr class="click" data-href="#/e/' + r.id + '"><td><b>' + esc(r.period) + '</b></td>' +
        '<td>' + EC.label(r.platform) + '</td><td class="num">' + EC.money(r.summary.invoice) +
        '</td><td>' + Object.values(r.counts).reduce((a,b)=>a+b,0) + '</td><td>' +
        Object.entries(r.counts).map(([k,n])=>n+' '+EC.status(k)).join(' · ') + '</td></tr>').join('') +
      '</tbody></table>' : '<div class="card empty">No marketplace files imported for this company yet.</div>');
  $$('tr[data-href]',el).forEach(tr => tr.onclick = () => location.hash = tr.dataset.href);
  if(rows.some(r=>r.counts.queued))every(3500, refresh);
}

async function viewEcommerceUpload(cid) {
  const c = await api('/companies/' + cid);
  CURRENT.company = c;
  const t = new Date(), last = new Date(t.getFullYear(),t.getMonth()-1,1);
  const pmonth = last.getMonth()+1, pyear = last.getFullYear();
  const options = Array.from({length:12},(_,i)=>'<option value="'+(i+1)+'"'+(i+1===pmonth?' selected':'')+'>'+
    new Date(2000,i,1).toLocaleString('en-IN',{month:'long'})+'</option>').join('');
  const years = Array.from({length:8},(_,i)=>pyear-i).map(y=>'<option value="'+y+'"'+(y===pyear?' selected':'')+'>'+y+'</option>').join('');
  app().innerHTML = topBar([[c.name,'#/c/'+cid],['E-Commerce','#/c/'+cid+'/ecommerce'],['Import'] ],c) +
    '<div class="page" style="max-width:980px"><h1>Import marketplace GST Excel</h1>' +
    '<p class="muted">All spreadsheets are read on this PC. No AI, cloud conversion or network upload. Existing InvoiceTotally sign-in rules remain unchanged.</p>' +
    '<div class="box"><div class="bb">' +
    '<div class="field"><label>Marketplace</label><select class="in" id="ecPlatform"><option value="ME">Meesho</option><option value="FL">Flipkart</option><option value="AZ">Amazon</option></select></div>' +
    '<div class="grid-2" style="display:flex;gap:12px;flex-wrap:wrap">' +
    '<div class="field" style="min-width:200px"><label>Month</label><select class="in" id="ecMonth">'+options+'</select></div>' +
    '<div class="field" style="min-width:145px"><label>Year</label><select class="in" id="ecYear">'+years+'</select></div></div>' +
    '<div class="alert info" style="margin:12px 0">Company: <b>'+esc(c.name)+'</b> · GSTIN <b>'+esc(c.gstin||'Not set')+
    '</b>. Choose the SAME month that appears in the marketplace report.</div>' +
    '<div id="ecFields"></div>' +
    '<button class="btn primary" id="ecRead">Read Excel &amp; review</button> ' +
    '<a class="btn" href="#/c/'+cid+'/ecommerce">Back</a> <span id="ecProgress" class="muted small"></span>' +
    '</div></div></div>';
  wireTop(c);
  const fields = () => {
    const platform=$('#ecPlatform').value;
    $('#ecFields').innerHTML = platform==='ME'
      ? '<div class="field"><label>Meesho TCS Sales (.xlsx)</label><input class="in" id="ecSales" type="file" accept=".xlsx" required></div>' +
        '<div class="field"><label>Meesho TCS Sales Return (.xlsx)</label><input class="in" id="ecReturns" type="file" accept=".xlsx" required></div>' +
        '<div class="field"><label>Meesho tax invoice summary (optional .xlsx)</label><input class="in" id="ecInvoice" type="file" accept=".xlsx"></div>'
      : platform==='FL'
      ? '<div class="field"><label>Flipkart GSTR-1 GST report (.xlsx, includes Section 7/5B)</label>' +
        '<input class="in" id="ecFlipkart" type="file" accept=".xlsx" required></div>'
      : '<div class="field"><label>Amazon GST B2B report (.xlsx, GST_MTR_B2B)</label><input class="in" id="ecB2b" type="file" accept=".xlsx"></div>' +
        '<div class="field"><label>Amazon GST B2C report (.xlsx, GST_MTR_B2C)</label><input class="in" id="ecB2c" type="file" accept=".xlsx"></div>' +
        '<p class="muted small">Upload at least one. Most sellers only need the B2C report; add B2B too if you have registered-buyer sales. From Seller Central: Reports → Tax Document Library → GST reports.</p>';
  };
  $('#ecPlatform').onchange=fields;fields();
  $('#ecRead').onclick=async()=>{
    const button=$('#ecRead'), status=$('#ecProgress');
    const platform=$('#ecPlatform').value;
    const sources=platform==='ME'?{sales:$('#ecSales').files[0],returns:$('#ecReturns').files[0],invoice:$('#ecInvoice').files[0]}:
      platform==='FL'?{flipkart:$('#ecFlipkart').files[0]}:
      {b2b:$('#ecB2b').files[0],b2c:$('#ecB2c').files[0]};
    if(platform==='AZ'){
      if(!sources.b2b&&!sources.b2c)return toast('Choose at least one Amazon GST report',true);
    } else if(Object.entries(sources).some(([k,f])=>!f&&k!=='invoice'))return toast('Choose the required marketplace Excel files',true);
    button.disabled=true;status.textContent='Reading Excel on this PC…';
    try {
      const files={};
      for(const [key,f] of Object.entries(sources)){
        if(!f)continue;
        if(!/\.xlsx$/i.test(f.name))throw new Error(f.name+': save the workbook as .xlsx first');
        if(f.size>20*1024*1024)throw new Error(f.name+': workbook exceeds the 20 MB local limit');
        const sheets=await Ingest.workbook(f);
        files[key]={name:f.name,sheets};
      }
      status.textContent='Validating monthly GST and building Tally review…';
      const result=await api('/companies/'+cid+'/ecommerce/prepare',{body:{
        platform,month:Number($('#ecMonth').value),year:Number($('#ecYear').value),files
      }});
      toast(result.vouchers+' vouchers prepared. Review before posting.');
      location.hash='#/e/'+result.id;
    }catch(e){status.textContent='';toast(e.message,true);button.disabled=false;}
  };
  keymap.Escape=()=>location.hash='#/c/'+cid+'/ecommerce';
}

async function viewEcommerceBatch(id) {
  const data = await api('/ecommerce/'+id), c=await api('/companies/'+data.company_id);
  CURRENT.company=c;
  const rows=data.vouchers, done=rows.some(r=>['queued','synced','duplicate','uncertain'].includes(r.status));
  const ledgers=data.masters.filter(x=>x.kind==='ledger'),stockMasters=data.masters.filter(x=>x.kind==='stock_item');
  const requiredStock=[...new Set(rows.filter(r=>r.invoice>0).flatMap(r=>r.items.map(i=>i.name)))].filter(Boolean);
  const original=data.mapping||{}, map={...original,stock:{...(original.stock||{})}};
  const preferred={
    party:['Selling Through '+EC.label(data.platform)],
    sales:['Online Sales','GST SALES'],
    cgst:['Output CGST','CGST'],sgst:['Output SGST','SGST'],igst:['Output IGST','IGST'],
    round:['Round Off','ROUND OFF SALES ACCOUNT']
  };
  const guess=(field)=>{
    if(map[field])return map[field];
    const list=preferred[field]||[];
    const found=ledgers.find(x=>list.some(z=>z.toLowerCase()===x.name.toLowerCase()));
    return found?.name||'';
  };
  const mappingFields=[['party','Marketplace debtor / party'],['sales','Online sales'],['cgst','Output CGST'],
    ['sgst','Output SGST'],['igst','Output IGST'],['round','Round Off']];
  const statusHtml=s=>
    '<span class="'+(s==='synced'?'good':s==='failed'||s==='uncertain'?'bad':s==='duplicate'?'warn':'muted')+'">'+esc(EC.status(s))+'</span>';
  const total=rows.reduce((a,r)=>a+Number(r.invoice||0),0);
  app().innerHTML = topBar([[c.name,'#/c/'+c.id],['E-Commerce','#/c/'+c.id+'/ecommerce'],[EC.label(data.platform)+' '+data.period]],c)+
    '<div class="bar"><span class="status">Platform <b>'+EC.label(data.platform)+'</b> · Month <b>'+esc(data.period)+'</b> · '+rows.length+' vouchers</span>' +
    '<div class="spacer"></div><a class="btn" href="#/c/'+c.id+'/ecommerce">Back</a> '+
    '<button class="btn primary" id="ecPost" '+(!ME?.licence?.can_post?'disabled title="Posting not allowed"':'')+'>Post selected to Tally</button>' +
    (rows.some(r=>r.status==='uncertain'||r.status==='duplicate')?'<button class="btn" id="ecRecheck">Recheck in Tally</button>':'')+'</div>'+
    '<div class="page wide"><h2 style="margin:0 0 14px">Monthly GST sales review</h2>' +
    '<div class="grid-2" style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:16px">' +
    '<div class="card" style="flex:1;min-width:200px;padding:16px"><div class="muted small">Taxable sales</div><h2>'+EC.money(data.summary.taxable)+'</h2></div>'+
    '<div class="card" style="flex:1;min-width:200px;padding:16px"><div class="muted small">CGST + SGST + IGST</div><h2>'+
      EC.money(Number(data.summary.cgst||0)+Number(data.summary.sgst||0)+Number(data.summary.igst||0))+'</h2></div>'+
    '<div class="card" style="flex:1;min-width:200px;padding:16px"><div class="muted small">Total incl. GST</div><h2>'+EC.money(total)+'</h2></div></div>'+
    '<div class="alert info" style="margin-bottom:14px">Source: '+esc((data.summary.files||[]).join(', '))+
    ' · E-commerce operator GSTIN: <b>'+esc(data.summary.operatorGstin||'')+'</b>. Verify these totals against the source reports before posting.</div>'+
    (data.summary.b2cLarge?.length?'<div class="alert warn" style="margin-bottom:14px">Flipkart B2C-large details are present ('+
      data.summary.b2cLarge.length+' entries). Review your GSTR-1 B2C-large classification separately; this import posts consolidated sales vouchers.</div>':'')+
    (done?'<div class="alert warn" style="margin-bottom:14px">Some vouchers have already been queued, posted or found in Tally. Ledger mappings are locked for this batch. Duplicate and uncertain entries are NEVER automatically retried.</div>':'')+
    '<div class="box" style="margin-bottom:16px"><div class="bh"><b>Tally master mapping</b><span class="muted small">'+(done?'Locked':'Required before posting')+'</span></div>' +
      '<div class="bb" id="ecMapping"></div></div>'+
    '<div class="card" style="margin-bottom:12px;padding:12px"><label><input type="checkbox" id="ecVerified"> '+
      'I checked these GST amounts and confirmed this month/platform was not already imported into Tally, including via PackPilot XML.</label></div>'+
    '<div class="filters" style="display:flex;gap:12px;margin:12px 0;align-items:center">' +
    '<label><input type="checkbox" id="ecAll" checked> Select ready / failed</label>'+
    '<span class="muted small">Posting checks Tally for matching voucher numbers immediately before each write.</span></div>'+
    '<div style="overflow:auto"><table class="grid"><thead><tr><th></th><th>Voucher</th><th>State</th><th>GST rate</th>'+
    '<th class="num">Taxable</th><th class="num">GST</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>'+
    rows.map(r=>'<tr><td><input type="checkbox" class="ec-check" value="'+esc(r.id)+'" '+(['ready','failed'].includes(r.status)?'checked':'disabled')+'></td>'+
      '<td class="mono">'+esc(r.number)+'</td><td>'+esc(r.state)+'</td><td>'+esc(r.rate)+'%</td>'+
      '<td class="num">'+EC.money(r.taxable)+'</td><td class="num">'+EC.money(+r.igst + +r.cgst + +r.sgst)+'</td>'+
      '<td class="num">'+EC.money(r.invoice)+'</td><td>'+statusHtml(r.status)+(r.error?'<div class="small bad">'+esc(r.error)+'</div>':'')+'</td></tr>').join('')+
    '</tbody></table></div>'+
    '<details style="margin:16px 0"><summary><b>HSN summary — '+(data.summary.hsnSummary||[]).length+
       ' groups</b> <span class="muted small">(review before posting)</span></summary>'+
       '<div style="overflow:auto;margin-top:10px"><table class="grid"><thead><tr><th>HSN</th><th>GST rate</th><th class="num">Qty</th><th class="num">Taxable</th></tr></thead><tbody>'+
       (data.summary.hsnSummary||[]).map(x=>'<tr><td>'+esc(x.hsn||'—')+'</td><td>'+esc(x.rate??'—')+'%</td><td class="num">'+esc(x.qty||0)+'</td><td class="num">'+EC.money(x.taxable)+'</td></tr>').join('')+
       '</tbody></table></div><p class="muted small">Accounting mode records HSN in narration only; it does not make HSN inventory/stock movements in Tally.</p></details>'+
    '</div>';
  wireTop(c);
  const select=(key,label,value,options,disabled)=>{
    return '<div class="field" style="flex:1;min-width:240px"><label>'+esc(label)+'</label>'+
      '<select class="in" data-map="'+key+'" '+(disabled?'disabled':'')+'>'+EC.opts(options,value)+'</select></div>';
  };
  const collect=()=>{
    for(const [key] of mappingFields)map[key]=$('[data-map="'+key+'"]')?.value||'';
    map.mode=$('#ecMode')?.value||'accounting';
    for(const e of $$('[data-stock]'))map.stock[e.dataset.stock]=e.value;
    return map;
  };
  const mapping=()=>{
    const area=$('#ecMapping');
    const mode=map.mode||'accounting';
    area.innerHTML='<div class="field"><label>Voucher mode</label><select class="in" id="ecMode" '+(done?'disabled':'')+'>'+
      '<option value="accounting"'+(mode==='accounting'?' selected':'')+'>Accounting vouchers (all platforms; no stock movement)</option>'+
      (data.platform==='ME'?'<option value="inventory"'+(mode==='inventory'?' selected':'')+'>Meesho HSN stock-item vouchers (requires existing stock masters and quantities)</option>':'')+
      '</select></div>'+
      '<div style="display:flex;gap:12px;flex-wrap:wrap">'+
      mappingFields.map(([key,label])=>select(key,label,guess(key),ledgers,done)).join('')+'</div>'+
      (mode==='inventory'?'<div class="alert warn" style="margin:12px 0">Meesho HSN totals combine multiple SKUs. Use only a dedicated HSN summary stock item, not an individual physical product/SKU. Quantities affect Tally stock balances. Stock masters must already exist.</div>'+
        '<div style="display:flex;gap:12px;flex-wrap:wrap">'+requiredStock.map(name=>{
          const hsn=(name.match(/HSN_([0-9A-Z]+)/)||[])[1]||'';
          const chosen=map.stock[name]||stockMasters.find(x=>x.name.toLowerCase()===name.toLowerCase())?.name||'';
          return select('stock-'+name,name,chosen,stockMasters,done).replace('data-map="stock-'+name+'"','data-stock="'+esc(name)+'"');
        }).join('')+'</div>':'')+
      '<div style="display:flex;gap:10px;margin-top:12px">'+
      (!done?'<button id="ecSave" class="btn primary">Save ledger mapping</button>':'')+
      '<button id="ecRefreshMasters" class="btn">Import Tally masters</button></div>'+
      (!ledgers.length?'<div class="alert warn">No ledgers found. Open the company in Tally and select Import masters at the top right.</div>':'');
    $('#ecMode')?.addEventListener('change',()=>{collect();map.mode=$('#ecMode').value;mapping();});
    $('#ecSave')?.addEventListener('click',async()=>{
      const button=$('#ecSave');button.disabled=true;
      try{const payload=collect();await api('/ecommerce/'+id+'/mapping',{body:payload});toast('Tally ledgers saved');refresh();}
      catch(e){toast(e.message,true);button.disabled=false;}
    });
    $('#ecRefreshMasters').onclick=async()=>{await act(()=>api('/companies/'+c.id+'/import-masters',{body:{}}),'Reading Tally masters…');toast('Wait for masters to finish importing, then reload this page');};
  };
  mapping();
  $('#ecAll').onchange=e=>$$('.ec-check:not(:disabled)').forEach(x=>x.checked=e.target.checked);
  $('#ecRecheck')?.addEventListener('click',async()=>{
    const b=$('#ecRecheck');b.disabled=true;
    try{const result=await api('/ecommerce/'+id+'/recheck',{body:{}});
      toast(result.present+' already in Tally; '+result.ready+' cleared for manual retry.');refresh();}
    catch(e){toast(e.message,true);b.disabled=false;}
  });
  $('#ecPost').onclick=async()=>{
    const selected=$$('.ec-check:checked:not(:disabled)').map(x=>x.value);
    if(!selected.length)return toast('Select at least one ready voucher',true);
    if(!$('#ecVerified')?.checked)return toast('Confirm you checked prior PackPilot/Tally imports and the GST totals',true);
    if(!data.mapping?.party || !data.mapping?.sales)return toast('Save your Tally ledger mapping first',true);
    if(!confirm('Post '+selected.length+' monthly consolidated vouchers into '+(c.tally_company||c.name)+'?\nEach is checked against existing Tally voucher numbers. Please verify your GST totals and mappings first.'))return;
    const btn=$('#ecPost');btn.disabled=true;
    try{const r=await api('/ecommerce/'+id+'/post',{body:{ids:selected}});toast(r.queued+' voucher(s) queued for Tally');refresh();}
    catch(e){toast(e.message,true);btn.disabled=false;}
  };
  if(rows.some(r=>r.status==='queued'))every(3200,refresh);
  keymap.Escape=()=>location.hash='#/c/'+c.id+'/ecommerce';
}
