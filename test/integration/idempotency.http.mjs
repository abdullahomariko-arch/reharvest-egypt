/**
 * Idempotency, through real HTTP against two API instances sharing one database.
 *
 * Scenario 1 — the same key with a ten times larger amount must be refused.
 * Scenario 2 — two instances, same key, simultaneous: exactly one order.
 * Scenario 3 — the same key from a different user must not return the first
 *              user's response.
 *
 * All three were reproduced as failures before the fix; scenario 3 in
 * particular returned another user's order code.
 */

let failures = 0;
const fail = (m) => { failures += 1; console.error('  FAIL:', m); };
const A='http://localhost:9001', B='http://localhost:9002';
const S=process.env.AUTH_SIGNING_SECRET, RUN=Date.now().toString(36);
const {issueToken}=await import(new URL('../../apps/api/src/auth.ts', import.meta.url).href);
const tk=(u,p,r)=>issueToken({userId:u,partyId:p,roles:r,displayName:'x'},S);
const SUP=await tk('00000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',['supplier','ops_agent']);
const INS=await tk('00000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333',['inspector']);
const BUY=await tk('00000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222221',['buyer']);
const BUY2=await tk('00000000-0000-4000-8000-000000000009','22222222-2222-4222-8222-222222222221',['buyer']);

const req=async(base,tok,m,p,body,key)=>{
  const r=await fetch(base+p,{method:m,headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status, body:await r.json().catch(()=>null)};
};
const mkLot = async (n) => {
  const l=await req(A,SUP,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:25,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-09-30T00:00:00Z'},`r-${RUN}-${n}-c`);
  await req(A,SUP,'POST',`/lots/${l.body.lotId}/weighings`,{grossGrams:'812500',containerCount:25,scaleId:'s1'},`r-${RUN}-${n}-w`);
  await req(A,INS,'POST',`/lots/${l.body.lotId}/inspections`,{checks:{c:true},freeze:false},`r-${RUN}-${n}-i`);
  return l.body.lotId;
};

console.log('SCENARIO 1 — same key, 10x amount');
{
  const lot1=await mkLot('s1a'), lot2=await mkLot('s1b');
  const key=`s1-${RUN}`;
  const first=await req(A,BUY,'POST','/orders',{lotId:lot1,quantityGrams:'80000'},key);
  const second=await req(A,BUY,'POST','/orders',{lotId:lot2,quantityGrams:'800000'},key);
  console.log(`  first  HTTP ${first.status} total=${first.body?.totalPiastres}`);
  console.log(`  second HTTP ${second.status} total=${second.body?.totalPiastres}  (expect 409)`);
  {const ok = second.status===409; if(!ok) fail('FAIL — 10x amount not refused'); console.log(`  RESULT: ${ok?'PASS':'FAIL'}`);}
}

console.log('\nSCENARIO 2 — two instances, same key, simultaneous');
{
  const lot=await mkLot('s2');
  const key=`s2-${RUN}`;
  const [a,b]=await Promise.all([
    req(A,BUY,'POST','/orders',{lotId:lot,quantityGrams:'400000'},key),
    req(B,BUY,'POST','/orders',{lotId:lot,quantityGrams:'400000'},key),
  ]);
  console.log(`  A HTTP ${a.status} order=${a.body?.orderCode}`);
  console.log(`  B HTTP ${b.status} order=${b.body?.orderCode}`);
  const codes=new Set([a.body?.orderCode,b.body?.orderCode].filter(Boolean));
  const lotAfter=await req(A,BUY,'GET',`/lots`,null);
  const l=lotAfter.body?.lots?.find(x=>x.lotId===lot);
  console.log(`  distinct orders created: ${codes.size}  reservedGrams implied avail=${l?.availableGrams}`);
  {const ok = codes.size===1; if(!ok) fail('FAIL — reserved twice under one key'); console.log(`  RESULT: ${ok?'PASS':'FAIL'}`);}
}

console.log('\nSCENARIO 3 — same key, different user');
{
  const lot=await mkLot('s3');
  const key=`s3-${RUN}`;
  const first=await req(A,BUY,'POST','/orders',{lotId:lot,quantityGrams:'100000'},key);
  const other=await req(A,BUY2,'POST','/orders',{lotId:lot,quantityGrams:'100000'},key);
  console.log(`  user1 HTTP ${first.status} order=${first.body?.orderCode}`);
  console.log(`  user2 HTTP ${other.status} order=${other.body?.orderCode}`);
  const leaked = other.body?.orderCode && other.body.orderCode === first.body.orderCode;
  // Counted, not merely printed. This previously reported FAIL while leaving the
  // exit code at 0, so CI would have gone green on a reproduced data leak.
  if (leaked) fail("user2 received user1's order");
  console.log(`  RESULT: ${leaked ? "FAIL — user2 received user1's order" : 'PASS'}`);
}

console.log('\nSCENARIO 3b — same key, different endpoint (payment route middleware)');
{
  const key=`s3b-${RUN}`;
  const r1=await req(A,BUY,'POST','/orders',{lotId:await mkLot('s3b'),quantityGrams:'100000'},key);
  const r2=await req(A,BUY,'POST','/settlements/STL-X/pay',{amount:'999999'},key);
  console.log(`  /orders            HTTP ${r1.status}`);
  console.log(`  /settlements/../pay HTTP ${r2.status} body=${JSON.stringify(r2.body).slice(0, 90)}`);

  /*
    The same key on a second endpoint must never replay the first endpoint's
    response. A 403 here is the role check refusing a buyer, which is a correct
    refusal; what must not happen is a 200 carrying the order from /orders.
  */
  const replayedAcrossRoutes = r2.status === 200 && JSON.stringify(r2.body ?? {}).includes('orderCode');
  if (replayedAcrossRoutes) fail('a key from /orders replayed on /settlements/../pay');
  console.log(`  RESULT: ${replayedAcrossRoutes ? 'FAIL — cross-endpoint replay' : 'PASS'}`);
}


if (failures > 0) { console.error(`\n${failures} scenario(s) failed.`); process.exit(1); }
console.log('\nAll scenarios passed.');
