// Server-only observation pilot. No model inference, token estimate or scientific efficacy claim.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCortexRuntime } from '../src/index.js';

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const iterations=Number(option('--iterations')??20),durationMs=Number(option('--soak-ms')??0),out=option('--out');
if(!Number.isInteger(iterations)||iterations<2||iterations>200||!Number.isFinite(durationMs)||durationMs<0||durationMs>3600000)throw Error('iterations 2..200; soak-ms 0..3600000');
const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<main><h1>Observation fixture</h1><label>Filtro<input></label><button>Ricerca</button></main>');});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+fixture.address().port;
const runtime=createCortexRuntime({config:{origins:[origin],toolProfile:'diagnostic'},idleTimeoutMs:0,env:{}});
const rows=[];let count=0;
try {
  const open=await runtime.call('cortex_open',{url:origin,newSession:true});if(open.isError)throw Error(JSON.stringify(open));const sessionId=open.structuredContent.sessionId;
  const start=performance.now();
  do {
    // Rotate order deterministically; this is a pilot, not randomized task-level evaluation.
    const modes=['structure','image','hybrid'];for(let n=0;n<3;n++){
      const mode=modes[(n+count)%3],before=performance.now();
      const response=await runtime.call('cortex_observe',{sessionId,mode});
      rows.push({iteration:count,mode,ok:!response.isError,ms:performance.now()-before,
        textBytes:Buffer.byteLength(JSON.stringify(response.structuredContent)),imageBytes:response.content.filter(c=>c.type==='image').reduce((sum,c)=>sum+Buffer.byteLength(c.data,'base64'),0),
        nodeRSS:process.memoryUsage().rss,managedHeap:process.memoryUsage().heapUsed});
    }
    count++;
  }while(durationMs?performance.now()-start<durationMs:count<iterations);
  const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
  const report={schemaVersion:1,at:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,
    protocol:'server-only-pilot-v1',inference:'not-run',tokenUsage:'unavailable',browserCPUAndRSS:'not-collected',warmup:'none-reported-as-pilot',
    scope:'one-synthetic-loopback-page',soakRequestedMs:durationMs,rows,
    summary:Object.fromEntries(['structure','image','hybrid'].map(mode=>{const r=rows.filter(r=>r.mode===mode);return [mode,{n:r.length,failures:r.filter(r=>!r.ok).length,p50Ms:quantile(r.map(r=>r.ms),.5),p95Ms:quantile(r.map(r=>r.ms),.95)}];}))};
  const json=JSON.stringify(report,null,2);if(out){const filename=path.resolve(out);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,json,{flag:'wx'});}else process.stdout.write(json+'\n');
} finally {await runtime.close();await new Promise(resolve=>fixture.close(resolve));}
