import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { resolveFeatures, extendedDefinitions, normalizeExtendedResult } from '../src/extended/contracts.js';
import { createBudget, BoundedStore } from '../src/extended/store.js';
import { OperationLedger, executeScript } from '../src/extended/execution.js';
import { CaptureCollector } from '../src/extended/capture.js';
import { migrateProfile, design } from '../src/extended/design.js';
import { validateCortexArguments, redact, redactData } from '../src/core/cortex-utils.js';
import { createCortexRuntime } from '../src/index.js';

test('catalogo host stabile: base 4, diagnostico 7, esteso 10 solo con capability script',async()=>{
  for(const [profile,policy,count] of [['base',{},4],['diagnostic',{},7],['extended',{},9],['extended',{allowScripts:true},10]]) {
    const runtime=createCortexRuntime({config:{toolProfile:profile},policy,env:{}});
    assert.equal(runtime.definitions.length,count);await runtime.close();
  }
  assert.throws(()=>resolveFeatures({config:{toolProfile:'unknown'},env:{}}));
  assert.throws(()=>resolveFeatures({config:{modules:['arbitrary']},env:{}}));
});
test('schema chiusi, array/items e numeri finiti, nessun pass-through CDP',()=>{
  const tools=extendedDefinitions(resolveFeatures({config:{toolProfile:'extended'},policy:{allowScripts:true},env:{}}));
  const visit=s=>{if(s.type==='array'){assert.ok(s.items);visit(s.items);}if(s.properties)for(const c of Object.values(s.properties))visit(c);};
  for(const tool of tools){visit(tool.inputSchema);visit(tool.outputSchema);assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.inputSchema.properties.method,undefined);}
  const spec=tools.find(t=>t.name==='cortex_observe').inputSchema;
  assert.throws(()=>validateCortexArguments({clip:{x:NaN,y:0,width:20,height:20}},spec));
  assert.throws(()=>validateCortexArguments({clip:{x:Infinity,y:0,width:20,height:20}},spec));
  assert.throws(()=>validateCortexArguments({clip:{x:0,y:0,width:20,height:20,execute:'bad'}},spec));
});
test('budget condiviso: rifiuto prima di superare quota, rilascio esatto',()=>{
  const budget=createBudget(100);budget.reserve(70);assert.throws(()=>budget.reserve(31),{name:'BudgetExceeded'});assert.equal(budget.used,70);
  budget.release(70);assert.equal(budget.used,0);assert.throws(()=>budget.reserve(-1));
});
test('error envelope v1 coerente anche per validation/cancel/SessionClosed',()=>{
  for(const kind of ['StaleObservation','AbortError','SessionClosed','QueueFull']) {
    const response=normalizeExtendedResult({content:[],structuredContent:{ok:false,error:{kind,message:'fixture'},phase:'validation',sessionId:'s',isolated:true},isError:true});
    assert.equal(response.structuredContent.contractVersion,1);assert.equal(response.structuredContent.error.kind,kind);assert.equal(response.structuredContent.data.phase,'validation');
    assert.deepEqual(JSON.parse(response.content[0].text),response.structuredContent);assert.equal(response.isError,true);
  }
});
test('store TTL/evizione e isolamento non riutilizzano identificatori sconosciuti',()=>{
  let now=0;const budget=createBudget(1000),a=new BoundedStore({budget,maxEntries:1,ttlMs:100,now:()=>now}),b=new BoundedStore({budget});
  try {
    a.put({state:'first'},'a');a.put({state:'second'},'b');assert.throws(()=>a.get('a'),{name:'StaleObservation'});
    assert.throws(()=>b.get('b'),{name:'StaleObservation'});now=101;assert.throws(()=>a.get('b'),{name:'StaleObservation'});assert.equal(budget.used,0);
  } finally{a.close();b.close();}
});
test('ledger idempotenza e conflitto argomenti: nessuna riesecuzione implicita',()=>{
  const budget=createBudget(),ledger=new OperationLedger(budget);
  ledger.begin('operation',{step:'click'});ledger.finish('operation',{structuredContent:{ok:true}});
  assert.equal(ledger.begin('operation',{step:'click'}).replay,true);
  assert.throws(()=>ledger.begin('operation',{step:'fill'}),{name:'PolicyDenied'});
  assert.throws(()=>ledger.get('another'),{name:'ExecutionUncertain'});
  ledger.close();assert.equal(budget.used,0);
});
test('ledger quota conserva tombstone, rifiuta nuova azione',()=>{
  const ledger=new OperationLedger(createBudget());for(let n=0;n<256;n++)ledger.begin(String(n),{});
  assert.throws(()=>ledger.begin('257',{}),{name:'BudgetExceeded'});assert.equal(ledger.begin('0',{}).replay,true);ledger.close();
});
function fixtureCollector() {
  const budget=createBudget(),page=new EventEmitter(),context=new EventEmitter();page.url=()=> 'https://allowed.test/';context.pages=()=>[page];
  const collector=new CaptureCollector({budget,pageIdentity:()=>({pageId:'p',documentEpoch:1}),origins:()=>['https://allowed.test']});
  const request=(url='https://allowed.test/api')=>({url:()=>url,frame:()=>({page:()=>page}),redirectedFrom:()=>null,method:()=> 'GET',resourceType:()=> 'fetch',failure:()=>({errorText:'blocked'})});
  return {budget,page,context,collector,request};
}
test('capture preventiva: pre-start escluso, 500 distinto da failure, stop immutabile',()=>{
  const {budget,context,collector,request}=fixtureCollector();const r=request();context.emit('request',r);
  try {
    const c=collector.start(context,{durationMs:10000});context.emit('request',r);
    context.emit('response',{request:()=>r,status:()=>500,fromServiceWorker:()=>false});context.emit('requestfinished',r);
    collector.stop();context.emit('request',request());
    const list=collector.call(context,{action:'list',captureId:c.captureId});assert.equal(list.events.length,1);assert.equal(list.events[0].status,500);assert.equal(list.events[0].state,'completed');
    assert.equal(list.events[0].body.state,'omitted-policy');assert.equal(context.listenerCount('request'),0);
  }finally {collector.close();assert.equal(budget.used,0);}
});
test('capture quote/perdite, origin negato e paginazione stabile senza filtri mutevoli',()=>{
  const {context,collector,request}=fixtureCollector();
  try {
    const c=collector.start(context,{maxEvents:2});context.emit('request',request('https://denied.test/'));for(let i=0;i<4;i++)context.emit('request',request());
    assert.throws(()=>collector.call(context,{action:'list',captureId:c.captureId}),{name:'PolicyDenied'});
    const status=collector.stop();assert.equal(status.events,2);assert.equal(status.dropped,2);assert.equal(status.coverage.complete,false);
    const list=collector.call(context,{action:'list',captureId:c.captureId,limit:1});assert.ok(list.nextCursor);
    assert.throws(()=>collector.call(context,{action:'list',captureId:c.captureId,cursor:list.nextCursor,kind:'console'}),{name:'CaptureExpired'});
    assert.throws(()=>collector.call(context,{action:'detail',captureId:'other',eventId:'x'}),{name:'CaptureExpired'});
    assert.throws(()=>collector.call(context,{action:'start',eventId:'x'}),{name:'PolicyDenied'});
  }finally{collector.close();}
});
test('capture console redatta, errori non leggono argomenti/getter',()=>{
  const {page,context,collector}=fixtureCollector();
  try{
    const c=collector.start(context);page.emit('console',{type:()=> 'warn',text:()=> 'password=fixture-secret Bearer opaque',location:()=>({url:'https://allowed.test/a?token=fixture-secret',lineNumber:1,columnNumber:2})});
    collector.stop();const events=collector.call(context,{action:'list',captureId:c.captureId}).events;
    assert.doesNotMatch(JSON.stringify(events),/fixture-secret|opaque/);assert.equal(events[0].stack.state,'unsupported');
  }finally{collector.close();}
});
test('profili: migrazione legacy non distruttiva e approvazioni importate rifiutate',()=>{
  const input={samples:[{tag:'button',fontSize:'16px'}],evidence:[],status:'approved',approval:{approver:'model'}};
  const migrated=migrateProfile(input);assert.equal(migrated.schemaVersion,1);assert.equal(migrated.status,'draft');assert.equal(migrated.approval,null);assert.equal(input.status,'approved');
  assert.throws(()=>migrateProfile({...input,schemaVersion:99}),{name:'UnsupportedCapability'});
  assert.throws(()=>migrateProfile({...input,samples:[{password:'bad'}]}),{name:'PolicyDenied'});
});

test('redazione JSON: chiavi quotate/escape, strutture annidate e valori con spazi',()=>{
  for(const text of ['{"password":"fixture secret with spaces","n":2}', 'log: {"token":"fixture secret with spaces"}', '{"pass\\u0077ord":"fixture-secret"}', 'password="fixture secret with spaces"', '{"password":"fixture secret with spaces']) {
    assert.doesNotMatch(redact(text),/fixture|secret with spaces/);
  }
  const data=redactData({properties:{password:{type:'string',value:'fixture-secret'},nested:{token:['fixture-secret']}},safe:2});
  assert.equal(data.properties.password,'[redacted]');assert.equal(data.safe,2);assert.doesNotMatch(JSON.stringify(data),/fixture/);
});

test('capture console elimina segreti JSON prima dello storage',()=>{
  const {page,context,collector}=fixtureCollector();
  try {
    const c=collector.start(context);
    page.emit('console',{type:()=> 'log',text:()=> '{"password":"fixture secret","nested":{"api_key":"fixture-secret"}}',location:()=>({})});
    collector.stop();assert.doesNotMatch(JSON.stringify(collector.call(context,{action:'list',captureId:c.captureId})),/fixture/);
  } finally {collector.close();}
});

test('serializer limita in UTF-8 il risultato prima del trasferimento browser',async()=>{
  const run=code=>runInNewContext(`(${executeScript.toString()})({code,argument:null})`,{code,Element:class {},TextEncoder});
  const small=await run('return {n:42}');assert.equal(small.state,'available');assert.equal(small.value.properties.n,42);
  for(const code of ['return Array(10).fill("x".repeat(8192))','return Array(10).fill("€".repeat(8192))','return {["k".repeat(40000)]:1}']) {
    const result=await run(code);assert.equal(result.state,'truncated');assert.ok(Buffer.byteLength(JSON.stringify(result))<32768);
  }
});

test('design invalida e persiste revoca approvazione dopo cambio dipendenze',()=>{
  const budget=createBudget(),snapshots=new BoundedStore({budget}),profiles=new BoundedStore({budget});
  const samples=[{tag:'button',fontSize:'16px'}];
  const snapshot=(id,sources)=>({snapshotId:id,sources,designSample:samples,target:{pageId:'p',documentEpoch:1},state:{viewport:{width:800,height:600}}});
  try {
    snapshots.put(snapshot('a',[{url:'a.css'}]),'a');snapshots.put(snapshot('b',[{url:'b.css'}]),'b');
    const features={approvedDesign:{samplesHash:createHash('sha256').update(JSON.stringify(samples)).digest('hex'),approver:'fixture-host',version:'1'}};
    const call=args=>design({args,snapshots,profiles,features});
    const profile=call({action:'build',snapshotIds:['a']});assert.equal(profile.status,'approved');
    assert.equal(call({action:'compare',profileId:profile.profileId,snapshotIds:['a']}).approvedReference,true);
    const comparison=call({action:'compare',profileId:profile.profileId,snapshotIds:['b']});
    assert.equal(comparison.stale,true);assert.equal(comparison.approvedReference,false);assert.equal(comparison.verdict,'review-required');
    const saved=call({action:'get',profileId:profile.profileId});assert.equal(saved.status,'draft');assert.equal(saved.approval,null);
    assert.equal(call({action:'compare',profileId:profile.profileId,snapshotIds:['a']}).approvedReference,false);
  }finally {snapshots.close();profiles.close();assert.equal(budget.used,0);}
});
