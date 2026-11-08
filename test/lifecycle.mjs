import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCortexRuntime } from '../src/index.js';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-lifecycle-'));
let mutations=0,marked;
const fixture=http.createServer((req,res)=>{
  if(req.url==='/mutation'){mutations++;marked?.();res.end('ok');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end('<main><h1>Lifecycle</h1><button onclick="fetch(\'/mutation\')">Modifica</button><p>pronto</p></main>');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+fixture.address().port;
const runtime=createCortexRuntime({config:{origins:[origin],artifacts:temp},idleTimeoutMs:0});
const body=response=>{assert.equal(response.isError,undefined,JSON.stringify(response));return response.structuredContent;};
try {
  const a=body(await runtime.call('cortex_open',{url:origin,newSession:true})).sessionId;
  const b=body(await runtime.call('cortex_open',{url:origin,newSession:true})).sessionId;
  const signal=new AbortController();
  const mutation=new Promise(resolve=>{marked=resolve;});
  const active=runtime.call('cortex_run',{sessionId:a,steps:[{op:'click',target:'role:button|Modifica'},{op:'expect_visible',target:'.never',timeout:30000},{op:'click',target:'role:button|Modifica'}]},{signal:signal.signal});
  console.log('[CHECK] lifecycle active cancellation');
  await Promise.race([mutation,active.then(r=>{throw Error('Run ended before fixture marker: '+JSON.stringify(r));})]);signal.abort();
  const cancelled=await active;assert.equal(cancelled.structuredContent.error.kind,'AbortError');
  assert.equal(mutations,1);
  const unaffected=body(await runtime.call('cortex_peek',{sessionId:b}));
  assert.equal(unaffected.heading,'Lifecycle');
  body(await runtime.call('cortex_open',{sessionId:a,url:origin}));
  body(await runtime.call('cortex_run',{sessionId:a,steps:[{op:'expect_text',target:'p',value:'pronto'}]}));
  let nextMutation;
  const next=new Promise(resolve=>{nextMutation=resolve;});marked=nextMutation;
  const closingRun=runtime.call('cortex_run',{sessionId:a,steps:[{op:'click',target:'role:button|Modifica'},{op:'expect_visible',target:'.never',timeout:30000}]});
  console.log('[CHECK] lifecycle close during active batch');
  await Promise.race([next,closingRun.then(r=>{throw Error('Run ended before second marker: '+JSON.stringify(r));})]);
  const close=runtime.close();assert.strictEqual(runtime.close(),close);
  await close;assert.equal((await closingRun).structuredContent.error.kind,'AbortError');
  assert.equal((await runtime.call('cortex_debug')).structuredContent.error.kind,'RuntimeClosed');
  assert.equal(mutations,2);
  console.log('[CHECK] lifecycle idle restart');
  // An idle browser is released, and a new invocation cannot recreate its old IDs.
  const idle=createCortexRuntime({config:{origins:[origin],artifacts:temp},idleTimeoutMs:25});
  try {
    const id=body(await idle.call('cortex_open',{url:origin,newSession:true})).sessionId;
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal((await idle.call('cortex_peek',{sessionId:id})).structuredContent.error.kind,'SessionClosed');
    body(await idle.call('cortex_open',{url:origin,newSession:true}));
  }finally {await idle.close();}
  console.log('[PASS] lifecycle: active cancellation no replay, other context intact, recovery, close during batch, idle restart');
}finally {
  await runtime.close();
  await new Promise(resolve=>fixture.close(resolve));
  assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));
  await fs.rm(temp,{recursive:true,force:true});
}
