import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { result, errorInfo, fail, validateCortexArguments } from './cortex-utils.js';

const sessionKeys = ['sessionId', 'newSession', 'closeSession'];
const sessionIdSchema = {
  type:'string', minLength:1, maxLength:128, pattern:'^[A-Za-z0-9_-]+$',
  description:'ID restituito da newSession. Omettere per usare la sessione condivisa.'
};

function sessionFailure(message='Sessione isolata chiusa o scaduta; aprire una nuova sessione.') {
  const error=fail(message);error.name='SessionClosed';return error;
}

function projectKey(value) {
  if(typeof value!=='string' || !value || value.length>4096 || !path.isAbsolute(value))throw fail('project_path deve essere assoluto.');
  const resolved=path.resolve(value);
  return process.platform==='win32'?resolved.toLowerCase():resolved;
}

function connected(browser) {
  return Boolean(browser) && (typeof browser.isConnected!=='function' || browser.isConnected());
}

function withIdentity(response,id,closed=false) {
  let body=response?.structuredContent;
  if(!body) {
    try {body=JSON.parse(response?.content?.find(item=>item.type==='text')?.text);} catch { /* controlled error below */ }
  }
  if(!body || typeof body!=='object' || Array.isArray(body))throw fail('Risposta Cortex non valida.');
  const identified=result({...body,sessionId:id,isolated:true,...(closed?{closed:true}:{})},Boolean(response.isError));
  // Preserve ImageContent and any other non-text blocks across the session envelope.
  identified.content.push(...(response.content??[]).filter(item=>item.type!=='text'));
  return {...response,...identified};
}

/** Optional limits are private injection points for deterministic lifecycle tests. */
export function createCortexSessionBroker(options,createEngine,limits={}) {
  const {sessionLimits,...engineOptions}=options;
  const settings={...sessionLimits,...limits};
  const now=settings.now??Date.now, maxSessions=settings.maxSessions??4, ttlMs=settings.ttlMs??10*60*1000;
  if(typeof now!=='function' || !Number.isInteger(maxSessions) || maxSessions<1 || !Number.isFinite(ttlMs) || ttlMs<=0)throw fail('Limiti delle sessioni non validi.');
  let hostSession=null, queue=Promise.resolve(), closePromise=null, closeWasIdle=false;
  const sessions=new Map();
  const defaultEngine=createEngine({...engineOptions,getSession:async launchConfig=>{
    const session=await engineOptions.getSession(launchConfig);
    hostSession=session;return session;
  }});
  const definitions=defaultEngine.definitions.map(base=>{
    const definition=structuredClone(base);
    definition.inputSchema.properties.sessionId={...sessionIdSchema};
    if(definition.name==='cortex_open')definition.inputSchema.properties.newSession={
      type:'boolean',default:false,description:'Crea una sessione isolata (massimo 4); incompatibile con sessionId.'
    };
    if(definition.name==='cortex_debug')definition.inputSchema.properties.closeSession={
      type:'boolean',default:false,description:'Chiude il contesto isolato indicato da sessionId, senza avviare il browser.'
    };
    return definition;
  });
  const definitionByName=new Map(definitions.map(definition=>[definition.name,definition]));
  const enqueue=fn=>{
    const next=queue.then(fn);queue=next.catch(()=>{});return next;
  };
  const hostBrowser=()=>hostSession?.browser || hostSession?.context?.browser?.();

  function assertAvailable(record) {
    if(record.closed || !connected(record.browser) || record.context?.isClosed?.())throw sessionFailure();
  }

  function selectChildPage(record,target,page) {
    if(target!==record.target || record.closed || record.rejectedPages.has(page) || page.isClosed() || page.context()!==record.context)return;
    record.page=page;
  }

  function limitChildPages(record,page) {
    if(record.closed)return;
    const pages=record.context.pages().filter(candidate=>!candidate.isClosed() && !record.rejectedPages.has(candidate));
    if(pages.length<=3)return;
    record.rejectedPages.add(page);
    const closing=(async()=>{
      try {await page.close();}
      catch {if(!page.isClosed())record.closed=true;}
    })();
    record.pendingPageClosures.add(closing);
    void closing.finally(()=>record.pendingPageClosures.delete(closing));
  }

  async function childSession(record,launchConfig) {
    assertAvailable(record);
    if(!record.context) {
      // Never inherit the persistent root profile, cookies or its proxy policy.
      record.context=await record.browser.newContext({proxy:launchConfig.proxy,serviceWorkers:'block'});
      record.onContextClosed=()=>{record.closed=true;};
      record.onBrowserClosed=()=>{record.closed=true;};
      record.onPage=page=>limitChildPages(record,page);
      record.context.once('close',record.onContextClosed);
      record.context.on('page',record.onPage);
      record.browser.once('disconnected',record.onBrowserClosed);
      record.page=await record.context.newPage();
    }
    await Promise.all(record.pendingPageClosures);
    assertAvailable(record);
    if(!record.page || record.page.isClosed() || record.rejectedPages.has(record.page)) {
      const pages=record.context.pages().filter(page=>!page.isClosed() && !record.rejectedPages.has(page));
      record.page=pages.at(-1) || await record.context.newPage();
    }
    assertAvailable(record);
    return {browser:record.browser,context:record.context,page:record.page,cortexProxy:true,target:record.target};
  }

  async function dispose(record) {
    record.closed=true;
    let failed=false;
    try {if(record.context)await record.context.close();}catch {failed=true;}
    try {await record.engine.close();}catch {failed=true;}
    if(failed)throw fail('Chiusura della sessione isolata non completata.');
    record.context?.off?.('close',record.onContextClosed);
    record.context?.off?.('page',record.onPage);
    if(record.onBrowserClosed)record.browser.off?.('disconnected',record.onBrowserClosed);
    sessions.delete(record.id);
  }

  async function expire(time) {
    for(const record of sessions.values()) {
      if(record.closed || !connected(record.browser) || time-record.lastUsed>=ttlMs) {
        // A cleanup failure leaves a closed entry for the next cleanup attempt;
        // it never silently recreates a context or frees an occupied slot.
        try {await dispose(record);}catch { /* no raw close/proxy error output */ }
      }
    }
  }

  function boundArguments(record,args) {
    if(Object.hasOwn(args,'project_path') && projectKey(args.project_path)!==record.projectKey)throw fail('project_path diverso da quello della sessione isolata.');
    return {...args,...(record.projectPath!==undefined?{project_path:record.projectPath}:{})};
  }

  async function createChild(args,options) {
    const projectPath=Object.hasOwn(args,'project_path')?args.project_path:undefined;
    const boundProjectKey=projectPath!==undefined?projectKey(projectPath):null;
    if(sessions.size>=maxSessions)throw fail(`Limite di ${maxSessions} sessioni isolate raggiunto; chiudere una sessione.`);
    // prepare validates config/URL and initializes the host with the ROOT engine
    // proxy. A child proxy must never become the browser launch proxy.
    if(!connected(hostBrowser()))hostSession=await defaultEngine.prepare(args);
    const browser=hostBrowser();
    if(!connected(browser))throw sessionFailure('Browser non disponibile; aprire una nuova sessione.');
    const id=randomUUID();
    const record={id,target:`cortex:${id}`,browser,context:null,page:null,closed:false,
      projectPath,projectKey:boundProjectKey,lastUsed:now(),rejectedPages:new WeakSet(),pendingPageClosures:new Set()};
    record.engine=createEngine({...engineOptions,
      getSession:launchConfig=>childSession(record,launchConfig),
      selectPage:(target,page)=>selectChildPage(record,target,page)
    });
    sessions.set(id,record);
    let response, identified;
    try {
      response=await record.engine.call('cortex_open',args,options);
      identified=withIdentity(response,id);
    }
    catch(error) {response=result({ok:false,error:errorInfo(error)},true);}
    if(response?.isError || identified?.structuredContent?.ok===false) {
      try {await dispose(record);}catch {return withIdentity(response,id,true);}
      return response;
    }
    record.lastUsed=now();
    return identified;
  }

  async function invoke(name,args,options) {
    let selected;
    try {
      const definition=definitionByName.get(name);
      if(!definition)throw fail('Tool Cortex non supportato.');
      if(!args || typeof args!=='object' || Array.isArray(args))throw fail('Argomenti non validi.');
      const extended=sessionKeys.some(key=>Object.hasOwn(args,key));
      if(extended) {
        try {validateCortexArguments(args,definition.inputSchema);}
        catch(error) {
          return result({ok:false,phase:'validation',...(name==='cortex_run'?{completed:0,failedAt:error.cortexFailedAt||1}:{}),error:errorInfo(error)},true);
        }
      }
      if(args.newSession && args.sessionId)throw fail('newSession e sessionId non possono essere usati insieme.');
      if(args.closeSession && !args.sessionId)throw fail('closeSession richiede sessionId.');
      const {sessionId,newSession,closeSession,...baseArgs}=args;
      // Invalid envelope combinations above cannot close expired sessions either.
      await expire(now());
      if(newSession)return await createChild(baseArgs,options);
      if(!sessionId)return await defaultEngine.call(name,baseArgs,options);
      selected=sessions.get(sessionId);
      if(!selected)throw sessionFailure();
      assertAvailable(selected);
      const boundArgs=boundArguments(selected,baseArgs);
      if(closeSession) {
        await dispose(selected);
        return result({ok:true,sessionId,isolated:true,closed:true});
      }
      selected.lastUsed=now();
      const response=await selected.engine.call(name,boundArgs,options);
      selected.lastUsed=now();
      return !['cortex_peek','cortex_run'].includes(name)?withIdentity(response,sessionId):response;
    } catch(error) {
      const response=result({ok:false,error:errorInfo(error)},true);
      return selected && (name==='cortex_open' || name==='cortex_debug')?withIdentity(response,selected.id,selected.closed):response;
    }
  }

  return {
    definitions,
    has:name=>defaultEngine.has(name),
    suspend:()=>defaultEngine.suspend(),
    call(name,args={},options={}) {
      closePromise=null;
      return enqueue(()=>invoke(name,args,options));
    },
    legacy(fn) {
      closePromise=null;
      return enqueue(async()=>{
        await expire(now());
        await defaultEngine.suspend();
        return await fn();
      });
    },
    close(options={}) {
      if(closePromise&&closeWasIdle===Boolean(options.idle))return closePromise;
      closeWasIdle=Boolean(options.idle);
      closePromise=enqueue(async()=>{
        let failed=false;
        for(const record of sessions.values())try {await dispose(record);}catch {failed=true;}
        try {await defaultEngine.close(options);}catch {failed=true;}
        hostSession=null;
        if(failed)throw fail('Chiusura delle sessioni Cortex non completata.');
      });
      const closing=closePromise;
      void closing.catch(()=>{if(closePromise===closing)closePromise=null;});
      return closing;
    }
  };
}
