import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { configFor } from '../config/resolve.js';
import { createCortexProxy } from './cortex-proxy.js';
import { readCortexPage } from './cortex-page.js';
import { createCortexSessionBroker } from './cortex-sessions.js';
import { permitted, sensitive, result, safeUrl, redact, errorInfo, fail, validateCortexArguments as validate } from './cortex-utils.js';
import { createExtensions } from '../extended/index.js';
import { extendedDefinitions, resolveFeatures, domainError } from '../extended/contracts.js';
import { createBudget } from '../extended/store.js';
import { OperationLedger } from '../extended/execution.js';

const operations = ['click','fill','select','press','check','uncheck','wait','expect_url','expect_visible','expect_hidden','expect_count','expect_text','expect_value','expand','extract','each','hover','focus','scroll','resize'];
const str = maxLength => ({type:'string',maxLength});
const flag = {type:'boolean',default:false};
const fieldSchema={type:'object',additionalProperties:false,required:['name'],properties:{name:{...str(32),pattern:'^[a-zA-Z][a-zA-Z0-9_]*$'},selector:str(350),attribute:{type:'string',enum:['text','name','href','title','alt','aria-label','datetime','checked']},maxLength:{type:'integer',minimum:1,maximum:500,description:'Massimo caratteri per campo: 1..500, default 300. Omettere se non necessario.'}}};
const fieldsSchema={type:'array',minItems:1,maxItems:8,items:fieldSchema};
const readProperties={scope:{...str(350),description:'CSS di un solo contenitore verificato. Opzionale: omettere se sconosciuto. Per elementi ripetuti usare items o each, non scope.'},frame:str(350),timeout:{type:'integer',minimum:100,maximum:30000},waitForReady:{type:'boolean',default:true,description:'Attende fetch/XHR attivi, jQuery e aria-busy. false consente fotografia parziale, segnalata incomplete.'},offset:{type:'integer',minimum:0,maximum:10000},limit:{type:'integer',minimum:1,maximum:100,default:20}};
const atomicProperties={
  op:{type:'string',enum:operations.filter(op=>op!=='each')},target:{...str(350),description:'Ref da peek (s1-e1 oppure ref:s1-e1), CSS (#id oppure css:#id), role:button|Nome, label:Nome, text:Nome, placeholder:Nome, testid:id. each/extract: solo CSS.'},value:str(2000),withinRow:{...str(180),description:'Filtra la riga, ma puo contenere piu link/azioni. Usa il ref del controllo corretto da un peek mirato o dai candidati.'},
  count:{type:'integer',minimum:0},state:{type:'string',enum:['visible','hidden','attached','detached','enabled','disabled']},
  width:{type:'integer',minimum:200,maximum:2560},height:{type:'integer',minimum:200,maximum:1440},
  x:{type:'integer',minimum:-100000,maximum:100000},y:{type:'integer',minimum:-100000,maximum:100000},
  timeout:{type:'integer',minimum:100,maximum:30000},popup:flag,fields:fieldsSchema,...readProperties
};
const atomicSchema={type:'object',additionalProperties:false,required:['op'],properties:atomicProperties};
const stepSchema={...atomicSchema,properties:{...atomicProperties,op:{type:'string',enum:operations},steps:{type:'array',minItems:1,maxItems:10,items:atomicSchema}}};
const schema = properties => ({type:'object',additionalProperties:false,properties:{...properties,project_path:str(4096)}});
const mutating = {readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true};
export const cortexToolDefinitions = [
  {name:'cortex_open',description:'Apri URL autorizzato nella sessione condivisa; nessuno snapshot automatico.',annotations:mutating,
    inputSchema:{...schema({url:{type:'string',format:'uri',maxLength:4096},observe:flag}),required:['url']}},
  {name:'cortex_peek',description:'Controlli/griglie o estrazione mirata. Usa i ref restituiti; dopo navigazione o sostituzione AJAX aggiorna quelli necessari. scope opzionale: CSS di un solo contenitore verificato. items: CSS dei record ripetuti. fields maxLength 1..500 (default 300). Niente HTML o valori input.',
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    inputSchema:schema({mode:{type:'string',enum:['controls','grid','extract'],default:'controls'},query:{...str(150),description:'Filtra anche per testo della riga. Per scegliere una sua azione cerca il record e usa il ref del controllo restituito.'},...readProperties,tableOffset:{type:'integer',minimum:0,maximum:10000},items:str(350),fields:fieldsSchema})},
  {name:'cortex_run',description:'Azioni/assert e piani each/expand/extract. Target: ref:s1-e1 o s1-e1; CSS; role:button|Nome, label:Nome. each/extract solo CSS; each limit max 50; fields maxLength 1..500. 25 step/200 azioni/60s. StaleRef/AmbiguousTarget: step non eseguito, max 5 candidati correnti; scegli il controllo e riprendi dallo step fallito senza ripetere quelli completati.',annotations:mutating,
    inputSchema:{...schema({steps:{type:'array',minItems:1,maxItems:25,items:stepSchema},allowDestructive:flag,observeAfter:flag,frame:str(350),operationId:{...str(128),minLength:1}}),required:['steps']}},
  {name:'cortex_debug',description:'Diagnostica compatta senza contenuti console/rete; screenshot locale solo con screenshot=true.',annotations:mutating,
    inputSchema:schema({screenshot:flag})}
];


function normalizeTarget(target) {
  const value=target.trim();
  if(/^s\d+-e\d+$/.test(value))return `ref:${value}`;
  if(/^(ref|role|label|placeholder|text|testid|css):/.test(value))return value;
  return `css:${value}`;
}

function normalizeStep(step) {
  return {...step,...(step.target!==undefined?{target:normalizeTarget(step.target)}:{}),...(step.steps?{steps:step.steps.map(normalizeStep)}:{})};
}

export function locate(p,target,withinRow,scope) {
  target=normalizeTarget(target);
  const base=scope?p.locator(scope):p;
  let root = withinRow ? base.locator('tr,[role="row"]').filter({hasText:withinRow}) : base;
  const colon = target.indexOf(':');
  if (colon < 1) throw fail('Target non valido.');
  const mode = target.slice(0,colon), value = target.slice(colon+1);
  if (!value.trim()) throw fail('Target vuoto.');
  if (mode === 'ref') {
    if (!/^s\d+-e\d+$/.test(value)) throw fail('Ref non valido.');
    return root.locator(`[data-cortex-ref="${value}"]`);
  }
  if (mode === 'role') {
    const split = value.indexOf('|');
    if (split < 1) throw fail('Formato target: role:button|Cerca.');
    const aliases={a:'link',text:'textbox',textarea:'textbox',submit:'button',reset:'button',select:'combobox'};
    return root.getByRole(aliases[value.slice(0,split)]||value.slice(0,split),{name:value.slice(split+1),exact:true});
  }
  if (mode === 'label') return root.getByLabel(value,{exact:true});
  if (mode === 'placeholder') return root.getByPlaceholder(value,{exact:true});
  if (mode === 'text') return root.getByText(value,{exact:true});
  if (mode === 'testid') return root.getByTestId(value);
  if (mode === 'css') return root.locator(`css=${value}`);
  throw fail('Tipo target non supportato.');
}

function timeLeft(deadline,max=30000) {
  const left=Math.min(max,Math.floor(deadline-performance.now()));
  if(left<=0){const error=fail('Timeout: budget dell’operazione esaurito.');error.name='TimeoutError';throw error;}
  return left;
}

async function until(check,timeout) {
  const deadline = performance.now()+timeout;
  do {
    if (await check(timeLeft(deadline))) return;
    // Condition polling, not a fixed post-action sleep.
    await new Promise(resolve=>setTimeout(resolve,Math.min(75,Math.max(0,deadline-performance.now()))));
  } while (performance.now() < deadline);
  const error=fail('Condizione attesa non raggiunta entro il timeout.');error.name='TimeoutError';throw error;
}

async function execute(p,s,allowDestructive,timeout,describeMatches,describeMissing) {
  const deadline=performance.now()+timeout,t=()=>timeLeft(deadline);
  let pinned;
  try {
  if(s.op==='resize') {if(typeof p.setViewportSize!=='function')throw fail('Resize solo su pagina top-level.');await p.setViewportSize({width:s.width,height:s.height});return;}
  if (s.op === 'expect_url') { await until(()=>p.url().includes(s.value || ''),timeout); return; }
  if (!s.target) throw fail('Target mancante.');
  const l = locate(p,s.target,s.withinRow,s.scope);
  const isAction=['click','fill','select','press','check','uncheck','expand','hover','focus','scroll'].includes(s.op);
  if(s.target.startsWith('ref:')) {
    const matches=await l.count(),id=s.target.slice(4);
    const permitsMissing=s.op==='expect_hidden'||s.op==='wait'&&['hidden','detached'].includes(s.state)||s.op==='expect_count'&&s.count===0;
    let valid=matches===0&&permitsMissing;
    if(matches===1) {
      pinned=await l.elementHandle({timeout:t()});
      valid=Boolean(pinned)&&await pinned.evaluate((e,id)=>e.isConnected&&document[Symbol.for('cortex.refs')]?.refs.get(id)?.deref()===e,id);
    }
    if(!valid) {
      let candidates=[];try{candidates=await describeMissing(p,s,id,Math.min(1500,t()));}catch{/* A current peek remains available. */}
      const error=fail('Ref obsoleto o sconosciuto. Step non eseguito: scegli un ref corrente dai candidati o ripeti un peek mirato.');
      error.name='StaleRef';error.cortexRecovery={action:'refresh_ref',failedStepExecuted:false,candidates};throw error;
    }
  }
  if(isAction) {
    const matches=await l.count();
    if(matches>1) {
      let candidates=[];
      try{candidates=await describeMatches(p,l,matches,t());}catch{/* Preserve the original ambiguity if the document changes. */}
      const error=fail(`Target ambiguo (${matches} elementi). Step non eseguito. Scegli il ref corretto dai candidati o da un peek mirato; non ripetere gli step completati.`);
      error.name='AmbiguousTarget';error.cortexAmbiguity={matches,candidates,failedStepExecuted:false,...(matches>candidates.length?{moreCandidates:true}:{})};throw error;
    }
  }
  if(isAction&&s.scopeRef) {
    if(!pinned)pinned=await l.elementHandle({timeout:t()});
    const valid=pinned&&await pinned.evaluate((e,{scope,id})=>{
      const root=e.closest(scope);return root?.isConnected&&document[Symbol.for('cortex.refs')]?.refs.get(id)?.deref()===root;
    },{scope:s.scope,id:s.scopeRef});
    if(!valid)throw fail('Scope each sostituito o rimosso.');
  }
  const actor=isAction&&pinned?pinned:l;
  if (s.op === 'expect_count') { await until(async()=>await l.count() === s.count,t()); return; }
  if (['wait','expect_hidden','expect_visible'].includes(s.op)) {
    const state = s.op === 'wait' ? s.state || 'visible' : s.op === 'expect_hidden' ? 'hidden' : 'visible';
    if (state === 'enabled' || state === 'disabled') await until(async remaining=>await l.count() === 1 && await l.isEnabled({timeout:remaining}) === (state === 'enabled'),t());
    else await l.waitFor({state,timeout:t()});
    return;
  }
  if (s.op === 'expect_text' || s.op === 'expect_value') {
    await until(async remaining=> {
      if (await l.count() !== 1) return false;
      return s.op === 'expect_text' ? (await l.innerText({timeout:Math.min(remaining,1000)})).includes(s.value || '') : await l.inputValue({timeout:Math.min(remaining,1000)}) === s.value;
    },t()); return;
  }
  if (s.op === 'click' || s.op === 'press' || s.op==='expand') {
    await l.waitFor({state:'attached',timeout:t()});
    const label = await l.evaluate(e=>[e.textContent,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('value'),...Array.from(e.querySelectorAll('img')).flatMap(i=>[i.alt,i.title])].join(' '),undefined,{timeout:t()});
    if (!allowDestructive && sensitive(`${s.target} ${label}`)) throw fail('Possibile azione sensibile; richiede autorizzazione esplicita.');
  }
  if(s.op==='expand') {
    const state=await l.evaluate(e=>({expanded:e.getAttribute('aria-expanded'),selected:e.getAttribute('aria-selected'),controls:e.getAttribute('aria-controls'),details:e.matches('summary')?e.parentElement?.open:null}),undefined,{timeout:t()});
    if(state.expanded==='true'||state.selected==='true'||state.details===true)return;
    if(state.expanded===null&&state.selected===null&&state.details===null&&!state.controls)throw fail('Espansione senza stato verificabile: usare click e assert espliciti.');
    await actor.click({timeout:t()});
    await until(remaining=>l.evaluate(e=>e.getAttribute('aria-expanded')==='true'||e.getAttribute('aria-selected')==='true'||e.matches('summary')&&e.parentElement?.open===true||Boolean(e.getAttribute('aria-controls')?.split(/\s+/).some(id=>document.getElementById(id)?.getClientRects().length)),undefined,{timeout:remaining}),t());return;
  }
  if(s.op==='hover')await actor.hover({timeout:t()});
  else if(s.op==='focus')await actor.focus({timeout:t()});
  else if(s.op==='scroll')await actor.evaluate((e,delta)=>e.scrollBy({left:delta.x,top:delta.y,behavior:'instant'}),{x:s.x??0,y:s.y??0},{timeout:t()});
  else if (s.op === 'click') {
    if (s.popup) {
      const owner=typeof p.page==='function'?p.page():p;
      const popup = owner.waitForEvent('popup',{timeout:t()});
      await Promise.all([popup,actor.click({timeout:t()})]);
      await (await popup).waitForLoadState('domcontentloaded',{timeout:t()});
    } else await actor.click({timeout:t()});
  } else if (s.op === 'fill') await actor.fill(s.value || '',{timeout:t()});
  else if (s.op === 'select') await actor.selectOption({label:s.value || ''},{timeout:t()});
  else if (s.op === 'press') await actor.press(s.value || 'Enter',{timeout:t()});
  else if (s.op === 'check') await actor.check({timeout:t()});
  else if (s.op === 'uncheck') await actor.uncheck({timeout:t()});
  } finally {if(pinned)await pinned.dispose().catch(()=>{});}
}

export function createCortexEngine({getSession,selectPage,screenshotPath,captureScreenshot,proxyFactory=createCortexProxy,resolveConfig=configFor,features=resolveFeatures({env:{}}),budget=createBudget()}) {
  let revision = 0, currentConfig, active = false, lastFailure = null, queue = Promise.resolve();
  let proxyPromise=null,callDeadline=Infinity;
  const refHints=new Map(),pendingRequests=new WeakMap();
  const contexts = new WeakSet(), watched = new WeakSet(), owned = new WeakSet(), blockedPages = new WeakSet(), responsePolicies = new WeakMap(), errors = [];
  const definitions=[...structuredClone(cortexToolDefinitions),...extendedDefinitions(features)];
  if(features.modules.includes('diagnostic'))definitions.find(d=>d.name==='cortex_open').inputSchema.properties.capture={type:'boolean'};
  if(features.modules.length) {
    definitions.find(d=>d.name==='cortex_debug').inputSchema.properties.operationId={type:'string',minLength:1,maxLength:128};
    definitions.find(d=>d.name==='cortex_debug').inputSchema.properties.pages={type:'boolean'};
  }
  let extensions=null;
  const operationLedger=new OperationLedger(budget);
  const extended=()=>extensions??=createExtensions({features,budget,origins:()=>currentConfig.origins,locate,peek,documentFor,operationLedger});
  const push = entry => {
    // Repeated background failures must not evict useful diagnostic categories.
    const index=errors.findIndex(previous=>previous.type===entry.type&&previous.status===entry.status);
    if(index>=0){const [previous]=errors.splice(index,1);entry={...entry,count:(previous.count||1)+1};}
    errors.push(entry);if(errors.length>30)errors.shift();
  };
  function watch(p) {
    if(features.modules.length)extended().watch(p);
    if (watched.has(p)) return;
    watched.add(p);
    const requests=new Set();pendingRequests.set(p,requests);
    p.on('request',r=>{if(['xhr','fetch'].includes(r.resourceType()))requests.add(r);});
    p.on('requestfinished',r=>requests.delete(r));p.on('requestfailed',r=>requests.delete(r));
    p.on('pageerror',()=>push({type:'pageerror'}));
    p.on('console',m=>{if(m.type() === 'error') push({type:'console'});});
    p.on('requestfailed',()=>push({type:'network'}));
    p.on('response',r=>{if(r.status() >= 400) push({type:'http',status:r.status()});});
  }
  async function responsePolicy(p) {
    if(!responsePolicies.has(p)) {
      const pending=(async()=>{
      // Chromium/Playwright skips the route callback for redirected requests.
      // Check Location BEFORE the browser follows it, including chained redirects.
      const cdp=await p.context().newCDPSession(p);
      cdp.on('Fetch.requestPaused',event=>{
        void (async()=>{
          const location=event.responseHeaders?.find(h=>h.name.toLowerCase()==='location')?.value;
          if(active && event.responseStatusCode>=300 && event.responseStatusCode<400 && location) {
            let destination='';
            try {destination=new URL(location,event.request.url).href;} catch { /* fail closed */ }
            if(!permitted(destination,currentConfig.origins)) {
              blockedPages.add(p);push({type:'blocked_redirect'});
              await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;
            }
          }
          await cdp.send('Fetch.continueResponse',{requestId:event.requestId});
        })().catch(()=>{}); // A page/context close also invalidates paused requests.
      });
      try {await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Response'}]});}
      catch(error) {await cdp.detach().catch(()=>{});throw error;}
      p.once('close',()=>{void cdp.detach().catch(()=>{});});
      return cdp;
      })();
      responsePolicies.set(p,pending);
      void pending.catch(()=>{if(responsePolicies.get(p)===pending)responsePolicies.delete(p);});
    }
    return responsePolicies.get(p);
  }
  async function guard(session) {
    owned.add(session.page); watch(session.page);
    await responsePolicy(session.page);
    if (contexts.has(session.context)) return;
    contexts.add(session.context);
    session.context.on('page',p=>{
      if(active) { watch(p);void responsePolicy(p).catch(()=>push({type:'policy_error'})); }
      void p.opener().then(opener=>{
        if (active && opener && owned.has(opener)) { owned.add(p); watch(p); selectPage(session.target,p); }
      }).catch(()=>{});
    });
    await session.context.route('**/*',async route=>{
      const request = route.request();
      if (!active) return route.fallback();
      // The very first popup request can have no frame/page yet. Validate its
      // origin before trying to attribute it, otherwise it bypasses the guard.
      if (!permitted(request.url(),currentConfig.origins)) {
        try {if(request.isNavigationRequest()) blockedPages.add(request.frame().page());} catch { /* popup frame not created yet */ }
        push({type:'blocked_request'});return route.abort('blockedbyclient');
      }
      let p;
      try { p = request.frame().page(); } catch { return route.fallback(); }
      if (!owned.has(p)) {
        const opener = await p.opener();
        if (!opener || !owned.has(opener)) return route.fallback();
        owned.add(p); watch(p);
      }
      try { await responsePolicy(p); }
      catch {push({type:'policy_error'});return route.abort('blockedbyclient').catch(()=>{});}
      // Exact Cortex origins govern this flow, including cross-origin redirects and assets.
      return route.continue();
    });
  }
  async function inScope(p) {
    if(blockedPages.has(p)) throw fail('Navigazione esterna agli origin consentiti bloccata.');
    if (p.url() === 'about:blank') return;
    if (!permitted(p.url(),currentConfig.origins)) throw fail('Navigazione esterna agli origin consentiti bloccata.');
  }
  async function session(checkScope=true) {
    if(!proxyPromise) {
      const pending=Promise.resolve().then(()=>proxyFactory(()=>push({type:'blocked_proxy'})));
      proxyPromise=pending;
      void pending.catch(()=>{if(proxyPromise===pending)proxyPromise=null;});
    }
    const proxy=await proxyPromise;proxy.setPolicy(true,currentConfig.origins);
    const s = await getSession({...currentConfig.launch,proxy:proxy.proxy});
    if(!s.cortexProxy) throw fail('Chiudere il browser legacy o CDP e avviare Cortex prima, per attivare la policy di rete.');
    await guard(s); if(checkScope) await inScope(s.page); return s;
  }
  async function documentFor(p,frame,timeout=timeLeft(callDeadline,8000)) {
    if(!frame)return p;
    const locator=p.locator(frame);
    if(await locator.count()!==1)throw fail('Iframe assente o ambiguo.');
    const handle=await locator.elementHandle({timeout});
    const document=await handle.contentFrame();await handle.dispose();
    if(!document)throw fail('Iframe non disponibile.');
    await inScope(document);return document;
  }
  async function peek(p,options={}) {
    const {frame,...projection}=options;
    const deadline=Math.min(callDeadline,performance.now()+(options.timeout||8000));
    const doc=await documentFor(p,frame,timeLeft(deadline));
    const owner=typeof doc.page==='function'?doc.page():doc;
    if(options.scope) {
      const count=await doc.locator(options.scope).count();
      if(count!==1)throw fail(count?`Scope ambiguo (${count} elementi). Usare un contenitore unico.`:'Scope non trovato (0 elementi). Omettere scope o usare un contenitore verificato.');
    }
    let data;
    for(let attempt=0;attempt<3;attempt++) {
      try {
      await doc.waitForLoadState('domcontentloaded',{timeout:timeLeft(deadline)});await inScope(doc);
      if(options.mode!=='candidates'&&options.waitForReady!==false) {
        await until(()=>!(pendingRequests.get(owner)?.size),timeLeft(deadline));
        await doc.waitForFunction(scope=>{
          const visible=e=>Boolean(e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');
          const root=scope?document.querySelector(scope):[...document.querySelectorAll('[role="dialog"],dialog[open],.modal.show,.modal.in')].find(visible)||document.querySelector('main')||document.body;
          const busy=root&&[root,...root.querySelectorAll('[aria-busy="true"]')].some(e=>e.matches('[aria-busy="true"]')&&visible(e));
          return !busy&&!(globalThis.jQuery?.active>0);
        },options.scope,{timeout:timeLeft(deadline)});
      }
      data=await doc.evaluate(readCortexPage,{...projection,prefix:'s'+(++revision)});timeLeft(deadline);break;
      }
      catch(error) {
        if(/CortexScopeStale/.test(error.message))throw fail('Scope each sostituito o rimosso durante la lettura.');
        if(/CortexScopeMissing/.test(error.message))throw fail('Scope non trovato (0 elementi). Omettere scope o usare un contenitore CSS verificato.');
        const ambiguousScope=error.message.match(/CortexScopeAmbiguous:(\d+)/);
        if(ambiguousScope)throw fail(`Scope ambiguo (${ambiguousScope[1]} elementi). Restringere scope; per gruppi ripetuti usare items o each.`);
        if(/CortexFieldAmbiguous/.test(error.message))throw fail('Campo ambiguo: restringere il selettore.');
        if(attempt===2||!/execution context was destroyed|cannot find context with specified id/i.test(error.message))throw error;
      }
    }
    await inScope(doc);
    const clean=value=>typeof value==='string'?redact(value):Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])):value;
    const cleaned=clean(data);
    if(options.waitForReady===false){cleaned.pending=true;cleaned.incomplete=true;}
    for(const control of [...(cleaned.controls||[]),...(cleaned.candidates||[])])refHints.set(control.ref,control);
    while(refHints.size>5000)refHints.delete(refHints.keys().next().value);
    return {url:safeUrl(doc.url()),...cleaned};
  }
  async function observe(p,options,tool) {
    try { return {state:await peek(p,options)}; }
    catch(error) {
      const observationError=errorInfo(error);
      lastFailure={tool,phase:'observation',error:observationError};
      return {observationError};
    }
  }
  async function describeMatches(doc,locator,matches,timeout) {
    const deadline=Math.min(callDeadline,performance.now()+timeout);
    const handles=[];
    try {
      for(let index=0;index<Math.min(matches,5);index++) {
        const handle=await locator.nth(index).elementHandle({timeout:timeLeft(deadline,1000)});if(handle)handles.push(handle);
      }
      const data=await peek(doc,{mode:'candidates',nodes:handles,timeout:timeLeft(deadline)});return data.candidates;
    } finally {await Promise.all(handles.map(handle=>handle.dispose().catch(()=>{})));}
  }
  async function describeMissing(doc,step,id,timeout) {
    const hint=refHints.get(id);
    const data=await peek(doc,{mode:'recovery',action:step.op,hint:hint?.name||'',limit:5,timeout});
    return data.controls;
  }
  async function invoke(name,args,{signal}={}) {
    const definition = definitions.find(t=>t.name===name);
    let completed=0, failurePage=null, validated=false,actions=0,innerFailure=null,atomicContext=null,watchdog,aborting,timedOut=false;
    callDeadline=performance.now()+60000;
    const collected=[];
    let cancellation=Promise.resolve(),flowPages=null,operation=null;
    const cancelled=()=>{const error=fail('Operazione annullata; verificare lo stato prima di riprendere.');error.name='AbortError';return error;};
    const checkCancelled=()=>{if(signal?.aborted)throw cancelled();};
    const onAbort=()=>{const pages=flowPages?flowPages():failurePage?[failurePage]:[];cancellation=Promise.all(pages.filter(page=>!page.isClosed()).map(page=>page.close().catch(()=>{})));};
    const success=body=>{checkCancelled();const response=result({...body,...(operation?{operationId:operation.id}: {})});if(operation)extended().ledger.finish(operation.id,response);return response;};
    signal?.addEventListener('abort',onAbort,{once:true});
    try {
      checkCancelled();
      validate(args,definition.inputSchema);
      const validateFields=fields=>{
        if(fields&&new Set(fields.map(f=>f.name)).size!==fields.length)throw fail('Nomi dei campi duplicati.');
        if(fields?.some(f=>['constructor','prototype','ref','truncatedFields'].includes(f.name)))throw fail('Nome campo riservato.');
      };
      if(name==='cortex_peek') {
        validateFields(args.fields);
        if(args.mode==='extract'&&(!args.items||!args.fields))throw fail('Estrazione: specificare items CSS e fields.');
      }
      if (name==='cortex_run') args={...args,steps:args.steps.map(normalizeStep)};
      if (name==='cortex_run') for(const [index,step] of args.steps.entries()) {
        try {
          for(const s of [step,...(step.steps||[])]) {
            if(!['expect_url','resize'].includes(s.op)&&!s.target||s.op==='expect_count'&&s.count===undefined)throw fail('Step incompleto.');
            if(s.op==='resize'&&(!s.width||!s.height||s.width*s.height>4000000))throw fail('Resize richiede width/height entro 4 megapixel.');
            if(['expect_url','expect_text','expect_value','select'].includes(s.op)&&s.value===undefined)throw fail('Valore atteso mancante.');
            if(s.op==='expect_url'&&!s.value.trim())throw fail('URL atteso vuoto: specificare una destinazione verificabile.');
            validateFields(s.fields);
            if(['each','extract'].includes(s.op)&&(!s.target?.startsWith('css:')||s.withinRow))throw fail('each/extract richiedono target CSS.');
            if(s.op==='extract'&&!s.fields)throw fail('Estrazione senza fields.');
            if(s.op==='each'&&(!s.steps||s.limit>50))throw fail('each richiede steps e limit massimo 50.');
            if(s.op!=='each'&&s.steps)throw fail('steps annidati ammessi solo in each.');
          }
          if(step.steps?.some(s=>s.frame||s.scope||s.popup||s.op==='expect_url'))throw fail('each opera nello stesso scope/frame, senza popup o navigazioni attese.');
        }catch(error){error.cortexFailedAt=index+1;throw error;}
      }
      validated=true;
      if((name==='cortex_run'&&(args.operationId||features.modules.length))||name==='cortex_evaluate') {
        operation=extended().ledger.begin(args.operationId,args);
        if(operation.replay) {
          if(operation.record.response)return structuredClone(operation.record.response);
          return result({ok:false,operationId:operation.id,error:{kind:'ExecutionUncertain',message:'Operazione già registrata: nessun replay.'},operation:extended().ledger.get(operation.id)},true);
        }
      }
      currentConfig = await resolveConfig(args.project_path);
      checkCancelled();
      if (name==='cortex_open' && !permitted(args.url,currentConfig.origins)) throw fail('Origin non consentito: configura CORTEX_ALLOWED_ORIGINS.');
      active=true;
      let s=await session(name!=='cortex_open' && name!=='cortex_debug'), p=s.page;
      if(args.pageId)p=await extended().select(s.context,args.pageId);
      failurePage=p;
       if(signal?.aborted){onAbort();throw cancelled();}
      const initialPages=new Set(s.context.pages());
      flowPages=()=>s.context.pages().filter(page=>page===failurePage||!initialPages.has(page));
      watchdog=setTimeout(()=>{timedOut=true;aborting=Promise.all(s.context.pages().filter(page=>page===failurePage||!initialPages.has(page)).map(page=>page.close().catch(()=>{})));},timeLeft(callDeadline,60000));watchdog.unref?.();
      if(extendedDefinitions(features).some(tool=>tool.name===name)) {
        if(operation)extended().capture.operation=operation.id;
        const response=await extended().call(name,args,{page:p,context:s.context,signal,onDispatch:()=>operation&&extended().ledger.dispatch(operation.id)});
        if(operation)extended().ledger.finish(operation.id,response,response.structuredContent.data.executionState??'completed');
        return response;
      }
      if (name==='cortex_open') {
        if(args.capture)extended().capture.start(s.context,{});
          // A denied popup may still be committing its error document. Explicit
          // open replaces that navigation, including before the popup has a URL.
          const oldCdp=await responsePolicy(p);
          let recover=blockedPages.has(p) || p.url()==='about:blank' || !permitted(p.url(),currentConfig.origins) || lastFailure?.tool==='cortex_open';
          try { await oldCdp.send('Page.stopLoading'); }
          catch(error) {
            // Chromium can replace the renderer target while creating an error
            // document. The Page survives but its previous CDP session is stale.
            if(!/not attached to an active page/i.test(error.message)) throw error;
            recover=true;
          }
          if(recover) {
          // An aborted redirect can still be committing Chromium's error document.
          // Cancel it and wait for a blank document before starting another navigation;
          // keep the same page/context so cookies and per-tab sessionStorage survive.
          await oldCdp.detach().catch(()=>{});responsePolicies.delete(p);
          for(let attempt=0;attempt<3;attempt++) {
            try {await p.goto('about:blank',{waitUntil:'load',timeout:8000});break;}
            catch(error) {if(attempt===2) throw error;}
          }
          await responsePolicy(p);
        }
        blockedPages.delete(p);
        await p.goto(args.url,{waitUntil:'domcontentloaded',timeout:25000});await inScope(p);
        lastFailure=null;
          const observation=args.observe ? await observe(p,{limit:15},name) : {};
          return success({ok:true,url:safeUrl(p.url()),...observation});
      }
      if (name==='cortex_peek') return success({ok:true,...await peek(p,args)});
      if (name==='cortex_debug') {
        if(args.operationId)return success({ok:true,operation:extended().ledger.get(args.operationId)});
        let screenshotLocal=null;
        if(args.screenshot) {
          await inScope(p);
          const filename=currentConfig.artifacts ? path.join(currentConfig.artifacts,`cortex-${randomUUID()}.png`) : screenshotPath('cortex');
          await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
          // Explicit screenshot artifacts can include visible business data; never inline.
          await captureScreenshot(p,filename);screenshotLocal=filename;
        }
        return success({ok:true,url:safeUrl(p.url()),errors:errors.slice(-5),lastFailure,screenshotLocal,
          ...(args.pages?{pages:s.context.pages().filter(page=>!page.isClosed()).map(page=>({...extended().identity(page),url:safeUrl(page.url()),selected:page===p}))}:{})});
      }
      const started=performance.now(), deadline=callDeadline;
      let incomplete=false,readChars=0;
      const runAtomic=async(step,scope,frame)=>{
        checkCancelled();
        const timeout=Math.min(step.timeout||8000,Math.floor(deadline-performance.now()));
        if(timeout<=0)throw fail('Timeout complessivo del batch (60 secondi).');
        if(++actions>200)throw fail('Limite complessivo di 200 azioni raggiunto.');
        if(readChars>=18000)throw fail('Limite raccolta raggiunto: continuare con una lettura mirata.');
        const scopeRef=scope?.match(/^\[data-cortex-ref="(s\d+-e\d+)"\]$/)?.[1];
        const effective={...step,...(scope?{scope,scopeRef}:{})},selectedFrame=step.frame||frame;
        const stepDeadline=Math.min(deadline,performance.now()+timeout);
        const doc=await documentFor(p,selectedFrame,timeLeft(stepDeadline));
        atomicContext={doc,step:effective,timeout,frame:selectedFrame};
        if(operation){extended().ledger.dispatch(operation.id,{step:completed+1,op:step.op});extended().capture.operation=operation.id;}
        if(effective.scope) {
          const anchor=doc.locator(effective.scope),count=await anchor.count();
          if(count!==1)throw fail(count?'Scope ambiguo: specificare un contenitore unico.':'Scope non trovato o rimosso.');
          if(scope&&!await anchor.evaluate(e=>document[Symbol.for('cortex.refs')]?.refs.get(e.getAttribute('data-cortex-ref'))?.deref()===e,undefined,{timeout:timeLeft(stepDeadline)}))throw fail('Scope each sostituito o rimosso.');
        }
        if(step.op==='extract') {
          const value=await peek(p,{mode:'extract',scope:effective.scope,expectedScopeRef:scopeRef,frame:selectedFrame,items:step.target.slice(4),fields:step.fields,offset:step.offset,limit:step.limit,waitForReady:step.waitForReady,timeout:timeLeft(stepDeadline),maxChars:Math.min(8000,18000-readChars)});
          readChars+=JSON.stringify(value.records).length;
          incomplete ||= Boolean(value.incomplete);
          if(operation)operation.record.steps.at(-1).state='completed';
          return {records:value.records,total:value.total,...(value.nextOffset!==undefined?{nextOffset:value.nextOffset}:{}),...(value.incomplete?{incomplete:true}:{})};
        }
        await execute(doc,effective,Boolean(args.allowDestructive),timeLeft(stepDeadline),describeMatches,describeMissing);
        if(operation)operation.record.steps.at(-1).state='completed';
        checkCancelled();
        if(scopeRef) {
          const anchor=doc.locator(scope);
          if(await anchor.count()!==1||!await anchor.evaluate((e,id)=>e.isConnected&&document[Symbol.for('cortex.refs')]?.refs.get(id)?.deref()===e,scopeRef,{timeout:timeLeft(stepDeadline)}))throw fail('Scope each sostituito o rimosso.');
        }
        s=await session();p=s.page;failurePage=p;
      };
      for(const step of args.steps) {
        checkCancelled();
        if(step.op==='each') {
          const frame=step.frame||args.frame;
          const selection=await peek(p,{mode:'refs',scope:step.scope,frame,items:step.target.slice(4),fields:step.fields||[],limit:step.limit||20,offset:step.offset,waitForReady:step.waitForReady,timeout:Math.min(step.timeout||8000,timeLeft(deadline))});
          const groups=[];
          const collection={step:completed+1,groups,total:selection.total,...(selection.nextOffset!==undefined?{nextOffset:selection.nextOffset}:{}),...(selection.incomplete?{incomplete:true}:{})};
          collected.push(collection);
          for(const [index,item] of selection.records.entries()) {
            innerFailure={itemIndex:(step.offset||0)+index+1,innerStep:1};
            const scope=`[data-cortex-ref="${item.ref}"]`,data=[];
            const {ref,...fields}=item;
            groups.push({...fields,data});
            const doc=await documentFor(p,frame,timeLeft(deadline));
            atomicContext={doc,step:{op:'each',target:`ref:${item.ref}`},timeout:Math.min(step.timeout||8000,timeLeft(deadline)),frame};
            const valid=await doc.locator(scope).count()===1&&await doc.locator(scope).evaluate((e,ref)=>document[Symbol.for('cortex.refs')]?.refs.get(ref)?.deref()===e,item.ref,{timeout:Math.min(step.timeout||8000,timeLeft(deadline))});
            if(!valid)throw fail('Elemento each sostituito: ripetere una lettura mirata.');
            for(const [inner,child] of step.steps.entries()) {
              innerFailure={itemIndex:(step.offset||0)+index+1,innerStep:inner+1};
              const value=await runAtomic(child,scope,frame);if(value)data.push(value);
            }
            innerFailure=null;
          }
          incomplete ||= Boolean(selection.incomplete);
        }else {
          const value=await runAtomic(step,undefined,args.frame);if(value)collected.push({step:completed+1,...value});
        }
        // Stop before another top-level operation; never silently replay actions.
        completed++;
        if(JSON.stringify(collected).length>24000){incomplete=true;break;}
      }
      lastFailure=null;
      const observation=args.observeAfter ? await observe(p,{limit:12,frame:args.frame},name) : {};
      return success({ok:true,completed,ms:Math.round(performance.now()-started),url:safeUrl(p.url()),...(collected.length?{data:collected}:{}),...(incomplete?{incomplete:true}:{}),...observation});
    } catch(e) {
      if(signal?.aborted)e=cancelled();
      if(timedOut){e=fail('Budget di 60 secondi superato: pagine del flusso chiuse per interrompere le operazioni.');e.name='TimeoutError';}
      const failedIndex=e.cortexFailedAt ? e.cortexFailedAt-1 : completed;
      const op=args?.steps?.[failedIndex]?.op;
      const body={ok:false,phase:!validated?'validation':name==='cortex_peek'?'read':'execution',...(name==='cortex_run'?{completed,failedAt:e.cortexFailedAt || completed+1,...(operations.includes(op)?{op}:{}),...(innerFailure||{}),...(collected.length?{data:collected}:{}),...(e.cortexAmbiguity?{ambiguity:e.cortexAmbiguity}:{}),...(e.cortexRecovery?{recovery:e.cortexRecovery}:{})}:{}),error:errorInfo(e)};
      lastFailure={tool:name,...body};
      const step=atomicContext?.step||args?.steps?.[failedIndex];
      if(validated && name==='cortex_run' && typeof step?.target==='string' && failurePage && !failurePage.isClosed()) {
        const kind=step.target.split(':',1)[0];
        lastFailure.locator={type:['ref','role','label','placeholder','text','testid','css'].includes(kind)?kind:'invalid',timeout:atomicContext?.timeout||step.timeout||8000,...(atomicContext?.frame?{inFrame:true}:{}),...(step.scope?{scoped:true}:{})};
        try { lastFailure.locator.matches=await locate(atomicContext?.doc||failurePage,step.target,step.withinRow,step.scope).count(); } catch {lastFailure.locator.contextUnavailable=true;}
      }
      if(operation){
        const notStarted=!validated||Boolean(e.cortexAmbiguity||e.cortexRecovery)||operation.record.executionState==='not-started';
        const previousEffects=completed>0||operation.record.steps.some(step=>step.state==='completed');
        body.operationId=operation.id;body.failedStepExecutionState=notStarted?'not-started':'unknown';body.executionState=notStarted?(previousEffects?'failed':'not-started'):'unknown';body.effects=notStarted&&!previousEffects?'none-known':'possible';
        if(operation.record.steps.at(-1)?.state==='dispatched')operation.record.steps.at(-1).state=body.failedStepExecutionState;
        const response=result(body,true);extended().ledger.finish(operation.id,response,body.executionState);return response;
      }
      return result(body,true);
    } finally {if(extensions)extensions.capture.operation=null;signal?.removeEventListener('abort',onAbort);clearTimeout(watchdog);if(aborting)await aborting;await cancellation;}
  }
  return {
    definitions,
    async prepare(args) {
      validate(args,definitions.find(tool=>tool.name==='cortex_open').inputSchema);
      currentConfig=await resolveConfig(args.project_path);
      if(!permitted(args.url,currentConfig.origins))throw fail('Origin non consentito.');
      active=true;callDeadline=performance.now()+30000;return session(false);
    },
    has:name=>definitions.some(t=>t.name===name),
    suspend:async()=>{active=false;const proxy=await proxyPromise?.catch(()=>null);proxy?.setPolicy(false);},
    close:async({idle=false}={})=>{
      if(extensions){await extensions.close({preserveLedger:idle});extensions=null;}
      if(!idle)operationLedger.close();
      active=false;const pending=proxyPromise;proxyPromise=null;const proxy=await pending?.catch(()=>null);
      if(proxy)try {await proxy.close();}catch(error) {if(!proxyPromise)proxyPromise=pending;throw error;}
    },
    call(name,args={},options={}) {
      // Concurrent MCP calls cannot interleave batches, policy changes or peek revisions.
      const next=queue.then(()=>invoke(name,args,options));queue=next.catch(()=>{});return next;
    }
  };
}

export function createCortex(options) {return createCortexSessionBroker(options,createCortexEngine);}
