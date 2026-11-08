import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { cortexToolDefinitions } from '../src/core/cortex.js';
import { permitted, safeUrl, redact } from '../src/core/cortex-utils.js';

// All browser mutations are confined to HTTP fixtures on loopback.
const temp = await fs.mkdtemp(path.join(os.tmpdir(),'cortex-smoke-'));
let child, exited, stderr='', counter=0, blockedHits=0;
const pending=new Map();
const secret='fixture-secret-never-return';
const blocked=http.createServer((req,res)=>{blockedHits++;res.end('out of scope');});
await new Promise(resolve=>blocked.listen(0,'127.0.0.1',resolve));
const denied=`http://127.0.0.1:${blocked.address().port}`;
const fixture=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/redirect') {res.writeHead(302,{Location:`${denied}/secret`});res.end();return;}
  if(req.url==='/redirect-chain') {res.writeHead(302,{Location:'/redirect'});res.end();return;}
  if(req.url==='/redirect-allowed') {res.writeHead(302,{Location:'/popup'});res.end();return;}
  if(req.url==='/rows') {res.end('<tr><td>Mario Rossi</td><td><button>Dettaglio</button></td></tr>');return;}
  if(req.url==='/delayed-rows'||req.url==='/delayed-empty') {setTimeout(()=>res.end(req.url==='/delayed-rows'?'<tr><td class="file">async.pdf</td></tr>':''),180);return;}
  if(req.url==='/frame-popup') {res.end('<main><label>Nel frame<input id="frame-name"></label><a target="_blank" href="/popup">Apri popup frame</a></main>');return;}
  if(req.url==='/projection-slow') {res.end('<main><button>Lettura lenta</button></main><script>const native=document.querySelectorAll.bind(document);document.querySelectorAll=(...args)=>{document.querySelectorAll=native;const end=performance.now()+180;while(performance.now()<end){}return native(...args)};</script>');return;}
  if(req.url==='/hidden-busy') {res.end('<div aria-busy="true">Widget fuori main</div><main><h1>Pagina pronta</h1><div hidden aria-busy="true">Template</div><div role="dialog" hidden aria-busy="true">Modale chiusa</div><button>Disponibile</button></main>');return;}
  if(req.url==='/visible-busy') {res.end('<main aria-busy="true"><button>Caricamento in corso</button></main>');return;}
  if(req.url==='/hardening') {
    res.end(`<main><h1>Hardening</h1><div id="unique"><label>Filtro<input id="filter"></label><button id="replace-filter" onclick="document.getElementById('filter').outerHTML='<input id=filter aria-label=Filtro>'">Aggiorna filtro</button></div>
      <button id="root-control">Controllo root</button><p id="root-alert" role="alert">Avviso root</p>
      <table id="root-grid"><thead><tr><th>File</th></tr></thead><tbody><tr><td>root.pdf</td></tr></tbody></table>
      <div class="duplicate"><button>Solo uno</button></div><div class="duplicate"></div>
      <textarea aria-label="Note"></textarea><select aria-label="Multipla" multiple><option>Uno</option></select>
      <div class="async-section" id="async-full"><h3><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');const panel=this.closest('div').querySelector('.async-panel');panel.setAttribute('aria-busy','true');fetch('/delayed-rows').then(r=>r.text()).then(html=>{panel.querySelector('tbody').innerHTML=html;panel.setAttribute('aria-busy','false')})">Con file</button></h3><div class="async-panel"><table><tbody></tbody></table></div></div>
      <div class="async-section" id="async-empty"><h3><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');const panel=this.closest('div').querySelector('.async-panel');panel.setAttribute('aria-busy','true');fetch('/delayed-empty').then(r=>r.text()).then(html=>{panel.querySelector('tbody').innerHTML=html;panel.setAttribute('aria-busy','false')})">Senza file</button></h3><div class="async-panel"><table><tbody></tbody></table></div></div>
      <section class="removable"><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelectorAll('.removable')[1]?.remove()">Primo</button></section><section class="removable"><button aria-expanded="false">Secondo</button></section>
      <div class="clone-section"><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');const group=this.parentElement;group.setAttribute('aria-busy','true');fetch('/delayed-empty').then(()=>{const clone=group.cloneNode(true);clone.setAttribute('aria-busy','false');clone.querySelector('.file').textContent='wrong.pdf';group.replaceWith(clone)})">Sostituisce sezione</button><table><tbody><tr><td class="file">original.pdf</td></tr></tbody></table></div>
      <button id="self-vanish" aria-expanded="false" onclick="this.remove()">Scompare</button>
      <button id="deferred" onclick="fetch('/delayed-empty').then(()=>{document.getElementById('marker').textContent='pronto';location.href='/redirect-chain'})">Navigazione differita</button><p id="marker">attesa</p>
      <iframe id="frame" src="/frame-popup"></iframe></main>`);return;
  }
  if(req.url==='/session-probe') {res.end('<main><p id=state></p><script>document.getElementById("state").textContent=document.cookie?"present":"empty";</script></main>');return;}
  if(req.url==='/popup') {res.end('<h1>Popup locale</h1><button>Chiudi</button>');return;}
  if(req.url==='/row-actions') {
    const rows=['ATIS s.rl.','Altra societa'].map((company,index)=>`<tr ${index?'id="other-company"':''}><td>${company}</td><td>${['Visualizza','Modifica','Elimina','Documenti'].map((label,n)=>`<a style="display:inline-block;padding:4px" title="${label}" href="/row-${n}/${index}?token=${secret}#${secret}" onclick="event.preventDefault();document.getElementById('row-result').textContent='${label}'"><img width="24" height="24" alt="${label}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></a>`).join('')}</td></tr>`).join('');
    res.end(`<main><label>Societa<input id="row-search"></label><button id="row-filter" onclick="document.getElementById('search-count').value=Number(document.getElementById('search-count').value)+1;document.getElementById('other-company')?.remove()">Cerca societa</button><input id="search-count" value="0"><p id="row-result">Nessuna azione</p><table><tbody>${rows}</tbody></table><input type="password" value="${secret}"></main>`);return;
  }
  if(req.url==='/enterprise') {
    const groups=[1,1,1,1,2,0,1];
    res.end(`<main><h1>Documenti aziendali</h1>${groups.map((count,index)=>`<section id="section-${index+1}"><h3><button aria-expanded="false" aria-controls="panel-${index+1}" onclick="this.setAttribute('aria-expanded','true');document.getElementById('panel-${index+1}').hidden=false">Documento ${index+1}</button></h3><div id="panel-${index+1}" role="tabpanel" hidden><table><thead><tr><th>File</th><th>Scadenza</th></tr></thead><tbody>${Array.from({length:count},(_,n)=>`<tr><td class="file">file-${index+1}-${n+1}.pdf</td><td class="expiry">31/12/2027</td></tr>`).join('')}</tbody></table></div></section>`).join('')}<p id="long">Testo deliberatamente lungo per verificare il troncamento esplicito.</p><input type="password" name="password" value="${secret}"><textarea name="session_token">${secret}</textarea><iframe id="embedded" src="/popup"></iframe><button id="icon-delete" onclick="document.getElementById('long').textContent='DELETED'"><img alt="delete" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></button><button id="replace-node" onclick="const old=document.querySelector('#section-1 button');old.replaceWith(old.cloneNode(true))">Sostituisci nodo</button></main>`);return;
  }
  if(req.url==='/observation-failure') {
    res.end(`<h1>Pagina caricata</h1><script>document.querySelectorAll=()=>{throw new Error('password=${secret}');};</script>`);return;
  }
  if(req.url==='/observation-retry') {
    res.end(`<h1>Lettura recuperata</h1><script>const original=document.querySelectorAll.bind(document);document.querySelectorAll=(...args)=>{document.querySelectorAll=original;throw new Error('Execution context was destroyed, most likely because of a navigation.');};</script>`);return;
  }
  if(req.url==='/documents') {
    res.end(`<main><h1>Documenti</h1>${[1,2,3,4].map(n=>`<section>
      <button id="doc-${n}" role="tab" onclick="document.querySelector('#panel-${n}').hidden=false">${n===4?'Quarto documento':`Documento ${n}`}</button>
      <div id="panel-${n}" role="tabpanel" aria-labelledby="doc-${n}" ${n===4?'hidden':''}>
        <table><thead><tr><th>File</th></tr></thead><tbody><tr><td>allegato-${n}.pdf <a href="/popup"><img alt="Scarica file" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></a></td></tr></tbody></table>
      </div></section>`).join('')}</main>`);return;
  }
  res.end(`<!doctype html><html><head><title>Gestionale fixture</title></head><body>
    <div role="dialog" aria-hidden="true" style="display:none"><button>Invisibile</button></div>
    <main><h1>Clienti</h1><form onsubmit="event.preventDefault();document.cookie='cortex_fixture=1; SameSite=Lax';for(let i=0;i<40;i++)console.error('fixture diagnostic');sessionStorage.setItem('name',document.querySelector('#name').value);document.querySelector('#status').textContent='Ricerca completata'">
      <label for="name">Nome</label><input id="name" value="Mario">
      <label for="area">Provincia</label><select id="area"><option>Milano</option><option>Roma</option></select>
      <label for="flag">Attivo</label><input id="flag" type="checkbox">
      <label>Password</label><input type="password" name="password" value="${secret}"><input type="hidden" name="csrf_token" value="${secret}">
      <button>Cerca</button><button type="button" id="ajax" onclick="fetch('/rows').then(r=>r.text()).then(v=>document.querySelector('tbody').innerHTML=v)">Filtra AJAX</button>
    </form><p id="status" role="alert"></p>
    <table><thead><tr><th>Nome</th><th>Azione</th></tr></thead><tbody><tr><td>Prima pagina</td><td><button>Dettaglio</button></td></tr></tbody></table>
    <button id="next" onclick="document.querySelector('tbody').innerHTML='<tr><td>Seconda pagina</td><td><button>Dettaglio</button></td></tr>'">Successiva</button>
    <button id="modal" onclick="document.querySelector('#modal-dialog').hidden=false">Apri modale</button>
    <div role="dialog" id="modal-dialog" hidden><h2>Modale</h2><button onclick="this.parentNode.hidden=true">Chiudi modale</button></div>
    <button id="combo" role="combobox" aria-label="Comune" onclick="document.querySelector('#options').hidden=false">Scegli comune</button>
    <div id="options" hidden><input placeholder="Cerca comune" oninput="document.querySelector('#option').textContent=this.value"><button role="option" id="option" onclick="document.querySelector('#combo').textContent=this.textContent;this.parentNode.hidden=true">Milano</button></div>
    <a href="/popup">Navigazione</a><a target="_blank" href="/popup">Popup</a><a target="_blank" href="${denied}/popup">Popup esterno</a><a target="_blank" href="/redirect-chain">Popup redirect</a>
    <a href="${denied}/blocked">Esterno</a><button onclick="window.__deleted=true">Elimina</button>
    <script>document.querySelector('form').addEventListener('submit',()=>localStorage.setItem('name',document.querySelector('#name').value));document.querySelector('#name').value=sessionStorage.getItem('name')||localStorage.getItem('name')||'Mario';console.error('password=${secret}');</script></main></body></html>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${fixture.address().port}`;

function start(extra={}) {
  stderr='';
  const c=spawn(process.execPath,[process.env.CORTEX_TEST_ENTRY || 'bin/cortex.mjs'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],env:{
    ...process.env,BROWSER_TOOL_PROFILE:'cortex',BROWSER_DEFAULT_TARGET:'launch',CORTEX_ALLOWED_ORIGINS:origin,CORTEX_HEADLESS:'true',
    CORTEX_ARTIFACTS:path.join(temp,'screenshots'),...extra
  }});
  child=c;exited=new Promise(resolve=>c.once('exit',(code,signal)=>resolve({code,signal})));
  c.once('error',error=>{for(const entry of pending.values()) entry.reject(error);});
  let buffer='';
  c.stderr.on('data',chunk=>{stderr+=chunk;});
  c.stdout.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')) {
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      // Any stdout log breaks this test: STDIO must contain only JSON-RPC.
      const message=JSON.parse(line);
      if(pending.has(message.id)) {
        const entry=pending.get(message.id);pending.delete(message.id);clearTimeout(entry.timer);
        message.error?entry.reject(new Error(JSON.stringify(message.error))):entry.resolve(message.result);
      }
    }
  });
}
function request(method,params) {
  const id=++counter;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout ${method}; ${stderr}`));},45000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
async function initialize() {
  const r=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'cortex-smoke',version:'1.0'}});
  assert.equal(r.serverInfo.name,'cortex');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  return r;
}
async function call(name,args={},ok=true) {
  const r=await request('tools/call',{name,arguments:args});
  assert.equal(Boolean(r.isError),!ok,`${name}: ${JSON.stringify(r)}`);
  assert.ok(!JSON.stringify(r).includes(secret),'secret leaked in MCP output');
  if(name.startsWith('cortex_')) assert.deepEqual(JSON.parse(r.content[0].text),r.structuredContent);
  return r.structuredContent || r;
}
async function stop() {
  if(!child || child.exitCode!==null) return;
  child.stdin.end();
  let timer;
  const outcome=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),10000);})]);
  clearTimeout(timer);
  assert.ok(outcome,'server did not exit after stdin EOF');assert.equal(outcome.code,0,stderr);
}
function checkSchema(schema) {
  if(schema.type==='array') assert.ok(schema.items,'array.items missing');
  for(const v of Object.values(schema)) if(v && typeof v==='object') {
    if(Array.isArray(v)) v.forEach(x=>{if(x && typeof x==='object')checkSchema(x);});else checkSchema(v);
  }
}

try {
  assert.equal(permitted('https://user:pass@dev.test',['https://dev.test']),false);
  assert.equal(safeUrl(`${origin}/clients?token=${secret}#${secret}`),`${origin}/clients`);
  assert.ok(!redact(`token=${secret} Bearer ${secret}`).includes(secret));
  for(const tool of cortexToolDefinitions) {checkSchema(tool.inputSchema);assert.equal(Object.keys(tool.annotations).length,4);}
  start();await initialize();
  const listed=(await request('tools/list',{})).tools;
  assert.equal(listed.length,4);
  for(const name of ['cortex_open','cortex_peek','cortex_run','cortex_debug']) assert.ok(listed.some(t=>t.name===name),name);
  assert.ok(!stderr.includes('Loading Playwright library'),'discovery loaded browser');
  await call('cortex_open',{url:denied},false);
  assert.ok(!stderr.includes('Loading Playwright library'),'invalid URL launched browser');
  await call('cortex_run',{steps:Array.from({length:26},()=>({op:'click',target:'css:#name'}))},false);
  const invalid=await call('cortex_run',{steps:[{op:'fill',target:'label:Nome',value:'safe'},{op:'click'}]},false);assert.equal(invalid.failedAt,2);assert.equal(invalid.completed,0);
  for(const value of ['', '   ']) {
    const emptyUrl=await call('cortex_run',{steps:[{op:'fill',target:'label:Nome',value:'must not execute'},{op:'expect_url',value}]},false);
    assert.equal(emptyUrl.phase,'validation');assert.equal(emptyUrl.failedAt,2);assert.equal(emptyUrl.completed,0);assert.match(emptyUrl.error.message,/URL atteso vuoto/);
  }
  assert.ok(!stderr.includes('Loading Playwright library'),'invalid URL assertions launched browser');
  const open=await call('cortex_open',{url:`${origin}/?token=${secret}`});assert.equal(open.url,`${origin}/`);assert.equal(open.state,undefined);
  const peek=await call('cortex_peek',{query:'Nome',limit:2});assert.equal(peek.controls[0].name,'Nome');assert.equal(peek.controls[0].value,undefined);
  const ref=peek.controls[0].ref;
  await call('cortex_run',{steps:[{op:'fill',target:`ref:${ref}`,value:'Anna'}]});
  // Match the natural agent contract: use peek refs and CSS without prefixes.
  await call('cortex_run',{steps:[{op:'fill',target:ref,value:'Bare ref'},{op:'expect_value',target:'input[id="name"]',value:'Bare ref'}]});
  await call('cortex_run',{steps:[{op:'fill',target:'#name',value:'Bare CSS'},{op:'expect_value',target:'input:not([type="password"])#name',value:'Bare CSS'}]});
  const invalidEngine=await call('cortex_run',{steps:[{op:'fill',target:'xpath=//input',value:'wrong',timeout:100}]},false);
  assert.equal(invalidEngine.completed,0);
  await call('cortex_peek',{query:'Cerca'});
  await call('cortex_run',{steps:[{op:'fill',target:`ref:${ref}`,value:'Anna'}]});
  await call('cortex_open',{url:origin});
  const staleStarted=performance.now();
  const stale=await call('cortex_run',{steps:[{op:'fill',target:`ref:${ref}`,value:'wrong'}]},false);assert.equal(stale.failedAt,1);
  assert.equal(stale.error.kind,'StaleRef');assert.equal(stale.recovery.failedStepExecuted,false);assert.ok(stale.recovery.candidates.some(c=>c.name==='Nome'));assert.ok(performance.now()-staleStarted<2500,'stale refs must fail before the default auto-wait');
  const batch=await call('cortex_run',{steps:[
    {op:'fill',target:'label:Nome',value:'Mario Rossi'},
    {op:'select',target:'label:Provincia',value:'Roma'},
    {op:'check',target:'label:Attivo'}, {op:'uncheck',target:'label:Attivo'},
    {op:'click',target:'role:button|Cerca'},
    {op:'expect_text',target:'css:#status',value:'Ricerca completata'},
    {op:'expect_value',target:'label:Nome',value:'Mario Rossi'},
    {op:'expect_url',value:origin},
    {op:'click',target:'role:button|Filtra AJAX'},
    {op:'wait',target:'text:Mario Rossi'},
    {op:'expect_count',target:'css:tbody tr',count:1},
    {op:'click',target:'role:button|Dettaglio',withinRow:'Mario Rossi'}
  ]});assert.equal(batch.completed,12);assert.equal(batch.state,undefined);
  const grid=await call('cortex_peek',{mode:'grid',query:'Mario',limit:1});assert.equal(grid.tables[0].matched.length,1);
  await call('cortex_run',{steps:[{op:'click',target:'role:button|Successiva'},{op:'expect_visible',target:'text:Seconda pagina'}]});
  await call('cortex_run',{steps:[{op:'click',target:'role:button|Apri modale'},{op:'expect_visible',target:'role:button|Chiudi modale'}]});
  const modal=await call('cortex_peek');assert.ok(modal.controls.some(c=>c.name==='Chiudi modale'));assert.ok(!modal.controls.some(c=>c.name==='Cerca'));
  await call('cortex_run',{steps:[{op:'click',target:'role:button|Chiudi modale'},{op:'expect_hidden',target:'css:#modal-dialog'},
    {op:'click',target:'role:combobox|Comune'},{op:'fill',target:'placeholder:Cerca comune',value:'Roma'},{op:'click',target:'css:#options [role="option"]'},{op:'expect_text',target:'css:#combo',value:'Roma'}]});
  const failure=await call('cortex_run',{steps:[{op:'fill',target:'label:Nome',value:'prima'},{op:'click',target:'css:#does-not-exist',timeout:100},{op:'fill',target:'label:Nome',value:'dopo'}]},false);
  assert.equal(failure.completed,1);assert.equal(failure.failedAt,2);assert.equal(failure.screenshotLocal,undefined);
  const debug=await call('cortex_debug');assert.equal(debug.lastFailure.failedAt,2);assert.equal(debug.screenshotLocal,null);assert.ok(debug.errors.some(e=>e.type==='console'&&e.count>=40),JSON.stringify(debug.errors));assert.equal(debug.errors.filter(e=>e.type==='console').length,1);
  await call('cortex_run',{steps:[{op:'expect_value',target:'label:Nome',value:'prima'}]});
  await call('cortex_run',{steps:[{op:'click',target:'role:button|Elimina'}]},false);
  await assert.rejects(fs.access(path.join(temp,'screenshots')));
  const shot=await call('cortex_debug',{screenshot:true});assert.equal(path.extname(shot.screenshotLocal),'.png');assert.ok((await fs.stat(shot.screenshotLocal)).size>0);
  // Reload keeps cookies/storage/session and does not require a second login.
  await call('cortex_open',{url:origin});
  await call('cortex_run',{steps:[{op:'expect_value',target:'label:Nome',value:'Mario Rossi'}]});
  // Concurrent Cortex calls serialize rather than interleave batch state.
  await Promise.all([
    call('cortex_run',{steps:[{op:'fill',target:'label:Nome',value:'A'},{op:'expect_value',target:'label:Nome',value:'A'}]}),
    call('cortex_run',{steps:[{op:'fill',target:'label:Nome',value:'B'},{op:'expect_value',target:'label:Nome',value:'B'}]})
  ]);
  await call('cortex_run',{steps:[{op:'click',target:'role:link|Popup',popup:true},{op:'expect_visible',target:'text:Popup locale'}]});
  await call('cortex_open',{url:origin});
  await call('cortex_run',{steps:[{op:'click',target:'role:link|Popup esterno',popup:true}]},false);
  await call('cortex_open',{url:origin});
  await call('cortex_open',{url:`${origin}/redirect`},false);
  await call('cortex_open',{url:`${origin}/redirect-chain`},false);
  const redirected=await call('cortex_open',{url:`${origin}/redirect-allowed`});assert.equal(redirected.url,`${origin}/popup`);
  assert.equal(blockedHits,0,'external redirect/popup reached denied server');
  // The in-process proxy must also block a popup's very first redirect chain.
  await call('cortex_open',{url:origin});
  await call('cortex_run',{steps:[{op:'click',target:'role:link|Popup redirect',popup:true}]},false);
  assert.equal(blockedHits,0,'initial popup redirect bypassed the network allowlist');
  await call('cortex_open',{url:origin});
  // Real navigation followed by observation must not invent a failed step.
  const navigated=await call('cortex_run',{steps:[{op:'click',target:'role:link|Navigazione'}],observeAfter:true});
  assert.equal(navigated.completed,1);assert.equal(navigated.state.heading,'Popup locale');assert.equal(navigated.failedAt,undefined);
  const retry=await call('cortex_open',{url:`${origin}/observation-retry`,observe:true});
  assert.equal(retry.state.heading,'Lettura recuperata');
  const observed=await call('cortex_open',{url:`${origin}/observation-failure`,observe:true});
  assert.equal(observed.ok,true);assert.ok(observed.observationError);assert.equal(observed.state,undefined);
  const observedBatch=await call('cortex_run',{steps:[{op:'expect_url',value:'/observation-failure'}],observeAfter:true});
  assert.equal(observedBatch.ok,true);assert.equal(observedBatch.completed,1);assert.ok(observedBatch.observationError);assert.equal(observedBatch.failedAt,undefined);
  const observationDebug=await call('cortex_debug');assert.equal(observationDebug.lastFailure.phase,'observation');
  await call('cortex_open',{url:`${origin}/hidden-busy`});
  const hiddenBusy=await call('cortex_peek',{timeout:500});assert.equal(hiddenBusy.heading,'Pagina pronta');assert.ok(hiddenBusy.controls.some(c=>c.name==='Disponibile'));
  await call('cortex_open',{url:`${origin}/visible-busy`});
  const visibleBusy=await call('cortex_peek',{timeout:100},false);assert.equal(visibleBusy.error.kind,'TimeoutError');
  const visibleBusyPartial=await call('cortex_peek',{waitForReady:false});assert.equal(visibleBusyPartial.incomplete,true);
  // Collapsed legacy sections stay discoverable; query searches beyond table #3.
  await call('cortex_open',{url:`${origin}/documents`});
  const section=await call('cortex_peek',{query:'Quarto documento'});assert.equal(section.controls[0].role,'tab');
  await call('cortex_run',{steps:[{op:'click',target:`ref:${section.controls[0].ref}`},{op:'expect_visible',target:'css:#panel-4'}]});
  const allTables=await call('cortex_peek',{mode:'grid'});assert.equal(allTables.tables.length,3);assert.equal(allTables.moreTables,true);
  const fourth=await call('cortex_peek',{mode:'grid',query:'Quarto documento'});assert.equal(fourth.tables.length,1);assert.equal(fourth.tables[0].title,'Quarto documento');assert.ok(fourth.tables[0].matched[0].includes('allegato-4.pdf'));
  const byFile=await call('cortex_peek',{mode:'grid',query:'allegato-4.pdf'});assert.equal(byFile.tables.length,1);
  const icons=await call('cortex_peek',{query:'Scarica file'});assert.ok(icons.controls.some(c=>c.name==='Scarica file'));
  // Structured collection keeps UI interaction and deterministic iteration local.
  const fields=[{name:'file',selector:'.file'},{name:'expires',selector:'.expiry'}];
  const groupFields=[{name:'section',selector:'h3'}];
  const plan={steps:[{op:'each',target:'css:section',fields:groupFields,limit:10,steps:[{op:'expand',target:'css:h3 button'},{op:'extract',target:'css:tbody tr',fields}]}]};
  const expected=[1,1,1,1,2,0,1].map((count,index)=>({section:`Documento ${index+1}`,records:Array.from({length:count},(_,n)=>({file:`file-${index+1}-${n+1}.pdf`,expires:'31/12/2027'}))}));
  const manualSamples=[],batchSamples=[];
  for(let iteration=0;iteration<3;iteration++) {
    await call('cortex_open',{url:`${origin}/enterprise`});
    let bytes=0,calls=0;const started=performance.now(),manual=[];
    for(let index=1;index<=7;index++) {
      const action=await call('cortex_run',{steps:[{op:'expand',target:`css:#section-${index} h3 button`}]});bytes+=JSON.stringify(action).length;calls++;
      const read=await call('cortex_peek',{mode:'extract',scope:`#section-${index}`,items:'tbody tr',fields});bytes+=JSON.stringify(read).length;calls++;
      manual.push({section:`Documento ${index}`,records:read.records});
    }
    assert.deepEqual(manual,expected);manualSamples.push({calls,bytes,ms:performance.now()-started});
    await call('cortex_open',{url:`${origin}/enterprise`});
    const batchStarted=performance.now(),collected=await call('cortex_run',plan);
    assert.equal(collected.incomplete,undefined);assert.equal(collected.completed,1);
    const actual=collected.data[0].groups.map(g=>({section:g.section,records:g.data[0].records}));
    assert.deepEqual(actual,expected);batchSamples.push({calls:1,bytes:JSON.stringify(collected).length,ms:performance.now()-batchStarted});
  }
  const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const manualMetrics={calls:14,bytes:median(manualSamples.map(r=>r.bytes)),ms:Math.round(median(manualSamples.map(r=>r.ms)))};
  const batchMetrics={calls:1,bytes:median(batchSamples.map(r=>r.bytes)),ms:Math.round(median(batchSamples.map(r=>r.ms)))};
  assert.ok(batchMetrics.bytes<manualMetrics.bytes,'aggregation must reduce result size');
  console.log('[BENCH] cortex enterprise '+JSON.stringify({samples:3,groups:7,files:7,manual:manualMetrics,batch:batchMetrics}));
  await call('cortex_run',plan); // Already open panels stay open, never toggled shut.
  const aliasPlan=await call('cortex_run',{steps:[{op:'each',target:'section',fields:groupFields,limit:10,steps:[{op:'expand',target:'h3 button'},{op:'extract',target:'tbody tr',fields}]}]});
  assert.deepEqual(aliasPlan.data[0].groups.map(g=>({section:g.section,records:g.data[0].records})),expected);
  const frame=await call('cortex_peek',{frame:'#embedded',query:'Chiudi'});assert.ok(frame.controls.some(c=>c.name==='Chiudi'));
  await call('cortex_run',{frame:'#embedded',steps:[{op:'expect_visible',target:'text:Popup locale'}]});
  const shortened=await call('cortex_peek',{mode:'extract',items:'#long',fields:[{name:'text',maxLength:10}]});assert.deepEqual(shortened.records[0].truncatedFields,['text']);assert.equal(shortened.incomplete,true);
  const paged=await call('cortex_peek',{mode:'extract',items:'section',fields:groupFields,limit:2});assert.equal(paged.nextOffset,2);assert.equal(paged.incomplete,true);
  const continued=await call('cortex_peek',{mode:'extract',items:'section',fields:groupFields,limit:2,offset:paged.nextOffset});assert.equal(continued.records[0].section,'Documento 3');
  const hiddenValues=await call('cortex_peek',{mode:'extract',items:'input,textarea',fields:[{name:'text'}]});assert.ok(hiddenValues.records.every(r=>r.text===null));
  const ambiguousScope=await call('cortex_peek',{scope:'section'},false);assert.match(ambiguousScope.error.message,/Scope ambiguo \(7 elementi\)/);
  const missingScope=await call('cortex_peek',{scope:'.panel-group'},false);assert.match(missingScope.error.message,/Scope non trovato \(0 elementi\)/);
  const oversizedField=await call('cortex_run',{steps:[{op:'each',target:'section',limit:10,steps:[{op:'extract',target:':scope',fields:[{name:'text',maxLength:4000}]}]}]},false);
  assert.equal(oversizedField.completed,0);assert.match(oversizedField.error.message,/arguments\.steps\[0\]\.steps\[0\]\.fields\[0\]\.maxLength \(1\.\.500\)/);
  await call('cortex_run',{steps:[{op:'extract',target:'css:section',fields:[{name:'same'},{name:'same'}]}]},false);
  await call('cortex_run',{steps:[{op:'each',target:'css:section',fields:[{name:'ref',selector:'h3'}],steps:[{op:'expand',target:'css:h3 button'}]}]},false);
  await call('cortex_peek',{mode:'extract',items:'section',fields:[{name:'truncatedFields'}]},false);
  const safe=await call('cortex_peek',{query:'delete'});assert.ok(safe.controls.length);
  await call('cortex_run',{steps:[{op:'click',target:`ref:${safe.controls[0].ref}`}]},false);
  const seen=await call('cortex_peek',{scope:'#section-1'});const oldNode=seen.controls[0].ref;
  await call('cortex_run',{steps:[{op:'click',target:'css:#replace-node'}]});
  const replaced=await call('cortex_run',{steps:[{op:'click',target:`ref:${oldNode}`,timeout:100}]},false);assert.equal(replaced.failedAt,1);
  const bareReplaced=await call('cortex_run',{steps:[{op:'click',target:oldNode,timeout:100}]},false);assert.equal(bareReplaced.failedAt,1);assert.match(bareReplaced.error.message,/Ref obsoleto/);
  await call('cortex_open',{url:`${origin}/enterprise`});
  const loopError=await call('cortex_run',{steps:[{op:'each',target:'css:section',steps:[{op:'expand',target:'css:h3 button'},{op:'expect_visible',target:'css:.missing',timeout:100},{op:'click',target:'css:h3 button'}]}]},false);
  assert.equal(loopError.failedAt,1);assert.equal(loopError.itemIndex,1);assert.equal(loopError.innerStep,2);assert.equal(loopError.completed,0);
  const untouched=await call('cortex_peek',{scope:'#section-2'});assert.equal(untouched.controls[0].expanded,false);
  // A row filter identifies a record, not which of its four actions to click.
  await call('cortex_open',{url:`${origin}/row-actions`});
  const ambiguousAction=await call('cortex_run',{steps:[{op:'fill',target:'#row-search',value:'ATIS s.rl.'},{op:'click',target:'#row-filter'},{op:'expect_count',target:'table tbody tr',count:1},{op:'click',target:'a',withinRow:'ATIS s.rl.'}]},false);
  assert.equal(ambiguousAction.completed,3);assert.equal(ambiguousAction.failedAt,4);assert.equal(ambiguousAction.error.kind,'AmbiguousTarget');
  assert.equal(ambiguousAction.ambiguity.matches,4);assert.equal(ambiguousAction.ambiguity.failedStepExecuted,false);assert.equal(ambiguousAction.ambiguity.candidates.length,4);
  assert.ok(ambiguousAction.ambiguity.candidates.every(c=>c.row.includes('ATIS')&&!c.href.includes('?')&&!c.href.includes('#')));
  const rowPeek=await call('cortex_peek',{query:'ATIS s.rl.'});
  const chosen=ambiguousAction.ambiguity.candidates.find(c=>c.name==='Visualizza');assert.ok(chosen);
  assert.equal(rowPeek.controls.find(c=>c.name==='Visualizza').ref,chosen.ref);
  await call('cortex_run',{steps:[{op:'expect_text',target:'#row-result',value:'Nessuna azione'},{op:'expect_value',target:'#search-count',value:'1'},{op:'click',target:chosen.ref},{op:'expect_text',target:'#row-result',value:'Visualizza'},{op:'expect_value',target:'#search-count',value:'1'}]});
  await call('cortex_open',{url:`${origin}/row-actions`});
  const capped=await call('cortex_run',{steps:[{op:'click',target:'a'}]},false);
  assert.equal(capped.ambiguity.matches,8);assert.equal(capped.ambiguity.candidates.length,5);assert.equal(capped.ambiguity.moreCandidates,true);
  // Dynamic DOM, scoped roots, async readiness, removed each items and frame diagnostics.
  await call('cortex_open',{url:`${origin}/hardening`});
  const rootButton=await call('cortex_peek',{scope:'#root-control'});assert.equal(rootButton.controls[0].name,'Controllo root');
  const rootGrid=await call('cortex_peek',{mode:'grid',scope:'#root-grid'});assert.equal(rootGrid.tables[0].matched[0],'root.pdf');
  const rootAlert=await call('cortex_peek',{scope:'#root-alert'});assert.deepEqual(rootAlert.alerts,['Avviso root']);
  const roles=await call('cortex_peek');assert.equal(roles.controls.find(c=>c.name==='Filtro').ariaRole,'textbox');assert.equal(roles.controls.find(c=>c.name==='Note').ariaRole,'textbox');assert.equal(roles.controls.find(c=>c.name==='Multipla').ariaRole,'listbox');
  await call('cortex_run',{steps:[{op:'fill',target:'role:text|Filtro',value:'alias'},{op:'fill',target:'role:textarea|Note',value:'nota'},{op:'select',target:'role:listbox|Multipla',value:'Uno'}]});
  const missingActionScope=await call('cortex_run',{steps:[{op:'expect_hidden',target:'.absent',scope:'.absent-scope'}]},false);assert.match(missingActionScope.error.message,/Scope non trovato/);
  const multiActionScope=await call('cortex_run',{steps:[{op:'click',target:'button',scope:'.duplicate'}]},false);assert.match(multiActionScope.error.message,/Scope ambiguo/);assert.equal(multiActionScope.completed,0);
  const filterSeen=await call('cortex_peek',{scope:'#unique'}),oldFilter=filterSeen.controls.find(c=>c.name==='Filtro').ref;
  await call('cortex_run',{steps:[{op:'click',target:'#replace-filter'}]});
  const ajaxStale=await call('cortex_run',{steps:[{op:'fill',target:oldFilter,value:'must not execute'}]},false);assert.equal(ajaxStale.error.kind,'StaleRef');assert.equal(ajaxStale.completed,0);
  const currentFilter=ajaxStale.recovery.candidates.find(c=>c.name==='Filtro');assert.ok(currentFilter);
  await call('cortex_run',{steps:[{op:'expect_hidden',target:oldFilter},{op:'expect_count',target:oldFilter,count:0},{op:'fill',target:currentFilter.ref,value:'recuperato'},{op:'expect_value',target:'#filter',value:'recuperato'}]});
  const asyncData=await call('cortex_run',{steps:[{op:'each',target:'.async-section',fields:[{name:'section',selector:'h3'}],steps:[{op:'expand',target:'h3 button'},{op:'extract',target:'tbody tr',fields:[{name:'file',selector:'.file'}]}]}]});
  assert.deepEqual(asyncData.data[0].groups.map(g=>g.data[0].records),[[{file:'async.pdf'}],[]]);assert.equal(asyncData.incomplete,undefined);
  const partial=await call('cortex_peek',{mode:'extract',items:'#root-grid tbody tr',fields:[{name:'file'}],waitForReady:false});assert.equal(partial.incomplete,true);assert.equal(partial.pending,true);
  const partialEach=await call('cortex_run',{steps:[{op:'each',target:'.duplicate',waitForReady:false,steps:[{op:'extract',target:':scope',fields:[{name:'text'}]}]}]});assert.equal(partialEach.incomplete,true);
  const changedScope=await call('cortex_run',{steps:[{op:'each',target:'.clone-section',steps:[{op:'expand',target:'button'},{op:'extract',target:'tbody tr',fields:[{name:'file',selector:'.file'}]}]}]},false);
  assert.equal(changedScope.innerStep,2);assert.match(changedScope.error.message,/Scope each sostituito/);assert.equal(changedScope.data[0].groups[0].data.length,0);
  const removedStarted=performance.now();
  const removedEach=await call('cortex_run',{steps:[{op:'each',target:'.removable',steps:[{op:'expand',target:'button',timeout:300}]}]},false);
  assert.equal(removedEach.itemIndex,2);assert.equal(removedEach.innerStep,1);assert.ok(performance.now()-removedStarted<2500);
  const removedDebug=await call('cortex_debug');assert.equal(removedDebug.lastFailure.locator.matches,0);
  const selfStarted=performance.now();const selfRemoved=await call('cortex_run',{steps:[{op:'expand',target:'#self-vanish',timeout:150}]},false);assert.equal(selfRemoved.completed,0);assert.ok(performance.now()-selfStarted<2500);
  await call('cortex_run',{steps:[{op:'fill',frame:'#frame',target:'#missing',value:'x',timeout:100}]},false);
  const frameDebug=await call('cortex_debug');assert.equal(frameDebug.lastFailure.locator.inFrame,true);assert.equal(frameDebug.lastFailure.locator.matches,0);
  const frameControls=await call('cortex_peek',{frame:'#frame'});assert.equal(frameControls.controls.find(c=>c.name==='Apri popup frame').ariaRole,'link');
  await call('cortex_run',{steps:[{op:'click',frame:'#frame',target:'role:a|Apri popup frame',popup:true},{op:'expect_visible',target:'text:Popup locale'}]});
  // A concurrent legacy call waits for Cortex; it cannot disable the origin guard mid-batch.
  await call('cortex_open',{url:`${origin}/hardening`});
  const concurrentNavigation=call('cortex_run',{steps:[{op:'click',target:'#deferred'},{op:'expect_visible',target:'.never-created',timeout:600}]},false);
  await Promise.all([concurrentNavigation,call('cortex_debug')]);
  assert.equal(blockedHits,0,'concurrent legacy inspection suspended the Cortex network policy');
  await call('cortex_open',{url:`${origin}/projection-slow`});
  const slowProjection=await call('cortex_peek',{timeout:100},false);assert.equal(slowProjection.error.kind,'TimeoutError');
  // Dedicated contexts share one browser but never share storage, refs or diagnostics.
  const isolatedA=await call('cortex_open',{url:origin,newSession:true});
  const isolatedB=await call('cortex_open',{url:origin,newSession:true});
  assert.equal(isolatedA.isolated,true);assert.notEqual(isolatedA.sessionId,isolatedB.sessionId);
  await call('cortex_run',{sessionId:isolatedA.sessionId,steps:[{op:'fill',target:'label:Nome',value:'Sessione A'},{op:'click',target:'role:button|Cerca'}]});
  await call('cortex_open',{sessionId:isolatedA.sessionId,url:origin});
  await call('cortex_run',{sessionId:isolatedA.sessionId,steps:[{op:'expect_value',target:'label:Nome',value:'Sessione A'}]});
  await call('cortex_run',{sessionId:isolatedB.sessionId,steps:[{op:'expect_value',target:'label:Nome',value:'Mario'}]});
  await call('cortex_open',{sessionId:isolatedA.sessionId,url:`${origin}/session-probe`});
  await call('cortex_run',{sessionId:isolatedA.sessionId,steps:[{op:'expect_text',target:'#state',value:'present'}]});
  await call('cortex_open',{sessionId:isolatedB.sessionId,url:`${origin}/session-probe`});
  await call('cortex_run',{sessionId:isolatedB.sessionId,steps:[{op:'expect_text',target:'#state',value:'empty'}]});
  await call('cortex_run',{sessionId:isolatedA.sessionId,steps:[{op:'click',target:'#missing',timeout:100}]},false);
  const isolatedDebugB=await call('cortex_debug',{sessionId:isolatedB.sessionId});assert.equal(isolatedDebugB.lastFailure,null);assert.equal(isolatedDebugB.sessionId,isolatedB.sessionId);
  const closedA=await call('cortex_debug',{sessionId:isolatedA.sessionId,closeSession:true});assert.equal(closedA.closed,true);
  const closedUse=await call('cortex_peek',{sessionId:isolatedA.sessionId},false);assert.equal(closedUse.error.kind,'SessionClosed');
  await call('cortex_debug',{sessionId:isolatedB.sessionId,closeSession:true});
  const firstProject=path.join(temp,'isolated-first'),secondProject=path.join(temp,'isolated-second');await fs.mkdir(firstProject);await fs.mkdir(secondProject);
  await fs.writeFile(path.join(firstProject,'.env'),`CORTEX_ALLOWED_ORIGINS=${origin}\n`);
  await fs.writeFile(path.join(secondProject,'.env'),`CORTEX_ALLOWED_ORIGINS=${denied}\n`);
  const policyA=await call('cortex_open',{newSession:true,project_path:firstProject,url:origin});
  const hitsBeforeAllowed=blockedHits;
  const policyB=await call('cortex_open',{newSession:true,project_path:secondProject,url:denied});assert.ok(blockedHits>hitsBeforeAllowed);
  const hitsBeforeRejected=blockedHits;
  await call('cortex_open',{sessionId:policyA.sessionId,url:denied},false);assert.equal(blockedHits,hitsBeforeRejected);
  await call('cortex_run',{sessionId:policyA.sessionId,steps:[{op:'click',target:'role:link|Esterno'}]},false);assert.equal(blockedHits,hitsBeforeRejected,'one isolated context changed another proxy policy');
  await call('cortex_peek',{sessionId:policyA.sessionId,project_path:secondProject},false);
  await call('cortex_debug',{sessionId:policyA.sessionId,closeSession:true});await call('cortex_debug',{sessionId:policyB.sessionId,closeSession:true});
  await call('cortex_open',{url:`${origin}/enterprise`});
  await call('cortex_run',{steps:[{op:'each',target:'css:section',steps:[{op:'each',target:'css:button',steps:[]}]}]},false);
  await call('cortex_open',{url:origin});
  await stop();
  // A complete isolated form flow works with the unconfigured/default four-tool API.
  start({BROWSER_TOOL_PROFILE:undefined});await initialize();
  const defaultOpen=await call('cortex_open',{url:origin,newSession:true,observe:true});
  assert.ok(defaultOpen.sessionId);assert.equal(defaultOpen.isolated,true);
  await call('cortex_peek',{sessionId:defaultOpen.sessionId,query:'Nome',limit:2});
  await call('cortex_run',{sessionId:defaultOpen.sessionId,steps:[{op:'fill',target:'label:Nome',value:'Default Cortex'},{op:'select',target:'label:Provincia',value:'Roma'},{op:'check',target:'label:Attivo'},{op:'click',target:'role:button|Cerca'},{op:'expect_text',target:'#status',value:'Ricerca completata'}]});
  assert.equal((await call('cortex_debug',{sessionId:defaultOpen.sessionId,closeSession:true})).closed,true);
  const defaultProject=path.join(temp,'profile-cannot-override');await fs.mkdir(defaultProject);await fs.writeFile(path.join(defaultProject,'.env'),'BROWSER_TOOL_PROFILE=all\n');
  const bypass=await request('tools/call',{name:'browser_session',arguments:{action:'get_capabilities',project_path:defaultProject}});assert.equal(bypass.structuredContent.error.kind,'UnknownTool');
  await stop();
  console.log('[PASS] cortex: four-tool API, legacy tools unavailable, isolated default form flow');
  // Explicit project .env overrides launcher values without changing global env.
  const project=path.join(temp,'project');await fs.mkdir(project);
  const configuredChrome=process.env.CORTEX_CHROME_PATH||process.env.BROWSER_EXECUTABLE_PATH;
  const relativeChrome=configuredChrome?path.relative(project,path.resolve(configuredChrome)):null;
  await fs.writeFile(path.join(project,'.env'),`CORTEX_ALLOWED_ORIGINS=${origin}\nCORTEX_HEADLESS=true\nCORTEX_PROFILE_DIR=profile\n${relativeChrome?`CORTEX_CHROME_PATH="${relativeChrome.split(path.sep).join('/')}"\n`:''}`);
  start({CORTEX_ALLOWED_ORIGINS:denied});await initialize();
  await call('cortex_open',{url:origin,project_path:project});
  await call('cortex_run',{project_path:project,steps:[{op:'fill',target:'label:Nome',value:'Profilo'},{op:'click',target:'role:button|Cerca'}]});
  await stop();await fs.access(path.join(project,'profile'));
  start({CORTEX_ALLOWED_ORIGINS:denied});await initialize();
  await call('cortex_open',{url:origin,project_path:project});
  await call('cortex_run',{project_path:project,steps:[{op:'expect_value',target:'label:Nome',value:'Profilo'}]});
  await stop();
  console.log(`[PASS] cortex output bytes: open=${JSON.stringify(open).length}, peek=${JSON.stringify(peek).length}, batch12=${JSON.stringify(batch).length}, failure=${JSON.stringify(failure).length}`);
  console.log('[PASS] cortex: 4 tools, StaleRef recovery, scoped roots/actions, delayed AJAX nonempty/empty, bounded each/expand, iframe popup/debug, concurrency/allowlist, isolated contexts, relative Chrome path, persistent profile, EOF');
} finally {
  for(const entry of pending.values()) {clearTimeout(entry.timer);entry.reject(new Error('smoke cleanup'));}pending.clear();
  if(child && child.exitCode===null) {
    try {await stop();} catch {if(child.exitCode===null) {child.kill();await exited;}}
  }
  await Promise.all([new Promise(resolve=>fixture.close(resolve)),new Promise(resolve=>blocked.close(resolve))]);
  await fs.rm(temp,{recursive:true,force:true});
}
