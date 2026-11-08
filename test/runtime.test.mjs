import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigResolver } from '../src/config/resolve.js';
import { createCortexRuntime } from '../src/index.js';
import { createPlaywrightProvider } from '../src/browser/playwright-provider.js';
import { captureScreenshot } from '../src/artifacts/screenshots.js';

test('config: project overrides bootstrap; ceiling, relative paths and filesystem roots',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-config-'));
  try {
    await fs.writeFile(path.join(root,'.env'),'CORTEX_ALLOWED_ORIGINS=https://allowed.test\nCORTEX_ARTIFACTS=shots\nCORTEX_HEADLESS=false\n');
    const env={CORTEX_ALLOWED_ORIGINS:'https://bootstrap.test'};
    const resolve=createConfigResolver({env,policy:{origins:['https://allowed.test'],projectRoots:[root],artifactRoots:[root]}});
    const config=await resolve(root);
    assert.deepEqual(config.origins,['https://allowed.test']);assert.equal(config.launch.headless,false);
    assert.equal(config.artifacts,path.join(root,'shots'));assert.equal(env.CORTEX_ALLOWED_ORIGINS,'https://bootstrap.test');
    await assert.rejects(resolve(),/project_path/);
    await assert.rejects(resolve(path.dirname(root)),/autorizzato/);
    await fs.writeFile(path.join(root,'.env'),'CORTEX_ALLOWED_ORIGINS=https://denied.test\n');
    await assert.rejects(resolve(root),/policy/);
    await assert.rejects(createConfigResolver({env:{CORTEX_ALLOWED_ORIGINS:'https://allowed.test',CORTEX_ARTIFACTS:'relative'}})(),/relativi/);
    const explicit=await createConfigResolver({env,config:{origins:['https://explicit.test'],artifacts:root}})(root);
    assert.deepEqual(explicit.origins,['https://explicit.test']);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('config: symlink cannot escape artifact policy',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-root-'));
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-outside-'));
  try {
    try {await fs.symlink(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');}
    catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('OS does not permit symlink creation');return;}throw error;}
    const resolve=createConfigResolver({config:{origins:['https://allowed.test'],artifacts:path.join(root,'link','new')},policy:{artifactRoots:[root]}});
    await assert.rejects(resolve(),/autorizzato/);
  } finally {await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
test('runtime: no provider launch for invalid tool/schema; close terminal and idempotent',{timeout:3000},async()=>{
  let launches=0,closes=0;
  const runtime=createCortexRuntime({env:{CORTEX_ALLOWED_ORIGINS:'https://allowed.test'},browserProvider:{
    getSession:async()=>{launches++;throw Error('must not launch');},selectPage(){},close:async()=>{closes++;}
  }});
  assert.equal(runtime.definitions.length,4);
  assert.equal((await runtime.call('browser_session')).structuredContent.error.kind,'UnknownTool');
  assert.equal((await runtime.call('cortex_open',{})).structuredContent.ok,false);assert.equal(launches,0);
  for(let index=0;index<5;index++)assert.equal((await runtime.call('cortex_open',{})).structuredContent.ok,false);
  const closing=runtime.close();assert.strictEqual(runtime.close(),closing);await closing;
  assert.equal(closes,1);assert.equal((await runtime.call('cortex_debug')).structuredContent.error.kind,'RuntimeClosed');
});
test('runtime: bounded FIFO, snapshot args, queued cancellation and no replay',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});let starts=0;
  const runtime=createCortexRuntime({config:{origins:['https://allowed.test']},maxPending:1,browserProvider:{
    getSession:async()=>{starts++;await held;throw Error('synthetic provider failure');},selectPage(){},close:async()=>{}
  }});
  try {
    const first=runtime.call('cortex_open',{url:'https://allowed.test'});
    // Let the first call reach the provider before enqueueing another.
    while(!starts)await new Promise(resolve=>setImmediate(resolve));
    const controller=new AbortController();
    const args={url:'https://allowed.test'};
    const queued=runtime.call('cortex_open',args,{signal:controller.signal});args.url='https://denied.test';
    assert.equal((await runtime.call('cortex_debug')).structuredContent.error.kind,'QueueFull');
    controller.abort();assert.equal((await queued).structuredContent.error.kind,'AbortError');
    release();await first;assert.equal(starts,1);
  }finally {release();await runtime.close();}
});
test('provider: launch fixed, sandbox on, lazy, ownership close',async()=>{
  let loaded=0,options,closed=0;
  const page={isClosed:()=>false,once(){}};
  const context={on(){},pages:()=>[page]};
  const browser={isConnected:()=>true,newContext:async()=>context,close:async()=>{closed++;}};
  const provider=createPlaywrightProvider({loadChromium:async()=>{loaded++;return {launch:async opts=>{options=opts;return browser;}};}});
  assert.equal(loaded,0);
  await provider.getSession({headless:true,proxy:{server:'http://localhost:1'}});
  assert.equal(loaded,1);assert.equal(options.chromiumSandbox,true);assert.equal(options.args,undefined);
  assert.throws(()=>provider.assertLaunch({headless:false}),/diversa/);
  await provider.close();assert.equal(closed,1);
});
test('artifact: exclusive PNG file, no overwrites or leaked partial output',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cortex-shot-'));
  try {
    const filename=path.join(root,'shot.png');
    await captureScreenshot({screenshot:async()=>Buffer.from('PNG')},filename);
    assert.equal(await fs.readFile(filename,'utf8'),'PNG');
    await assert.rejects(captureScreenshot({screenshot:async()=>Buffer.from('overwrite')},filename));
    assert.equal(await fs.readFile(filename,'utf8'),'PNG');
    const failed=path.join(root,'failed.png');
    await assert.rejects(captureScreenshot({screenshot:async()=>{throw Error('secret');}},failed),/non disponibile/);
    await assert.rejects(fs.access(failed));
  }finally {await fs.rm(root,{recursive:true,force:true});}
});
