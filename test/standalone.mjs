import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-independent-'));
const npmCli=process.env.npm_execpath;
if(!npmCli)throw Error('Run through npm run test:verify or npm run test:standalone.');
async function command(args,cwd) {
  let stdout='',stderr='';
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[npmCli,...args],{cwd,windowsHide:true,env:{...process.env,NODE_PATH:''}});
    child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
    child.once('error',reject);child.once('exit',resolve);
  });
  assert.equal(code,0,stderr);return stdout;
}
let app;
const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<main><label>Nome<input></label><button onclick="document.querySelector(\'p\').textContent=\'fatto\'">Esegui</button><p>pronto</p></main>');});
try {
  const packed=JSON.parse(await command(['pack','--ignore-scripts','--json','--pack-destination',temp],root));
  const shipped=packed[0].files.map(file=>file.path);
  assert.ok(shipped.includes('bin/cortex.mjs'));
  assert.ok(shipped.includes('LICENSE'));
  assert.ok(shipped.includes('docs/configuration.md'));
  assert.ok(shipped.includes('src/artifacts/screenshots.js'));
  for(const filename of shipped){
    assert.doesNotMatch(filename,/^(?:artifacts|profiles|test|node_modules)\//);
    assert.doesNotMatch(filename,/(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$)|^docs\/(?:analisi-|implementation-report|evolution-results|review-fixes|positioning|release-review)/);
  }
  const destination=path.join(temp,'consumer');await fs.mkdir(destination);
  await command(['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false','--prefix',destination,path.join(temp,packed[0].filename)],temp);
  const packageRoot=path.join(destination,'node_modules','cortex-browser-mcp');
  // Physically copied package, launched from an unrelated cwd and without NODE_PATH.
  const files=await fs.readdir(path.join(packageRoot,'src'),{recursive:true});
  for(const relative of files) {
    const filename=path.join(packageRoot,'src',relative);
    if(!(await fs.stat(filename)).isFile())continue;
    const text=await fs.readFile(filename,'utf8');
    assert.doesNotMatch(text,/[A-Z]:[\\/]+mcp-servers|\.{2}[\\/].*mcp-servers|from ['"].*sophia/i);
  }
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+fixture.address().port;
  // Load the SDK from the installed consumer, not from the original repository.
  const {Client}=await import(pathToFileURL(path.join(destination,'node_modules','@modelcontextprotocol/sdk/dist/esm/client/index.js')));
  const {StdioClientTransport}=await import(pathToFileURL(path.join(destination,'node_modules','@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&!/SOPHIA|CORTEX|BROWSER_|ALLOWED_|NODE_PATH/.test(key)));
  const browserCache=process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform==='win32'?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'ms-playwright'):process.platform==='darwin'?path.join(os.homedir(),'Library','Caches','ms-playwright'):path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'),'ms-playwright'));
  const permissionArgs=['--permission','--allow-fs-read='+temp,'--allow-fs-read='+browserCache,'--allow-fs-write='+temp,'--allow-child-process'];
  // Prove source is inaccessible to the Node process, without changing either checkout.
  const probe=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[...permissionArgs,'-e',"try { require('node:fs').readFileSync(process.argv[1]); process.exit(2); } catch(e) { process.exit(e.code==='ERR_ACCESS_DENIED'?0:3); }",path.join(root,'package.json')],{cwd:temp,stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('exit',resolve);});
  assert.equal(probe,0,'source checkout must be inaccessible');
  const transport=new StdioClientTransport({command:process.execPath,args:[...permissionArgs,path.join(packageRoot,'bin','cortex.mjs')],cwd:temp,env:{...env,CORTEX_ALLOWED_ORIGINS:origin,CORTEX_ARTIFACTS:path.join(temp,'artifacts'),PLAYWRIGHT_BROWSERS_PATH:browserCache,TEMP:temp,TMP:temp,TMPDIR:temp,NODE_PATH:''},stderr:'pipe'});
  const client=new Client({name:'independent-consumer',version:'1.0.0'});
  await client.connect(transport);app={client,transport};
  assert.equal((await client.listTools()).tools.length,4);
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r));return r.structuredContent;};
  const open=await call('cortex_open',{url:origin,newSession:true});
  const sessionId=open.sessionId;assert.ok(sessionId);
  assert.equal((await call('cortex_peek',{sessionId,query:'Nome'})).controls[0].name,'Nome');
  const run=await call('cortex_run',{sessionId,steps:[{op:'fill',target:'label:Nome',value:'Cortex'},{op:'click',target:'role:button|Esegui'},{op:'expect_text',target:'p',value:'fatto'}]});
  assert.equal(run.completed,3);
  const debug=await call('cortex_debug',{sessionId,screenshot:true});assert.ok((await fs.stat(debug.screenshotLocal)).size>0);
  await call('cortex_debug',{sessionId,closeSession:true});
  await client.close();app=null;
  console.log('[PASS] packed Cortex consumer: isolated install, SDK client, open/peek/run/debug/close, unrelated cwd, filesystem permissions deny original checkout, no Sophia imports');
} finally {
  await app?.client.close().catch(()=>{});
  await new Promise(resolve=>fixture.close(resolve));
  await fs.rm(temp,{recursive:true,force:true});
}
