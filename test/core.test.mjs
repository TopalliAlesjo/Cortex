import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createCortexProxy } from '../src/core/cortex-proxy.js';
import { createCortex, createCortexEngine } from '../src/core/cortex.js';
import { permitted, sensitive, result } from '../src/core/cortex-utils.js';
test('origin esatto, niente sottodomini o protocolli alternativi',()=>{
 const o=['http://localhost:8080','https://dev.test'];
 assert.equal(permitted('https://dev.test/users',o),true);
 assert.equal(permitted('https://dev.test.evil.net/',o),false);
 assert.equal(permitted('http://dev.test/',o),false);
 assert.equal(permitted('file:///etc/passwd',o),false);
});
test('guardia operazioni sensibili',()=>{
 assert.equal(sensitive('Elimina utente'),true);
 assert.equal(sensitive('Invia email'),true);
 assert.equal(sensitive('Salva'),false);
});
test('output minimo',()=>assert.equal(result({ok:true}).content[0].text,'{"ok":true}'));

test('proxy startup: errore recuperabile, suspend e close senza rejection o risorse residue',async()=>{
 const previous=process.env.CORTEX_ALLOWED_ORIGINS;process.env.CORTEX_ALLOWED_ORIGINS='https://allowed.test';
 let attempts=0,sessionCalls=0,closed=0,failNextClose=false;
 const engine=createCortexEngine({
  proxyFactory:async()=>{if(++attempts===1)throw new Error('token=fixture-private-failure');return {proxy:{server:'http://fake-proxy'},setPolicy:()=>{},close:async()=>{closed++;if(failNextClose){failNextClose=false;throw new Error('fixture close failed');}}};},
  getSession:async()=>{sessionCalls++;throw new Error('fixture browser unavailable');},selectPage:()=>{},screenshotPath:()=>'',captureScreenshot:async()=>{}
 });
 try {
  const first=await engine.call('cortex_open',{url:'https://allowed.test'});
  assert.equal(first.isError,true);assert.equal(attempts,1);assert.equal(sessionCalls,0);assert.doesNotMatch(JSON.stringify(first),/fixture-private-failure/);
  await engine.suspend();await engine.close();assert.equal(closed,0);
  await engine.call('cortex_open',{url:'https://allowed.test'});assert.equal(attempts,2);assert.equal(sessionCalls,1);
  await engine.suspend();failNextClose=true;await assert.rejects(engine.close(),/fixture close failed/);
  await engine.close();await engine.close();assert.equal(closed,2);
  await engine.call('cortex_open',{url:'https://allowed.test'});assert.equal(attempts,3);
 } finally {await engine.close();if(previous===undefined)delete process.env.CORTEX_ALLOWED_ORIGINS;else process.env.CORTEX_ALLOWED_ORIGINS=previous;}
 assert.equal(closed,3);
});

test('policy CDP: attach/enable falliti possono essere riprovati e rilasciano le risorse',async()=>{
 const {EventEmitter}=await import('node:events');
 const previous=process.env.CORTEX_ALLOWED_ORIGINS;process.env.CORTEX_ALLOWED_ORIGINS='https://allowed.test';
 let attachments=0,detached=0;
 const context=new EventEmitter(),page=new EventEmitter();
 page.context=()=>context;page.url=()=> 'https://allowed.test';page.isClosed=()=>false;
 context.pages=()=>[page];context.route=async()=>{};
 context.newCDPSession=async()=>{
  attachments++;
  if(attachments===1)throw new Error('fixture attach failed');
  const cdp=new EventEmitter();cdp.detach=async()=>{detached++;};
  cdp.send=async()=>{if(attachments===2)throw new Error('fixture enable failed');};return cdp;
 };
 const engine=createCortexEngine({proxyFactory:async()=>({proxy:{server:'http://fake-proxy'},setPolicy:()=>{},close:async()=>{}}),getSession:async()=>({context,page,cortexProxy:true,target:'launch'}),selectPage:()=>{},screenshotPath:()=>'',captureScreenshot:async()=>{}});
 try {
  assert.equal((await engine.call('cortex_debug')).isError,true);
  assert.equal((await engine.call('cortex_debug')).isError,true);assert.equal(detached,1);
  assert.equal((await engine.call('cortex_debug')).structuredContent.ok,true);assert.equal(attachments,3);
  assert.equal(page.listenerCount('close'),1);page.emit('close');await Promise.resolve();assert.equal(detached,2);
 } finally {await engine.close();if(previous===undefined)delete process.env.CORTEX_ALLOWED_ORIGINS;else process.env.CORTEX_ALLOWED_ORIGINS=previous;}
});

test('validazione piani identica con o senza sessionId, prima del browser',async()=>{
 let starts=0;
 const broker=createCortex({getSession:async()=>{starts++;throw new Error('must not start');},selectPage:()=>{},screenshotPath:()=>'',captureScreenshot:async()=>{}});
 const args={steps:[{op:'fill',target:'#name',value:'safe'},{op:'extract',target:'tbody tr',fields:[{name:'text',maxLength:4000}]}]};
 try {
  const plain=(await broker.call('cortex_run',args)).structuredContent;
  const isolated=(await broker.call('cortex_run',{...args,sessionId:'unknown-valid-id'})).structuredContent;
  for(const data of [plain,isolated]) {assert.equal(data.phase,'validation');assert.equal(data.completed,0);assert.equal(data.failedAt,2);assert.match(data.error.message,/arguments\.steps\[1\]\.fields\[0\]\.maxLength \(1\.\.500\)/);}
  assert.deepEqual(isolated.error,plain.error);assert.equal(starts,0);
 } finally {await broker.close();}
});

test('proxy: revoca stream HTTP e handshake pendenti preservando origin autorizzati',{timeout:10000},async()=>{
 const http=await import('node:http');
 const {once}=await import('node:events');
 const backends=[],clients=[];
 const deadline=(promise)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('HTTP stream revocation timeout')),3000);promise.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});
 async function backend() {
  const sockets=new Set(),peers=new Map();let seen=0,notify;
  const requests=[];
  const server=http.createServer((request,response)=>{
   seen++;const closed=new Promise(resolve=>response.once('close',resolve));peers.set(request.url,{response,closed});
   const index=requests.indexOf(request.url);if(index>=0){requests.splice(index,1);notify?.();}
   if(request.url!=='/pending'){response.writeHead(200,{'Content-Type':'text/plain'});response.write('ready');}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const data={origin:`http://127.0.0.1:${server.address().port}`,peers,get seen(){return seen;},
   waitRequest:url=>peers.has(url)?Promise.resolve():deadline(new Promise(resolve=>{requests.push(url);notify=resolve;})),
   close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
  backends.push(data);return data;
 }
 const first=await backend(),second=await backend(),proxy=await createCortexProxy();let proxyClosed=false;
 async function stream(origin,url='/stream',headers=true) {
  const entry={request:http.get(proxy.proxy.server,{path:`${origin}${url}`,headers:{Connection:'close'}})};
  clients.push(entry);entry.request.on('error',()=>{});
  entry.closed=new Promise(resolve=>entry.request.once('close',resolve));
  if(headers) {
   entry.response=await deadline(once(entry.request,'response').then(([response])=>response));entry.response.on('error',()=>{});entry.response.resume();
  }
  await (origin===first.origin?first:second).waitRequest(url);return entry;
 }
 try {
  proxy.setPolicy(true,[first.origin,second.origin]);
  const denied=await stream(first.origin),retained=await stream(second.origin);
  proxy.setPolicy(true,[second.origin]);
  await deadline(Promise.all([denied.closed,first.peers.get('/stream').closed]));
  assert.equal(retained.request.destroyed,false);
  proxy.setPolicy(false);
  const pending=await stream(first.origin,'/pending',false);
  proxy.setPolicy(true,[second.origin]);
  await deadline(Promise.all([pending.closed,first.peers.get('/pending').closed]));
  const seenBefore=first.seen;
  const deniedNew=http.get(proxy.proxy.server,{path:`${first.origin}/blocked`,headers:{Connection:'close'}});
  const [response]=await deadline(once(deniedNew,'response'));response.resume();assert.equal(response.statusCode,403);assert.equal(first.seen,seenBefore);
  await proxy.close();proxyClosed=true;await deadline(Promise.all([retained.closed,second.peers.get('/stream').closed]));
 } finally {for(const client of clients)client.request.destroy();if(!proxyClosed)await proxy.close();await Promise.all(backends.map(item=>item.close()));}
});

test('proxy: CONNECT opaco autorizzato, CONNECT e HTTP esclusi prima della rete',async()=>{
 let connections=0;
 const backend=net.createServer(socket=>{connections++;let received=Buffer.alloc(0);socket.on('data',bytes=>{received=Buffer.concat([received,bytes]);if(received.length>=5) socket.end(Buffer.concat([Buffer.from('TUNNEL_OK:'),received]));});});
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const port=backend.address().port;
 const proxy=await createCortexProxy();proxy.setPolicy(true,[`https://127.0.0.1:${port}`]);
 const proxyPort=Number(new URL(proxy.proxy.server).port);
 function exchange(request,payload) {
  return new Promise((resolve,reject)=>{
   const socket=net.connect({host:'127.0.0.1',port:proxyPort});let buffer=Buffer.alloc(0),sent=false;
   const timer=setTimeout(()=>{socket.destroy();reject(new Error('Proxy test timeout'));},5000);
   const finish=()=>{clearTimeout(timer);socket.destroy();resolve(buffer);};
   socket.once('connect',()=>socket.write(request));socket.on('error',error=>{clearTimeout(timer);reject(error);});
   socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.includes(Buffer.from('403 Forbidden')) || payload && buffer.includes(Buffer.concat([Buffer.from('TUNNEL_OK:'),payload]))) finish();
    else if(payload && !sent && buffer.includes(Buffer.from('\r\n\r\n'))) {sent=true;socket.write(payload);}
   });
  });
 }
 try {
  const payload=Buffer.from([0x16,0x03,0x01,0x41,0x42]);
  const response=await exchange(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,payload);
  assert.ok(response.includes(Buffer.from('200 Connection Established')));assert.ok(response.includes(payload));
  const blocked=await exchange(`CONNECT 127.0.0.1:${port+1} HTTP/1.1\r\nHost: 127.0.0.1:${port+1}\r\n\r\n`);
  assert.ok(blocked.includes(Buffer.from('403 Forbidden')));
  const httpBlocked=await exchange(`GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  assert.ok(httpBlocked.includes(Buffer.from('403 Forbidden')));assert.equal(connections,1);
 } finally {await proxy.close();await new Promise(resolve=>backend.close(resolve));}
});

test('proxy: Upgrade 101 revocato dalla policy, cleanup e handshake pendente',async()=>{
 const http=await import('node:http');
 const deadline=(promise,label)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`Upgrade test timeout: ${label}`)),5000);
  promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
 });
 async function upgradeBackend() {
  const sockets=new Set(),peers=new Map();let upgrades=0;
  const server=http.createServer((request,response)=>response.writeHead(404).end());
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
  server.on('upgrade',(request,socket,head)=>{
   upgrades++;
   peers.set(request.url,{socket,closed:new Promise(resolve=>socket.once('close',resolve))});
   // HTTP Upgrade removes Node's normal end handler and leaves allowHalfOpen
   // enabled. Complete the backend side on FIN, including paused handshakes.
   socket.once('end',()=>socket.end());
   if(request.url==='/pending') {socket.resume();return;}
   socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
   if(head.length) socket.write(head);
   socket.on('data',bytes=>socket.write(bytes));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {
   origin:`http://127.0.0.1:${server.address().port}`,peers,get upgrades(){return upgrades;},
   pending:()=>deadline(new Promise(resolve=>{
    const listener=request=>{if(request.url==='/pending') {server.removeListener('upgrade',listener);resolve(peers.get('/pending'));}};
    server.on('upgrade',listener);
   }),'upstream pending handshake'),
   close:async()=>{for(const socket of sockets) socket.destroy();await new Promise(resolve=>server.close(resolve));}
  };
 }
 const first=await upgradeBackend(),second=await upgradeBackend();
 const proxy=await createCortexProxy();let proxyClosed=false;
 const proxyPort=Number(new URL(proxy.proxy.server).port),clients=new Set();
 function rawUpgrade(origin,path) {
  const socket=net.connect({host:'127.0.0.1',port:proxyPort});clients.add(socket);
  const client={socket,bytes:Buffer.alloc(0),closed:new Promise(resolve=>socket.once('close',resolve))};
  socket.on('data',bytes=>{client.bytes=Buffer.concat([client.bytes,bytes]);});
  socket.on('error',()=>{});socket.once('close',()=>clients.delete(socket));
  socket.once('connect',()=>socket.write(`GET ${origin}${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
  return client;
 }
 function received(client,value) {
  const bytes=Buffer.from(value);
  if(client.bytes.includes(bytes)) return Promise.resolve();
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);client.socket.removeListener('data',check);client.socket.removeListener('close',closed);};
   const check=()=>{if(client.bytes.includes(bytes)) {cleanup();resolve();}};
   const closed=()=>{cleanup();reject(new Error(`Upgrade closed before receiving: ${value}`));};
   const timer=setTimeout(()=>{cleanup();reject(new Error(`Upgrade data timeout: ${value}`));},5000);
   client.socket.on('data',check);client.socket.once('close',closed);
  });
 }
 async function rawUpgrade101(origin,path) {
  const client=rawUpgrade(origin,path);
  await received(client,'HTTP/1.1 101 Switching Protocols\r\n');
  return client;
 }
 try {
  const revoked=await rawUpgrade101(first.origin,'/revoked');
  const retained=await rawUpgrade101(second.origin,'/retained');
  revoked.socket.write('before-policy');await received(revoked,'before-policy');
  proxy.setPolicy(true,[second.origin]);
  await deadline(Promise.all([revoked.closed,first.peers.get('/revoked').closed]),'policy revocation closes both sides');
  assert.equal(revoked.socket.destroyed,true);
  assert.equal(retained.socket.destroyed,false);
  retained.socket.write('after-policy');await received(retained,'after-policy');
  const denied=rawUpgrade(first.origin,'/denied');
  await deadline(denied.closed,'disallowed new Upgrade');
  assert.equal(first.upgrades,1);

  const clientClosed=await rawUpgrade101(second.origin,'/client-close');
  clientClosed.socket.destroy();
  await deadline(second.peers.get('/client-close').closed,'client closure closes upstream');
  const upstreamClosed=await rawUpgrade101(second.origin,'/upstream-close');
  second.peers.get('/upstream-close').socket.destroy();
  await deadline(upstreamClosed.closed,'upstream closure closes client');

  proxy.setPolicy(false);
  const pendingSeen=first.pending(),pending=rawUpgrade(first.origin,'/pending'),pendingPeer=await pendingSeen;
  proxy.setPolicy(true,[second.origin]);
  await deadline(Promise.all([pending.closed,pendingPeer.closed]),'policy revocation during handshake');
  assert.equal(pending.bytes.length,0);

  const shutdownSeen=second.pending(),shutdownPending=rawUpgrade(second.origin,'/pending'),shutdownPeer=await shutdownSeen;
  await deadline(proxy.close(),'proxy shutdown');proxyClosed=true;
  await deadline(Promise.all([retained.closed,second.peers.get('/retained').closed,shutdownPending.closed,shutdownPeer.closed]),'shutdown closes active and pending upgrades');
 } finally {
  for(const socket of clients) socket.destroy();
  await Promise.all([...(proxyClosed?[]:[deadline(proxy.close(),'proxy cleanup')]),first.close(),second.close()]);
 }
});

// Append to tests/smoke/playwright-node-cortex-utils.smoke.mjs.
// Reuses the existing node:test, assert and result imports; no real browser/network.
import { EventEmitter as SessionBrokerEventEmitter } from 'node:events';
import sessionBrokerPath from 'node:path';
import { createCortexSessionBroker } from '../src/core/cortex-sessions.js';

class SessionBrokerFakePage extends SessionBrokerEventEmitter {
 constructor(context,id) {super();this.contextRef=context;this.id=id;this.closed=false;this.address='about:blank';}
 context() {return this.contextRef;}
 isClosed() {return this.closed;}
 url() {return this.address;}
 async goto(url) {assert.equal(this.closed,false);this.address=url;}
 async close() {if(this.closed)return;this.closed=true;this.emit('close');}
}

class SessionBrokerFakeContext extends SessionBrokerEventEmitter {
 constructor(browser,options) {super();this.browserRef=browser;this.options=options;this.allPages=[];this.closed=false;this.closeCalls=0;this.cookies=new Map();}
 browser() {return this.browserRef;}
 isClosed() {return this.closed;}
 pages() {return this.allPages.filter(page=>!page.isClosed());}
 addPage() {const page=new SessionBrokerFakePage(this,`page-${this.browserRef.nextPage++}`);this.allPages.push(page);this.emit('page',page);return page;}
 async newPage() {assert.equal(this.closed,false);return this.addPage();}
 async close() {if(this.closed)return;this.closeCalls++;this.closed=true;for(const page of this.pages())await page.close();this.emit('close');}
}

class SessionBrokerFakeBrowser extends SessionBrokerEventEmitter {
 constructor() {super();this.connected=true;this.contexts=[];this.nextPage=1;}
 isConnected() {return this.connected;}
 async newContext(options) {assert.equal(this.connected,true);const context=new SessionBrokerFakeContext(this,options);this.contexts.push(context);return context;}
 async close() {if(!this.connected)return;this.connected=false;for(const context of this.contexts)await context.close();this.emit('disconnected');}
}

function sessionBrokerDefinitions() {
 const string={type:'string',maxLength:4096}, boolean={type:'boolean'};
 const schema=properties=>({type:'object',additionalProperties:false,properties:{...properties,project_path:{...string}}});
 return [
  {name:'cortex_open',inputSchema:{...schema({url:{...string},observe:{...boolean}}),required:['url']}},
  {name:'cortex_peek',inputSchema:schema({query:{...string}})},
  {name:'cortex_run',inputSchema:{...schema({steps:{type:'array',minItems:1,maxItems:25,items:{type:'object',additionalProperties:false,required:['op'],properties:{op:{type:'string'},target:{type:'string'},value:{type:'string'}}}}}),required:['steps']}},
  {name:'cortex_debug',inputSchema:schema({screenshot:{...boolean}})}
 ];
}

function sessionBrokerHarness(limits={}) {
 const state={engines:[],hostRequests:[],rootSelectCalls:[],browsers:[],events:[],definitions:sessionBrokerDefinitions(),onCall:null};
 const newRoot=()=>{
  const browser=new SessionBrokerFakeBrowser(),context=new SessionBrokerFakeContext(browser,{legacyRoot:true});
  browser.contexts.push(context);
  state.root={browser,context,page:context.addPage(),cortexProxy:true,target:'legacy:root'};
  state.browsers.push(browser);
 };
 newRoot();
 const createEngine=options=>{
  const index=state.engines.length;
  const engine={index,options,definitions:state.definitions,calls:[],prepareArgs:[],issuedProxies:[],proxy:null,closeCalls:0,suspendCalls:0,lastSession:null,
   has:name=>state.definitions.some(definition=>definition.name===name),
   launch() {
    if(!this.proxy) {this.proxy={server:`http://fake-proxy-${index}-${this.issuedProxies.length}`};this.issuedProxies.push(this.proxy);}
    return {proxy:this.proxy,profileDir:sessionBrokerPath.resolve('fake-root-profile'),serviceWorkers:'block'};
   },
   async prepare(args) {
    this.prepareArgs.push(structuredClone(args));
    assert.equal(new URL(args.url).origin,'https://allowed.test');
    this.lastSession=await options.getSession(this.launch());return this.lastSession;
   },
   async call(name,args) {
    for(const key of ['sessionId','newSession','closeSession'])assert.equal(Object.hasOwn(args,key),false,`engine received broker-only key ${key}`);
    this.calls.push({name,args:structuredClone(args)});
    this.lastSession=await options.getSession(this.launch());
    const override=await state.onCall?.({engine:this,name,args,session:this.lastSession});
    if(override!==undefined)return override;
    if(name==='cortex_open')await this.lastSession.page.goto(args.url);
    return result({ok:true,engine:index,page:this.lastSession.page.id,target:this.lastSession.target,url:this.lastSession.page.url(),project_path:args.project_path??null});
   },
   suspend() {this.suspendCalls++;state.events.push(`suspend:${index}`);},
   async close() {this.closeCalls++;this.proxy=null;state.events.push(`close:${index}`);}
  };
  state.engines.push(engine);return engine;
 };
 state.definitionsSnapshot=JSON.stringify(state.definitions);
 state.broker=createCortexSessionBroker({
  getSession:async launch=>{
   state.hostRequests.push(launch);
   if(!state.root.browser.isConnected())newRoot();
   return {...state.root};
  },
  selectPage:(target,page)=>{state.rootSelectCalls.push({target,page});state.root.page=page;},
  screenshotPath:()=>{throw new Error('Fake engine must not capture screenshots');},
  captureScreenshot:()=>{throw new Error('Fake engine must not capture screenshots');}
 },createEngine,limits);
 return state;
}

const sessionBrokerBody=response=>response.structuredContent;
const sessionBrokerOpen=(broker,extra={})=>broker.call('cortex_open',{url:'https://allowed.test/start',newSession:true,...extra});
const sessionBrokerDeferred=()=>{
 let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};
};

test('session broker: ID, cookie/proxy isolation, default and popup ownership',async()=>{
 const state=sessionBrokerHarness();
 try {
  const baseSchema=state.definitionsSnapshot,rootPage=state.root.page;
  const defaultOpen=sessionBrokerBody(await state.broker.call('cortex_open',{url:'https://allowed.test/default'}));
  assert.equal(defaultOpen.engine,0);assert.equal(defaultOpen.sessionId,undefined);
  const first=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  const second=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  assert.equal(first.ok,true);assert.equal(first.isolated,true);assert.ok(first.sessionId);
  assert.notEqual(first.sessionId,second.sessionId);
  assert.equal(JSON.stringify(state.definitions),baseSchema,'base engine definitions must not be mutated');
  assert.notStrictEqual(state.broker.definitions,state.definitions);
  for(const definition of state.broker.definitions)assert.equal(definition.inputSchema.properties.sessionId.type,'string');
  assert.equal(state.broker.definitions.find(definition=>definition.name==='cortex_open').inputSchema.properties.newSession.type,'boolean');
  assert.equal(state.broker.definitions.find(definition=>definition.name==='cortex_debug').inputSchema.properties.closeSession.type,'boolean');
  assert.equal(state.engines[0].prepareArgs.length,0,'an already known host must not be relaunched');
  const firstEngine=state.engines[1],secondEngine=state.engines[2];
  const firstContext=firstEngine.lastSession.context,secondContext=secondEngine.lastSession.context;
  assert.notStrictEqual(firstContext,secondContext);assert.notStrictEqual(firstContext,state.root.context);
  firstContext.cookies.set('login','first-user');
  assert.equal(secondContext.cookies.has('login'),false);assert.equal(state.root.context.cookies.has('login'),false);
  for(const engine of [firstEngine,secondEngine]) {
   assert.equal(engine.lastSession.context.options.serviceWorkers,'block');
   assert.strictEqual(engine.lastSession.context.options.proxy,engine.issuedProxies[0]);
   assert.equal(Object.hasOwn(engine.lastSession.context.options,'profileDir'),false);
  }
  assert.notStrictEqual(firstContext.options.proxy,secondContext.options.proxy);
  assert.notStrictEqual(firstContext.options.proxy,state.hostRequests[0].proxy);
  assert.equal((await state.broker.call('cortex_peek',{sessionId:first.sessionId})).structuredContent.engine,1);
  assert.equal((await state.broker.call('cortex_run',{sessionId:second.sessionId,steps:[{op:'wait',target:'#ready'}]})).structuredContent.engine,2);
  assert.equal((await state.broker.call('cortex_debug',{sessionId:first.sessionId})).structuredContent.sessionId,first.sessionId);
  assert.equal((await state.broker.call('cortex_debug',{})).structuredContent.engine,0);
  const popup=await firstContext.newPage();
  firstEngine.options.selectPage(`cortex:${first.sessionId}`,popup);
  assert.equal(sessionBrokerBody(await state.broker.call('cortex_debug',{sessionId:first.sessionId})).page,popup.id);
  const thirdPage=await firstContext.newPage(),overflow=await firstContext.newPage();
  assert.equal(overflow.isClosed(),true);assert.equal(firstContext.pages().length,3);
  firstEngine.options.selectPage(`cortex:${first.sessionId}`,overflow);
  assert.equal(sessionBrokerBody(await state.broker.call('cortex_debug',{sessionId:first.sessionId})).page,popup.id);
  await popup.close();
  assert.equal(sessionBrokerBody(await state.broker.call('cortex_debug',{sessionId:first.sessionId})).page,thirdPage.id);
  for(const page of firstContext.pages())await page.close();
  const restored=sessionBrokerBody(await state.broker.call('cortex_debug',{sessionId:first.sessionId}));
  assert.equal(restored.ok,true);assert.equal(firstContext.pages().length,1);
  assert.strictEqual(firstEngine.lastSession.context,firstContext,'closing tabs must not replace the context');
  assert.strictEqual(state.root.page,rootPage);assert.equal(state.root.page.url(),'https://allowed.test/default');
  assert.equal(state.rootSelectCalls.length,0,'child popup selection must never reach legacy state');
 } finally {await state.broker.close();}
});

test('session broker: invalid flags have no effects, cap and exact idle TTL use the injected clock',async()=>{
 let clock=0;const state=sessionBrokerHarness({now:()=>clock,maxSessions:2,ttlMs:100});
 try {
  for(const [name,args] of [
   ['cortex_peek',{newSession:true}],
   ['cortex_open',{url:'https://allowed.test/',closeSession:true}],
   ['cortex_debug',{closeSession:true}],
   ['cortex_open',{url:'https://allowed.test/',newSession:true,sessionId:'unknown'}],
   ['cortex_open',{url:'https://allowed.test/',newSession:'true'}],
   ['cortex_debug',{sessionId:''}]
  ])assert.equal((await state.broker.call(name,args)).isError,true);
  assert.equal(state.hostRequests.length,0);assert.equal(state.engines.length,1);
  const first=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  assert.equal(state.engines[0].prepareArgs.length,1);
  assert.strictEqual(state.hostRequests[0].proxy,state.engines[0].issuedProxies[0]);
  assert.notStrictEqual(state.hostRequests[0].proxy,state.engines[1].lastSession.context.options.proxy);
  assert.equal(state.root.page.url(),'about:blank','preparing the host must not navigate its page');
  clock=10;const second=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  clock=20;const capped=await sessionBrokerOpen(state.broker);
  assert.equal(capped.isError,true);assert.match(sessionBrokerBody(capped).error.message,/Limite di 2/);
  assert.equal(state.engines.length,3);assert.equal(state.engines[1].lastSession.context.closed,false);
  clock=100;
  assert.equal((await sessionBrokerOpen(state.broker,{sessionId:first.sessionId})).isError,true);
  assert.equal(state.engines[1].lastSession.context.closed,false,'invalid combinations must not even expire old contexts');
  assert.equal((await state.broker.call('cortex_peek',{sessionId:second.sessionId})).structuredContent.ok,true);
  assert.equal(state.engines[1].lastSession.context.closed,true,'TTL expires exactly at its boundary');
  assert.equal(state.engines[1].closeCalls,1);assert.equal(state.engines[2].lastSession.context.closed,false);
  const third=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  assert.equal(third.ok,true);assert.notEqual(third.sessionId,first.sessionId);
  const engineCount=state.engines.length,hostCount=state.hostRequests.length;
  const stale=await state.broker.call('cortex_debug',{sessionId:first.sessionId});
  assert.equal(stale.isError,true);assert.equal(sessionBrokerBody(stale).error.kind,'SessionClosed');
  assert.equal(state.engines.length,engineCount);assert.equal(state.hostRequests.length,hostCount);
  clock=200;
  assert.equal((await state.broker.call('cortex_debug',{sessionId:second.sessionId})).structuredContent.error.kind,'SessionClosed');
  assert.equal(state.engines[2].lastSession.context.closed,true);assert.equal(state.engines[3].lastSession.context.closed,true);
 } finally {await state.broker.close();}
});

test('session broker: project binding is inherited and normalized with OS paths, default stays independent',async()=>{
 const state=sessionBrokerHarness(),projectA=sessionBrokerPath.resolve('session-broker-project-a'),projectB=sessionBrokerPath.resolve('session-broker-project-b');
 try {
  const first=sessionBrokerBody(await sessionBrokerOpen(state.broker,{project_path:projectA}));
  const engine=state.engines[1];
  await state.broker.call('cortex_open',{url:'https://allowed.test/default',project_path:projectB});
  assert.equal(sessionBrokerBody(await state.broker.call('cortex_peek',{sessionId:first.sessionId})).project_path,projectA);
  const equivalent=`${projectA}${sessionBrokerPath.sep}.`;
  assert.equal(sessionBrokerBody(await state.broker.call('cortex_debug',{sessionId:first.sessionId,project_path:equivalent})).ok,true);
  assert.equal(engine.calls.at(-1).args.project_path,projectA);
  const before=engine.calls.length;
  const changed=await state.broker.call('cortex_debug',{sessionId:first.sessionId,project_path:projectB});
  assert.equal(changed.isError,true);assert.match(sessionBrokerBody(changed).error.message,/project_path diverso/);
  assert.equal(engine.calls.length,before);assert.equal(engine.lastSession.context.closed,false);
  const closeChanged=await state.broker.call('cortex_debug',{sessionId:first.sessionId,project_path:projectB,closeSession:true});
  assert.equal(closeChanged.isError,true);assert.equal(engine.lastSession.context.closed,false);
  const unbound=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  assert.equal((await state.broker.call('cortex_peek',{sessionId:unbound.sessionId,project_path:projectA})).isError,true);
  assert.equal(state.engines[0].calls.at(-1).args.project_path,projectB);
  assert.equal(sessionBrokerBody(await state.broker.call('cortex_debug',{sessionId:first.sessionId,closeSession:true})).closed,true);
 } finally {await state.broker.close();}
});

test('session broker: failed creation cleans its slot, explicit/external close never recreates IDs, broker close can be reused',async()=>{
 const state=sessionBrokerHarness({maxSessions:1});
 try {
  state.onCall=({engine,name})=>{
   if(engine.index>0 && name==='cortex_open')throw new Error('token=DO_NOT_EXPOSE_THIS');
  };
  const failed=await sessionBrokerOpen(state.broker);
  assert.equal(failed.isError,true);assert.doesNotMatch(JSON.stringify(failed),/DO_NOT_EXPOSE_THIS/);
  assert.equal(state.engines[1].lastSession.context.closed,true);assert.equal(state.engines[1].closeCalls,1);
  assert.equal(state.root.context.closed,false);
  state.onCall=null;
  const first=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  assert.equal(first.ok,true,'failed creation must free the only available slot');
  const engine=state.engines[2],callsBefore=engine.calls.length,hostsBefore=state.hostRequests.length;
  const closed=sessionBrokerBody(await state.broker.call('cortex_debug',{sessionId:first.sessionId,closeSession:true,screenshot:true}));
  assert.deepEqual(closed,{ok:true,sessionId:first.sessionId,isolated:true,closed:true});
  assert.equal(engine.calls.length,callsBefore);assert.equal(state.hostRequests.length,hostsBefore);
  assert.equal((await state.broker.call('cortex_debug',{sessionId:first.sessionId})).structuredContent.error.kind,'SessionClosed');
  const external=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  const externalEngine=state.engines[3];await externalEngine.lastSession.context.close();
  const oldEngineCount=state.engines.length;
  assert.equal((await state.broker.call('cortex_debug',{sessionId:external.sessionId})).structuredContent.error.kind,'SessionClosed');
  assert.equal(state.engines.length,oldEngineCount);assert.equal(state.hostRequests.length,hostsBefore);
  const beforeHibernate=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  const oldBrowser=state.root.browser;
  // The framework closes its browser before the reusable broker cleanup.
  await oldBrowser.close();
  const firstClose=state.broker.close(),secondClose=state.broker.close();
  assert.strictEqual(firstClose,secondClose);await firstClose;
  assert.equal(state.engines[0].closeCalls,1);
  assert.equal((await state.broker.call('cortex_debug',{sessionId:beforeHibernate.sessionId})).structuredContent.error.kind,'SessionClosed');
  const reopened=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  assert.equal(reopened.ok,true);assert.notEqual(reopened.sessionId,beforeHibernate.sessionId);
  assert.notStrictEqual(state.root.browser,oldBrowser);assert.equal(state.engines[0].prepareArgs.length,2);
 } finally {await state.broker.close();}
});

test('session broker: Cortex and legacy share one queue; legacy suspends only the default inside its lock',{timeout:5000},async()=>{
 const state=sessionBrokerHarness(),cortexStarted=sessionBrokerDeferred(),cortexRelease=sessionBrokerDeferred(),legacyStarted=sessionBrokerDeferred(),legacyRelease=sessionBrokerDeferred();
 const pending=[];
 try {
  const child=sessionBrokerBody(await sessionBrokerOpen(state.broker));
  state.events.length=0;
  state.onCall=async({engine,name})=>{
   if(engine.index===0 && name==='cortex_open') {
    state.events.push('cortex:start');cortexStarted.resolve();await cortexRelease.promise;state.events.push('cortex:end');
   }
   if(engine.index===1 && name==='cortex_peek')state.events.push('child:peek');
  };
  pending.push(state.broker.call('cortex_open',{url:'https://allowed.test/held'}));
  await cortexStarted.promise;
  pending.push(state.broker.legacy(async()=>{
   state.events.push('legacy:start');legacyStarted.resolve();await legacyRelease.promise;state.events.push('legacy:end');return 'legacy-result';
  }));
  pending.push(state.broker.call('cortex_peek',{sessionId:child.sessionId}));
  await Promise.resolve();
  assert.deepEqual(state.events,['cortex:start']);assert.equal(state.engines[0].suspendCalls,0);
  cortexRelease.resolve();await legacyStarted.promise;
  assert.deepEqual(state.events,['cortex:start','cortex:end','suspend:0','legacy:start']);
  assert.equal(state.engines[0].suspendCalls,1);assert.equal(state.engines[1].suspendCalls,0);
  assert.equal(state.engines[1].calls.filter(call=>call.name==='cortex_peek').length,0);
  legacyRelease.resolve();const outcomes=await Promise.all(pending);
  assert.equal(outcomes[1],'legacy-result');assert.equal(sessionBrokerBody(outcomes[2]).engine,1);
  assert.deepEqual(state.events,['cortex:start','cortex:end','suspend:0','legacy:start','legacy:end','child:peek']);
 } finally {
  cortexRelease.resolve();legacyRelease.resolve();await Promise.allSettled(pending);await state.broker.close();
 }
});
