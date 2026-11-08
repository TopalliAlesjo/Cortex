import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCortexRuntime } from '../src/index.js';
import { createCortexMcpServer } from '../src/mcp/server.js';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-evolution-'));
let mutations=0;
const fixture=http.createServer((req,res)=>{
  if(req.url==='/api'){res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"fixture"}');return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><html><head><style>body{margin:0;font-family:monospace;background:white}h1{margin:0;height:50px}#red{position:absolute;left:20px;top:60px;width:100px;height:80px;background:rgb(255,0,0)}#blue{position:absolute;left:200px;top:60px;width:80px;height:80px;background:rgb(0,0,255)}button{font-family:monospace;font-size:19px}main{padding-top:160px}#scroll{height:50px;width:100px;overflow:auto}#scroll div{height:300px}#long{height:1400px}</style></head>
  <body><h1>Cortex fixture</h1><div id=red></div><div id=blue></div><main><section id=each-row><label>Nome<input id=name value="fixture-private-input"></label><button id=act onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#count').textContent=window.clicks;fetch('/api').then(r=>r.text()).then(()=>document.querySelector('#status').textContent='errore gestito')">Esegui</button><p id=count>0</p><p id=status>pronto</p><div id=scroll><div>scrollabile</div></div><div id=long></div></section></main><script>console.warn('password=fixture-secret');window.addEventListener('load',()=>console.log('fixture-loaded'));</script></body></html>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${fixture.address().port}`;
const runtime=createCortexRuntime({config:{origins:[origin],artifacts:temp,toolProfile:'extended'},policy:{allowScripts:true,allowDebugger:true,allowTrace:true},idleTimeoutMs:0,env:{}});
const app=createCortexMcpServer({runtime}),client=new Client({name:'cortex-fixture-sdk',version:'1.0.0'});
const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
const raw=async(name,args={})=>client.callTool({name,arguments:args});
const call=async(name,args={})=>{const response=await raw(name,args);assert.equal(response.isError,undefined,JSON.stringify(response));return response;};
const body=async(name,args={})=>(await call(name,args)).structuredContent;
const data=async(name,args={})=>(await body(name,args)).data;
const checks=[];const check=name=>{checks.push(name);console.log('[PASS] '+name);};

// PNG oracle checks actual emitted pixels, independently from Cortex's geometry.
function pngPixels(bytes) {
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),type=bytes[25],channels=type===6?4:type===2?3:0;
  assert.ok(channels,'RGB/RGBA PNG expected');const chunks=[];
  for(let i=8;i<bytes.length;){const n=bytes.readUInt32BE(i),type=bytes.toString('ascii',i+4,i+8);if(type==='IDAT')chunks.push(bytes.subarray(i+8,i+8+n));i+=n+12;}
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,out=Buffer.alloc(stride*height);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];for(let x=0;x<stride;x++){const a=x>=channels?out[y*stride+x-channels]:0,b=y?out[(y-1)*stride+x]:0,c=y&&x>=channels?out[(y-1)*stride+x-channels]:0;out[y*stride+x]=(raw[y*(stride+1)+1+x]+([0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter]))&255;}}
  return {width,height,pixel:(x,y)=>[...out.subarray((y*width+x)*channels,(y*width+x)*channels+3)]};
}
try {
  await app.server.connect(serverTransport);await client.connect(clientTransport);
  assert.equal((await client.listTools()).tools.length,10);check('MCP SDK initialize/list, 10 tool e outputSchema');
  const sessionId=(await body('cortex_open',{url:origin,newSession:true,capture:true})).sessionId;
  const captureId=(await data('cortex_capture',{sessionId,action:'status'})).captureId;
  const observation=await call('cortex_observe',{sessionId,mode:'hybrid'}),snapshot=observation.structuredContent.data;
  const image=observation.content.find(block=>block.type==='image');assert.ok(image);assert.equal(image.mimeType,'image/png');
  const bytes=Buffer.from(image.data,'base64'),pixels=pngPixels(bytes);assert.deepEqual(pixels.pixel(40,80),[255,0,0]);assert.deepEqual(pixels.pixel(220,80),[0,0,255]);
  assert.equal(snapshot.bitmap.width,pixels.width);assert.equal(snapshot.imageDelivery,'inline-emitted');
  assert.deepEqual(JSON.parse(observation.content[0].text),observation.structuredContent);check('Immagine MCP reale: pixel rosso/blu, metadata e fallback JSON concordi');
  const node=await data('cortex_inspect',{sessionId,target:'#act',facets:['computed','box','accessibility','rules','pseudo','source']});
  assert.equal(node.computed['font-family'],'monospace');assert.equal(node.accessibility.kind,'Chromium-AX');assert.ok(node.box.quads);check('Font preservato, computed, AX Chromium, quads, CSSOM e provenance');
  const inputBox=await data('cortex_inspect',{sessionId,target:'#name',facets:['box']});
  const inputPixel=pixels.pixel(Math.floor(inputBox.box.rect.x+inputBox.box.rect.width/2),Math.floor(inputBox.box.rect.y+inputBox.box.rect.height/2));assert.deepEqual(inputPixel,[0,0,0]);
  assert.doesNotMatch(JSON.stringify(snapshot),/fixture-private-input/);check('Privacy: input mascherato nei pixel e valore escluso dalla struttura');
  const crop=await call('cortex_observe',{sessionId,mode:'image',clip:{x:20,y:60,width:100,height:80}});
  const cropPixels=pngPixels(Buffer.from(crop.content.find(c=>c.type==='image').data,'base64'));assert.equal(cropPixels.width,100);assert.deepEqual(cropPixels.pixel(10,10),[255,0,0]);check('Crop reale e trasformazione bitmap/CSS');
  const hit=await data('cortex_inspect',{sessionId,snapshotId:crop.structuredContent.data.snapshotId,point:{x:10,y:10}});assert.equal(hit.candidates[0].tag,'div');
  const plan={sessionId,operationId:'fixture-click-1',steps:[{op:'click',target:'#act'},{op:'expect_text',target:'#status',value:'errore gestito'}]};
  await call('cortex_run',plan);await call('cortex_run',plan);await call('cortex_run',{sessionId,steps:[{op:'expect_text',target:'#count',value:'1'}]});
  const operation=(await body('cortex_debug',{sessionId,operationId:'fixture-click-1'})).operation;assert.equal(operation.executionState,'completed');
  assert.equal((await raw('cortex_run',{...plan,steps:[{op:'click',target:'#act'}]})).isError,true);check('Operation ledger: duplicate senza replay, conflitto e stato interrogabile');
  const stale=await raw('cortex_inspect',{sessionId,snapshotId:crop.structuredContent.data.snapshotId,point:{x:10,y:10}});assert.equal(stale.structuredContent.error.kind,'StaleObservation');check('Invalidazione snapshot dopo mutazione DOM');
  await data('cortex_capture',{sessionId,action:'stop',captureId});
  const events=await data('cortex_capture',{sessionId,action:'list',captureId,limit:100});
  assert.ok(events.events.some(e=>e.kind==='network'&&e.url===origin+'/'));assert.ok(events.events.some(e=>e.kind==='console'));
  const failure=events.events.find(e=>e.kind==='network'&&e.url===origin+'/api');assert.equal(failure.status,500);assert.equal(failure.state,'completed');assert.equal(failure.body.state,'omitted-policy');
  assert.doesNotMatch(JSON.stringify(events),/fixture-secret/);check('Capture pre-load, console redatta, HTTP 500 distinto da errore trasporto, body off');
  const one=await data('cortex_capture',{sessionId,action:'list',captureId,limit:1});if(one.nextCursor)assert.ok((await data('cortex_capture',{sessionId,action:'list',captureId,cursor:one.nextCursor,limit:1})).events.length);
  const detail=await data('cortex_capture',{sessionId,action:'detail',captureId,eventId:failure.eventId});assert.equal(detail.eventId,failure.eventId);check('Capture sealed: detail e paginazione stabile');
  const other=(await body('cortex_open',{url:origin,newSession:true})).sessionId;
  assert.equal((await raw('cortex_capture',{sessionId:other,action:'status',captureId})).structuredContent.error.kind,'CaptureExpired');
  assert.equal((await raw('cortex_inspect',{sessionId:other,snapshotId:crop.structuredContent.data.snapshotId,point:{x:10,y:10}})).structuredContent.error.kind,'StaleObservation');
  assert.equal((await raw('cortex_observe',{sessionId:other,pageId:snapshot.target.pageId})).structuredContent.error.kind,'StaleObservation');check('Isolamento capture/snapshot/pageId tra sessioni');
  const latest=await data('cortex_observe',{sessionId,mode:'structure'});
  const profile=await data('cortex_design',{sessionId,action:'build',snapshotIds:[latest.snapshotId]});assert.equal(profile.status,'draft');
  const exported=await data('cortex_design',{sessionId,action:'export',profileId:profile.profileId});const imported=await data('cortex_design',{sessionId,action:'import',profileJson:exported.profileJson});assert.equal(imported.approval,null);
  const compare=await data('cortex_design',{sessionId,action:'compare',profileId:profile.profileId,snapshotIds:[latest.snapshotId]});assert.equal(compare.verdict,'review-required');check('Design build/export/import/compare senza auto-approvazione');
  const script={sessionId,pageId:latest.target.pageId,expectedDocumentEpoch:latest.target.documentEpoch,operationId:'script-1',code:'window.scriptCount=(window.scriptCount||0)+1; const value={n:window.scriptCount,big:1n}; Object.defineProperty(value,"secretGetter",{get(){throw new Error("must not call")}});value.self=value; return value;'};
  const evaluated=await data('cortex_evaluate',script);assert.equal(evaluated.executionState,'completed');assert.equal(evaluated.result.value.properties.secretGetter.type,'accessor');
  const duplicate=await data('cortex_evaluate',script);assert.equal(duplicate.result.value.properties.n,1);check('Evaluate: BigInt/cicli/getter non invocato, duplicato senza replay');
  const secret=await data('cortex_evaluate',{...script,operationId:'json-secret',code:'return {password:"fixture-json-secret",nested:{token:"fixture-json-secret"},ok:42};'});
  assert.doesNotMatch(JSON.stringify(secret),/fixture-json-secret/);assert.equal(secret.result.value.properties.ok,42);
  const huge=await data('cortex_evaluate',{...script,operationId:'huge-result',code:'window.hugeRuns=(window.hugeRuns||0)+1;return Array(10).fill("€".repeat(8192));'});
  assert.equal(huge.result.state,'truncated');assert.equal(huge.executionState,'completed');
  const multibyte=await raw('cortex_evaluate',{...script,operationId:'utf8-code',code:'/*'+'€'.repeat(12000)+'*/ return 1;'});
  assert.equal(multibyte.isError,true);assert.equal(multibyte.structuredContent.error.kind,'BudgetExceeded');
  check('Evaluate: JSON redatto, quota risultato renderer e codice UTF-8 prima del dispatch');
  const partialPlan={sessionId,operationId:'each-partial',steps:[{op:'each',target:'css:#each-row',limit:1,steps:[{op:'click',target:'#act'},{op:'click',target:'css:button,input'}]}]};
  const partial=await raw('cortex_run',partialPlan);assert.equal(partial.isError,true);
  assert.equal(partial.structuredContent.executionState,'failed');assert.equal(partial.structuredContent.effects,'possible');assert.equal(partial.structuredContent.failedStepExecutionState,'not-started');
  const partialLedger=(await body('cortex_debug',{sessionId,operationId:'each-partial'})).operation;
  assert.equal(partialLedger.executionState,'failed');assert.equal(partialLedger.steps[0].state,'completed');assert.equal(partialLedger.steps[1].state,'not-started');
  assert.deepEqual(await raw('cortex_run',partialPlan),partial);
  await call('cortex_run',{sessionId,steps:[{op:'expect_text',target:'#count',value:'2'}]});
  check('Each parziale: effetti conservati, ledger atomico corretto e nessun replay');
  const metrics=await data('cortex_devtools',{sessionId,action:'metrics'});assert.ok(metrics.metrics.length);const memory=await data('cortex_devtools',{sessionId,action:'memory'});assert.ok(memory.heapUsage.usedSize>0);
  const storage=await data('cortex_devtools',{sessionId,action:'storage'});assert.equal(storage.localStorage.values,'omitted-policy');check('DevTools metrics/memory/storage senza valori sensibili');
  await data('cortex_devtools',{sessionId,action:'coverage-start',durationMs:500});
  await call('cortex_run',{sessionId,steps:[{op:'hover',target:'#act'},{op:'focus',target:'#name'},{op:'scroll',target:'#scroll',y:20},{op:'resize',width:1000,height:700}]});
  const coverage=await data('cortex_devtools',{sessionId,action:'coverage-stop'});assert.equal(coverage.state,'sealed');check('Hover/focus/scroll/resize e coverage bounded nella durata');
  console.log('[CHECK] target timeline start/stop');
  await data('cortex_devtools',{sessionId,action:'trace-start',durationMs:500});const trace=await data('cortex_devtools',{sessionId,action:'trace-stop'});assert.equal(trace.kind,'target-performance-timeline');
  console.log('[CHECK] debugger pause lease');
  await data('cortex_devtools',{sessionId,action:'pause',durationMs:100});await new Promise(resolve=>setTimeout(resolve,200));
  await call('cortex_peek',{sessionId,waitForReady:false});check('Timeline target e debugger con auto-resume fuori FIFO');
  const timeout=await raw('cortex_evaluate',{sessionId,pageId:latest.target.pageId,expectedDocumentEpoch:latest.target.documentEpoch,operationId:'timeout-script',code:'while(true){}',timeout:150});
  assert.equal(timeout.structuredContent.data.executionState,'unknown');assert.equal(timeout.structuredContent.data.targetClosed,true);assert.equal(timeout.isError,true);
  await call('cortex_peek',{sessionId:other});check('Loop sincrono: timeout/close target, esito unknown e altra sessione integra');
  const after=await raw('cortex_evaluate',{sessionId,pageId:latest.target.pageId,expectedDocumentEpoch:latest.target.documentEpoch,operationId:'timeout-script',code:'while(true){}',timeout:150});
  assert.equal(after.structuredContent.data.executionState,'unknown');check('Retry script incerto restituisce ledger senza nuova esecuzione');
  await call('cortex_debug',{sessionId,closeSession:true});await call('cortex_debug',{sessionId:other,closeSession:true});
  if(process.env.CORTEX_TEST_EVIDENCE){await fs.mkdir(process.env.CORTEX_TEST_EVIDENCE,{recursive:true});await fs.writeFile(path.join(process.env.CORTEX_TEST_EVIDENCE,'canary.png'),bytes);await fs.writeFile(path.join(process.env.CORTEX_TEST_EVIDENCE,'extended-results.json'),JSON.stringify({at:new Date().toISOString(),platform:process.platform,node:process.version,checks,imageDelivery:'SDK-transport-received',modelPerception:'not-certified',browser:'Playwright Chromium pinned 1.58.2',scope:'loopback-fixtures-only'},null,2));}
  console.log(`[PASS] ${checks.length} scenari estesi su fixture locali, SDK MCP reale`);
} finally {
  await client.close().catch(()=>{});await app.close();await new Promise(resolve=>fixture.close(resolve));
  assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));await fs.rm(temp,{recursive:true,force:true});
}
