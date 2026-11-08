import http from 'node:http';
import assert from 'node:assert/strict';
import { createCortexRuntime } from '../src/index.js';

const fixture=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<main><button onclick="document.querySelector(\'p\').textContent=Number(document.querySelector(\'p\').textContent)+1">Esegui</button><p>0</p></main>');});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${fixture.address().port}`;
const runtime=createCortexRuntime({config:{origins:[origin],toolProfile:'diagnostic'},idleTimeoutMs:100,env:{}});
const call=async(name,args)=>{const response=await runtime.call(name,args);assert.equal(response.isError,undefined,JSON.stringify(response));return response.structuredContent;};
try {
  await call('cortex_open',{url:origin});
  const scoped=await call('cortex_observe',{target:'role:button|Esegui',mode:'hybrid'});assert.ok(scoped.data.snapshotId);assert.ok(scoped.data.bitmap);
  const plan={operationId:'survive-idle',steps:[{op:'click',target:'role:button|Esegui'}]};await call('cortex_run',plan);
  await new Promise(resolve=>setTimeout(resolve,400));
  await call('cortex_open',{url:origin});
  await call('cortex_run',plan);await call('cortex_run',{steps:[{op:'expect_text',target:'p',value:'0'}]});
  console.log('[PASS] Target role in hybrid e ledger root persistente dopo cleanup idle senza replay');
  await new Promise(resolve=>setTimeout(resolve,400));await runtime.close();
  const closed=await runtime.call('cortex_observe',{});assert.equal(closed.structuredContent.contractVersion,1);assert.equal(closed.structuredContent.error.kind,'RuntimeClosed');
  console.log('[PASS] Chiusura terminale dopo idle e schema errori v1');
}finally{await runtime.close();await new Promise(resolve=>fixture.close(resolve));}
