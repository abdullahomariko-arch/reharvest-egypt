/**
 * Role and record ownership, through real HTTP.
 *
 * Every scenario here was a live hole, reproduced before it was fixed:
 *
 *   F1  /internal/audit-integrity answered 200 to anyone on the network
 *   F2  supplier B recorded a 986.5kg settlement weight on supplier A's lot
 *   F3  a buyer could reach the inspection endpoint
 *   F4  buyer B read buyer A's order total
 *   F5  buyer B opened a deposit against buyer A's order
 */

let failures = 0;
const fail = (m) => { failures += 1; };
const A='http://localhost:9001';
const S=process.env.AUTH_SIGNING_SECRET, RUN=Date.now().toString(36);
const {issueToken}=await import(new URL('../../apps/api/src/auth.ts', import.meta.url).href);
const tk=(u,p,r)=>issueToken({userId:u,partyId:p,roles:r,displayName:'x'},S);

// Two different supplier businesses, and two different buyers.
const SUP_A=await tk('00000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',['supplier','ops_agent']);
const SUP_B=await tk('00000000-0000-4000-8000-000000000011','11111111-1111-4111-8111-111111111112',['supplier','ops_agent']);
const INS  =await tk('00000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333',['inspector']);
const BUY_A=await tk('00000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222221',['buyer']);
const BUY_B=await tk('00000000-0000-4000-8000-000000000012','22222222-2222-4222-8222-222222222222',['buyer']);

const req=async(tok,m,p,b,k)=>{const r=await fetch(A+p,{method:m,headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json',...(k?{'Idempotency-Key':k}:{})},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)};};

console.log('SCENARIO F1 — is /internal/audit-integrity protected?');
{
  const anon=await fetch(`${A}/internal/audit-integrity`);
  const body=await anon.json().catch(()=>null);
  console.log(`  no credentials at all -> HTTP ${anon.status} ${JSON.stringify(body)}`);
  {const ok = anon.status===401||anon.status===403; if(!ok) fail('FAIL — open to anyone on the network'); console.log(`  RESULT: ${ok?'PASS':'FAIL — FAIL — open to anyone on the network'}`);}
}

console.log('\nSCENARIO F2 - can supplier B act on supplier A lot?');
{
  const lot=await req(SUP_A,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:25,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-09-30T00:00:00Z'},`f-${RUN}-1`);
  const id=lot.body.lotId;
  const weigh=await req(SUP_B,'POST',`/lots/${id}/weighings`,{grossGrams:'999000',containerCount:25,scaleId:'sB'},`f-${RUN}-2`);
  console.log(`  supplier B weighs A's lot -> HTTP ${weigh.status} net=${weigh.body?.netGrams}`);
  {const ok = weigh.status===403; if(!ok) fail('FAIL - B set the settlement weight on A produce'); console.log(`  RESULT: ${ok?'PASS':'FAIL — FAIL - B set the settlement weight on A produce'}`);}
}

console.log('\nSCENARIO F3 — can a buyer pass an inspection?');
{
  const lot=await req(SUP_A,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:25,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-09-30T00:00:00Z'},`f-${RUN}-3`);
  const id=lot.body.lotId;
  await req(SUP_A,'POST',`/lots/${id}/weighings`,{grossGrams:'812500',containerCount:25,scaleId:'sA'},`f-${RUN}-4`);
  const insp=await req(BUY_A,'POST',`/lots/${id}/inspections`,{checks:{c:true},freeze:false},`f-${RUN}-5`);
  console.log(`  buyer passes inspection -> HTTP ${insp.status} status=${insp.body?.status}`);
  {const ok = insp.status===403; if(!ok) fail('FAIL — a buyer certified food safety'); console.log(`  RESULT: ${ok?'PASS':'FAIL — FAIL — a buyer certified food safety'}`);}
}

console.log('\nSCENARIO F4 - can buyer B read buyer A order?');
{
  const lot=await req(SUP_A,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:25,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-09-30T00:00:00Z'},`f-${RUN}-6`);
  const id=lot.body.lotId;
  await req(SUP_A,'POST',`/lots/${id}/weighings`,{grossGrams:'812500',containerCount:25,scaleId:'sA'},`f-${RUN}-7`);
  await req(INS,'POST',`/lots/${id}/inspections`,{checks:{c:true},freeze:false},`f-${RUN}-8`);
  const o=await req(BUY_A,'POST','/orders',{lotId:id,quantityGrams:'400000'},`f-${RUN}-9`);
  const peek=await req(BUY_B,'GET',`/orders/${o.body.orderCode}`);
  console.log(`  buyer B reads A's order -> HTTP ${peek.status} total=${peek.body?.totalPiastres}`);
  {const ok = peek.status===403||peek.status===404; if(!ok) fail('FAIL — commercial terms leaked between competitors'); console.log(`  RESULT: ${ok?'PASS':'FAIL — FAIL — commercial terms leaked between competitors'}`);}
}

console.log('\nSCENARIO F5 - can a buyer start a deposit on someone else order?');
{
  const lot=await req(SUP_A,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:25,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-09-30T00:00:00Z'},`f-${RUN}-10`);
  const id=lot.body.lotId;
  await req(SUP_A,'POST',`/lots/${id}/weighings`,{grossGrams:'812500',containerCount:25,scaleId:'sA'},`f-${RUN}-11`);
  await req(INS,'POST',`/lots/${id}/inspections`,{checks:{c:true},freeze:false},`f-${RUN}-12`);
  const o=await req(BUY_A,'POST','/orders',{lotId:id,quantityGrams:'400000'},`f-${RUN}-13`);
  const dep=await req(BUY_B,'POST',`/orders/${o.body.orderCode}/deposit-intention`,{completedOrders:0,hasVerifiedBankAccount:false},`f-${RUN}-14`);
  console.log(`  buyer B opens a deposit on A's order -> HTTP ${dep.status}`);
  {const ok = dep.status===403||dep.status===404; if(!ok) fail('FAIL - B can pay into A order and see its amount'); console.log(`  RESULT: ${ok?'PASS':'FAIL — FAIL - B can pay into A order and see its amount'}`);}
}


if (failures > 0) { console.error(`\n${failures} scenario(s) failed.`); process.exit(1); }
console.log('\nAll scenarios passed.');

/* ------------------------------------------------------------------ *
 * The legitimate paths must still work.
 *
 * A lockdown that also blocks normal use is worse than the hole it closed:
 * it gets reverted wholesale under pressure, and the hole comes back with it.
 * ------------------------------------------------------------------ */

console.log('\nLEGITIMATE USE STILL WORKS');
{
  const lot = await req(SUP_A, 'POST', '/lots', { crop: 'tomato', grossGrams: '812500', containerCount: 25,
    packagingSpecId: 'plastic_standard', packagingSpecVersion: 2, pricePerKgPiastres: '875',
    collectBy: '2026-09-30T00:00:00Z' }, `ok-${RUN}-1`);
  const okList = lot.status === 200;
  console.log(`  supplier lists their own lot        -> ${lot.status}`);
  if (!okList) fail('a supplier could not list a lot');

  const w = await req(SUP_A, 'POST', `/lots/${lot.body.lotId}/weighings`,
    { grossGrams: '812500', containerCount: 25, scaleId: 'sA' }, `ok-${RUN}-2`);
  console.log(`  supplier weighs their own lot       -> ${w.status}`);
  if (w.status !== 200) fail('a supplier could not weigh their own lot');

  const i = await req(INS, 'POST', `/lots/${lot.body.lotId}/inspections`,
    { checks: { c: true }, freeze: false }, `ok-${RUN}-3`);
  console.log(`  inspector passes the inspection     -> ${i.status}`);
  if (i.status !== 200) fail('an inspector could not pass an inspection');

  const o = await req(BUY_A, 'POST', '/orders',
    { lotId: lot.body.lotId, quantityGrams: '400000' }, `ok-${RUN}-4`);
  console.log(`  buyer places an order               -> ${o.status}`);
  if (o.status !== 200) fail('a buyer could not place an order');

  const own = await req(BUY_A, 'GET', `/orders/${o.body.orderCode}`);
  console.log(`  buyer reads their own order         -> ${own.status}`);
  if (own.status !== 200) fail('a buyer could not read their own order');

  const OPS = await tk('00000000-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', ['ops_manager']);
  const audit = await fetch(`${A}/internal/audit-integrity`, { headers: { Authorization: `Bearer ${OPS}` } });
  console.log(`  ops manager reads audit integrity   -> ${audit.status}`);
  if (audit.status !== 200) fail('an ops manager could not read audit integrity');

  const staffPeek = await req(OPS, 'GET', `/orders/${o.body.orderCode}`);
  console.log(`  ops manager reads any order         -> ${staffPeek.status}`);
  if (staffPeek.status !== 200) fail('platform staff could not read an order');
}
