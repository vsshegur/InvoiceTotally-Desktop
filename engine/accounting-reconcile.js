// Read-only accounting match primitives. No XML imports, vouchers or ledger edits here.
import * as TL from "../desktop/tally.mjs";

const val=(node,key)=>TL.kid(node,key)?.text?.trim()||"";
const money=x=>Math.round(Number(x||0)*100)/100;
const identity=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const iso=x=>{ const m=/(\d{4})-?(\d{2})-?(\d{2})/.exec(String(x||"")); return m?m[1]+"-"+m[2]+"-"+m[3]:""; };
const day=x=>{const n=Date.parse(iso(x)+"T00:00:00Z");return Number.isFinite(n)?Math.round(n/86400000):null;};
export const normRef=identity;
export const money2=money;

export function bankVouchers(xml,bankLedger){
  const root=TL.parseXml(xml),out=[];
  const wanted=identity(bankLedger);
  if(!wanted)throw new Error("Bank ledger is required");
  TL.walk(root,n=>{
    if(n.name!=="VOUCHER")return;
    if(val(n,"ISCANCELLED").toLowerCase()==="yes"||val(n,"ISOPTIONAL").toLowerCase()==="yes")return false;
    const date=iso(val(n,"DATE")),mid=val(n,"MASTERID"),number=val(n,"VOUCHERNUMBER");
    let entries=TL.kids(n,"ALLLEDGERENTRIES.LIST");
    if(!entries.length)entries=TL.kids(n,"LEDGERENTRIES.LIST");
    if(!entries.length)return false;
    const other=entries.filter(e=>identity(val(e,"LEDGERNAME"))!==wanted).map(e=>val(e,"LEDGERNAME")).filter(Boolean);
    for(const [index,e] of entries.entries()){
      if(identity(val(e,"LEDGERNAME"))!==wanted)continue;
      const raw=val(e,"AMOUNT");
      const amount=Number(String(raw).replace(/,/g,""));
      if(!Number.isFinite(amount)||!date||Math.abs(amount)<0.005)continue;
      // Tally: debit is negative; a debit to Bank is a credit in a bank statement.
      const signed=money(-amount);
      out.push({id:mid?mid+":"+index:date+"|"+number+"|"+index,mid,number,date,
        signed,credit:Math.max(0,signed),debit:Math.max(0,-signed),
        type:val(n,"VOUCHERTYPENAME"),party:val(n,"PARTYLEDGERNAME"),
        reference:val(n,"REFERENCE")||val(n,"CHEQUENUMBER"),
        narration:val(n,"NARRATION"),other_ledgers:other});
    }
    return false;
  });
  return out;
}

export function reconcileBank(statementLines,tallyLines,{dateTolerance=3}={}){
  const rows=statementLines.map(s=>({
    id:String(s.id),date:iso(s.date),signed:money((Number(s.credit)||0)-(Number(s.debit)||0)),
    ref:identity(s.ref),narration:identity(s.narration),status:String(s.status||"")
  }));
  const tally=tallyLines.map(t=>({...t,signed:money(t.signed),date:iso(t.date)}));
  const claim=new Set(),matches=[],reserved=new Set();
  // Only a unique, matching reference+amount can be automatically confirmed.
  // Date-only/amount-only candidates remain suggestions; never consume them.
  for(const row of rows){
    if(!row.date||!row.signed){matches.push({id:row.id,status:"needs_review",reason:"Invalid date or amount"});continue;}
    if(row.status==="ignored"){matches.push({id:row.id,status:"excluded"});continue;}
    const options=tally.filter(t=>{
      const diff=Math.abs(row.signed-t.signed),dd=day(row.date)-day(t.date);
      return Math.abs(diff)<=0.01 && dd!==null && Math.abs(dd)<=dateTolerance;
    }).map(t=>{
      const ref=identity(t.reference),narr=identity(t.narration);
      const exact=!!row.ref && row.ref.length>=6 && (ref===row.ref || (!!narr && narr.includes(row.ref)));
      const close=day(row.date)===day(t.date);
      const name=!!t.party && row.narration.includes(identity(t.party));
      return {...t,exact,close,name};
    });
    const exact=options.filter(t=>t.exact&&!claim.has(t.id));
    if(exact.length===1 && !reserved.has(exact[0].id)){
      const t=exact[0];claim.add(t.id);reserved.add(t.id);
      matches.push({id:row.id,status:"matched",tally_id:t.id,tally_number:t.number,
        tally_date:t.date,party:t.party,reason:"Unique bank reference, amount and date-window match"});
      continue;
    }
    if(exact.length>1){matches.push({id:row.id,status:"ambiguous",candidates:exact.map(t=>t.id),reason:"Multiple Tally vouchers contain the same reference"});continue;}
    const unclaimed=options.filter(t=>!claim.has(t.id));
    if(!unclaimed.length){matches.push({id:row.id,status:"unmatched",reason:"No same-direction, same-amount Tally bank voucher within date window"});continue;}
    const strong=unclaimed.filter(t=>t.close&&t.name);
    const candidates=strong.length?strong:unclaimed.filter(t=>t.close);
    matches.push({id:row.id,status:candidates.length>1?"ambiguous":"suggested",
      candidates:(candidates.length?candidates:unclaimed).slice(0,10).map(t=>({id:t.id,date:t.date,number:t.number,party:t.party})),
      reason:"Amount/date coincidence is not sufficient to confirm a bank match"});
  }
  const counts={matched:0,suggested:0,unmatched:0,ambiguous:0,excluded:0,needs_review:0};
  for(const row of matches)counts[row.status]=(counts[row.status]||0)+1;
  return {matches,counts,tally_unmatched:tally.filter(t=>!claim.has(t.id)),
    notice:"Matches are application-side comparisons only; bank reconciliation dates in Tally are not changed."};
}

export function matchInterCompany(a,b){
  const same=(x,y)=>normRef(x)===normRef(y);
  const links=[],used=new Set(),unmatched=[];
  for(const x of a){
    const eligible=b.map((y,index)=>({...y,index})).filter(y=>
      !used.has(y.index)&&Math.abs(money(x.amount)-money(y.amount))<=0.01 &&
      (!Number.isFinite(Number(x.signed))||!Number.isFinite(Number(y.signed))||Math.abs(money(Number(x.signed)+Number(y.signed)))<=0.01) &&
      day(x.date)!==null && day(y.date)!==null && Math.abs(day(x.date)-day(y.date))<=7 &&
      ((x.reference&&y.reference&&same(x.reference,y.reference)) ||
       (x.number&&y.reference&&same(x.number,y.reference)) ||
       (x.reference&&y.number&&same(x.reference,y.number))));
    if(eligible.length===1){used.add(eligible[0].index);links.push({a:x,b:eligible[0],status:"suggested"});}
    else unmatched.push({row:x,reason:eligible.length?"multiple_candidates":"no_matching_reference"});
  }
  return {links,unmatched_a:unmatched,unmatched_b:b.filter((_,i)=>!used.has(i)),
    notice:"These are suggestions only; verify legal entity, voucher nature and reciprocal accounting."};
}
