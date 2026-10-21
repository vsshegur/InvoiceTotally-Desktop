// Local GST portal JSON reader (no API). Strictly accepts supported GST JSON structure;
// unexpected structure raises an error rather than silently dropping taxable sales.
const value=x=>{const n=Number(String(x??"0").replace(/,/g,""));return Number.isFinite(n)?n:0;};
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
const fields=["taxable","igst","cgst","sgst","cess"];
const empty=()=>({taxable:0,igst:0,cgst:0,sgst:0,cess:0});
const scan=s=>({
  taxable:value(s?.txval??s?.taxable_value??0),igst:value(s?.iamt??s?.igst??0),
  cgst:value(s?.camt??s?.cgst??0),sgst:value(s?.samt??s?.sgst??0),cess:value(s?.csamt??s?.cess??0)
});
const accumulate=(to,from,sign=1)=>{for(const field of fields)to[field]+=sign*(from[field]||0);};
const a=x=>Array.isArray(x)?x:[];
const standardMonth=s=>{
  const v=String(s||"");
  if(/^\d{6}$/.test(v)){const m=+v.slice(0,2),y=+v.slice(2);return m>=1&&m<=12?y+"-"+String(m).padStart(2,"0"):"";}
  if(/^\d{4}-\d{2}$/.test(v))return v;
  if(/^\d{4}\d{2}$/.test(v)){const m=+v.slice(4);return m>=1&&m<=12?v.slice(0,4)+"-"+v.slice(4):"";}
  return "";
};
function assertIdentity(root,expected){
  const gs=String(root.gstin||root.gst_in||"").trim().toUpperCase();
  const fp=standardMonth(root.fp||root.ret_period||root.return_period);
  if(expected?.gstin&&gs&&gs!==String(expected.gstin).toUpperCase())
    throw new Error("GST portal file belongs to GSTIN "+gs+", not "+expected.gstin);
  if(expected?.period&&fp&&fp!==expected.period)
    throw new Error("GST portal file period "+fp+" does not match selected "+expected.period);
  return {gstin:gs,period:fp};
}
const itemAmounts=inv=>{
  const lines=a(inv.itms||inv.items);
  if(!lines.length){
    if("txval" in inv||"iamt" in inv)return scan(inv);
    throw new Error("GST invoice has no item tax details: "+(inv.inum||inv.nt_num||"unknown"));
  }
  const result=empty();
  for(const row of lines)accumulate(result,scan(row.itm_det||row.item_det||row));
  return result;
};
const normDate=d=>{
  const v=String(d||"").trim(),m=/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(v);
  if(m)return m[3]+"-"+m[2].padStart(2,"0")+"-"+m[1].padStart(2,"0");
  return /^\d{4}-\d{2}-\d{2}$/.test(v)?v:"";
};
export function parseGstr1(input,expected={}){
  const root=input?.data?.gst_return||input?.data?.gstr1||input?.data||input?.gstr1||input;
  if(!root||typeof root!=="object"||Array.isArray(root))throw new Error("Not a GST GSTR-1 JSON object");
  const identity=assertIdentity(root,expected),total=empty(),docs=[];
  let sections=0,records=0;
  const withInvoices=(key,partyKey,children="inv")=>{
    if(!Array.isArray(root[key]))return;
    sections++;
    for(const outer of root[key]){
      const party=String(outer[partyKey]||outer.ctin||"").trim().toUpperCase();
      for(const inv of a(outer[children]||outer.inv||outer.nt)){
        const amounts=itemAmounts(inv);
        const isNote=key==="cdnr"||key==="cdnur"||key==="cdnra"||key==="cdnura";
        const sign=isNote&&String(inv.ntty||inv.note_type||"").toUpperCase().startsWith("C")?-1:1;
        accumulate(total,amounts,sign);records++;
        if(/^\d{2}[A-Z0-9]{13}$/.test(party) && (inv.inum||inv.nt_num)){
          docs.push({ctin:party,num:String(inv.inum||inv.nt_num||"").trim(),dt:normDate(inv.idt||inv.nt_dt),
            ...Object.fromEntries(fields.map(k=>[k,money(amounts[k]*sign)]))});
        }
      }
    }
  };
  withInvoices("b2b","ctin");withInvoices("b2ba","ctin");
  withInvoices("b2cl","pos");withInvoices("b2cla","pos");
  withInvoices("cdnr","ctin","nt");withInvoices("cdnra","ctin","nt");
  withInvoices("cdnur","pos","nt");withInvoices("cdnura","pos","nt");
  for(const key of ["b2cs","b2csa"]){
    if(!Array.isArray(root[key]))continue;
    sections++;
    for(const row of root[key]){accumulate(total,scan(row));records++;}
  }
  for(const key of ["exp","expa"]){
    if(!Array.isArray(root[key]))continue;
    sections++;
    for(const container of root[key])for(const inv of a(container.inv)){
      accumulate(total,itemAmounts(inv));records++;
    }
  }
  if(!sections||!records)throw new Error("No supported taxable GSTR-1 sections found (B2B/B2CL/B2CS/CDNR/EXP). Enter the portal summary manually.");
  for(const k of fields)total[k]=money(total[k]);
  return {kind:"gstr1",summary:total,docs:docs.slice(0,20000),records,...identity};
}
export function parseGstr3b(input,expected={}){
  const root=input?.data?.gst3b||input?.data?.gstr3b||input?.data||input?.gstr3b||input;
  if(!root||typeof root!=="object"||Array.isArray(root))throw new Error("Not a GST GSTR-3B JSON object");
  const identity=assertIdentity(root,expected);
  const outward=root.sup_details?.osup_det||root.sup_details?.osup||root.supply_details?.outward;
  if(!outward||typeof outward!=="object")throw new Error("GSTR-3B 3.1(a) outward taxable supply section is not available; enter summary manually.");
  const result={...scan(outward),itcIgst:null,itcCgst:null,itcSgst:null,itcCess:null};
  const elig=root.itc_elg||root.itc_eligibility||{};
  const available=a(elig.itc_avl||elig.itc_available);
  const reversed=a(elig.itc_rev||elig.itc_reversed);
  const net=elig.net_itc||elig.itc_net;
  let itc=null;
  if(net&&typeof net==="object"&&!Array.isArray(net))itc=scan(net);
  else if(available.length||reversed.length){
    itc=empty();
    for(const r of available)accumulate(itc,scan(r));
    for(const r of reversed)accumulate(itc,scan(r),-1);
  }
  if(itc){
    result.itcIgst=money(itc.igst);result.itcCgst=money(itc.cgst);
    result.itcSgst=money(itc.sgst);result.itcCess=money(itc.cess);
  }
  for(const k of fields)result[k]=money(result[k]);
  return {kind:"gstr3b",summary:result,records:1,...identity};
}
export function parsePortalJson(input,kind,expected){
  if(kind==="gstr1")return parseGstr1(input,expected);
  if(kind==="gstr3b")return parseGstr3b(input,expected);
  throw new Error("Choose GSTR-1 or GSTR-3B");
}
