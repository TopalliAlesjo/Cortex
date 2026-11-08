import { createCortex } from './core/cortex.js';
import { createConfigResolver } from './config/resolve.js';
import { createPlaywrightProvider } from './browser/playwright-provider.js';
import { captureScreenshot, screenshotPath } from './artifacts/screenshots.js';
import { fail, result, errorInfo } from './core/cortex-utils.js';
import { resolveFeatures, normalizeExtendedResult } from './extended/contracts.js';
import { createBudget } from './extended/store.js';
import { performance } from 'node:perf_hooks';

function failure(kind,message) {const error=fail(message);error.name=kind;return result({ok:false,error:errorInfo(error)},true);}
export function createCortexRuntime({projectPath,config,policy,env,browserProvider,sessionLimits,idleTimeoutMs=600000,maxPending=64}={}) {
  if(!Number.isInteger(maxPending)||maxPending<1||!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<0)throw fail('Limiti runtime non validi.');
  const provider=browserProvider??createPlaywrightProvider();
  const resolve=createConfigResolver({projectPath,config,policy,env});
  const features=resolveFeatures({config,policy,env}),budget=createBudget();
  const broker=createCortex({
    getSession:options=>provider.getSession(options),
    selectPage:(target,page)=>provider.selectPage(target,page),
    screenshotPath,captureScreenshot,sessionLimits,features,budget,
    resolveConfig:async project=>{
      const resolved=await resolve(project);
      provider.assertLaunch?.(resolved.launch);return resolved;
    }
  });
  const pending=[];
  const extendedNames=new Set(broker.definitions.filter(d=>d.outputSchema).map(d=>d.name));
  const adapt=(name,response)=>extendedNames.has(name)?normalizeExtendedResult(response):response;
  let active=null,pumping=false,idle=null,state='accepting',closePromise=null,drain=Promise.resolve();
  const clearIdle=()=>{clearTimeout(idle);idle=null;};
  async function release(idleRelease=false) {
    let failed=false;
    try {await provider.close();}catch {failed=true;}
    try {await broker.close({idle:idleRelease});}catch {failed=true;}
    if(failed)throw fail('Chiusura delle risorse Cortex non completata.');
  }
  function armIdle() {
    if(!idleTimeoutMs||state!=='accepting'||active||pending.length)return;
    idle=setTimeout(()=>{
      if(state!=='accepting'||active||pending.length)return;
      pumping=true;
      drain=release(true).catch(()=>{state='failed';for(const entry of pending.splice(0)){entry.signal?.removeEventListener('abort',entry.cancel);entry.resolve(failure('RuntimeClosed','Cleanup Cortex fallito.'));}}).finally(()=>{pumping=false;if(pending.length&&state==='accepting')void pump();});
    },idleTimeoutMs);idle.unref?.();
  }
  async function pump() {
    if(pumping)return;
    pumping=true;
    drain=(async()=>{
      while(pending.length&&state==='accepting') {
        const entry=pending.shift();
        entry.signal?.removeEventListener('abort',entry.cancel);
        if(entry.signal?.aborted) {entry.resolve(failure('AbortError','Operazione annullata prima dell’esecuzione.'));continue;}
        active=entry;
        const forward=()=>entry.controller.abort();
        entry.signal?.addEventListener('abort',forward,{once:true});
        try {
          const started=performance.now(),response=adapt(entry.name,await broker.call(entry.name,entry.args,{signal:entry.controller.signal}));
          if(response.structuredContent?.contractVersion===1){
            response.structuredContent.data.timing={queueMs:Math.round((started-entry.queuedAt)*100)/100,serverCallMs:Math.round((performance.now()-started)*100)/100};
            response.content=response.content.map(block=>block.type==='text'?{type:'text',text:JSON.stringify(response.structuredContent)}:block);
          }
          entry.resolve(response);
        }
        catch {entry.resolve(failure('Error','Operazione Cortex fallita.'));}
        finally {entry.signal?.removeEventListener('abort',forward);active=null;}
      }
    })();
    try {await drain;}finally {pumping=false;if(pending.length&&state==='accepting')void pump();else armIdle();}
  }
  return {
    definitions:structuredClone(broker.definitions),
    call(name,args={},options={}) {
      const immediate=response=>Promise.resolve(adapt(name,response));
      if(state!=='accepting')return immediate(failure('RuntimeClosed','Runtime Cortex non disponibile; creare una nuova istanza.'));
      if(!broker.has(name))return immediate(failure('UnknownTool','Tool Cortex non supportato.'));
      if(options.signal?.aborted)return immediate(failure('AbortError','Operazione annullata prima dell’esecuzione.'));
      if(pending.length>=maxPending)return immediate(failure('QueueFull','Coda Cortex piena; attendere il completamento delle richieste.'));
      clearIdle();
      let snapshot;try{snapshot=structuredClone(args);if(projectPath!==undefined&&snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)&&!Object.hasOwn(snapshot,'project_path'))snapshot.project_path=projectPath;}catch{return immediate(failure('Error','Argomenti non validi.'));}
      return new Promise(resolveCall=>{
        const entry={name,args:snapshot,signal:options.signal,resolve:response=>resolveCall(adapt(name,response)),controller:new AbortController(),queuedAt:performance.now()};
        entry.cancel=()=>{
          const index=pending.indexOf(entry);
          if(index>=0){pending.splice(index,1);entry.resolve(failure('AbortError','Operazione annullata prima dell’esecuzione.'));armIdle();}
        };
        entry.signal?.addEventListener('abort',entry.cancel,{once:true});
        pending.push(entry);void pump();
      });
    },
    close() {
      if(closePromise)return closePromise;
      state='draining';clearIdle();active?.controller.abort();
      for(const entry of pending.splice(0)) {
        entry.signal?.removeEventListener('abort',entry.cancel);
        entry.resolve(failure('RuntimeClosed','Runtime Cortex in chiusura.'));
      }
      closePromise=(async()=>{await drain;try{await release();state='closed';}catch(error){state='failed';throw error;}})();
      return closePromise;
    }
  };
}
