import { randomUUID } from 'node:crypto';
import { result } from '../core/cortex-utils.js';
import { extendedDefinitions, domainError, instrumentation } from './contracts.js';
import { BoundedStore } from './store.js';
import { CaptureCollector } from './capture.js';
import { observe, inspect } from './visual.js';
import { evaluate, OperationLedger } from './execution.js';
import { design } from './design.js';
import { Devtools } from './devtools.js';

export function createExtensions({features,budget,origins,locate,peek,documentFor,operationLedger}) {
  const definitions=extendedDefinitions(features),pages=new Map(),identities=new WeakMap();
  const snapshots=new BoundedStore({budget}),profiles=new BoundedStore({budget,maxEntries:10,maxBytes:1048576});
  const ledger=operationLedger??new OperationLedger(budget),devtools=new Devtools(features,budget);
  const identity=page=>{
    let record=identities.get(page);
    if(!record){record={pageId:randomUUID(),documentEpoch:1};identities.set(page,record);pages.set(record.pageId,page);
      page.on('framenavigated',frame=>{if(frame===page.mainFrame())record.documentEpoch++;});
      page.once('close',()=>pages.delete(record.pageId));}
    return {...record};
  };
  const capture=new CaptureCollector({budget,pageIdentity:identity,origins});
  const pack=(data,warnings=[],images=[])=>{
    const body={ok:true,contractVersion:1,data,coverage:{scope:'requested-target',complete:false,reasons:['best-effort-backend']},warnings};
    if(Buffer.byteLength(JSON.stringify(body))>65536)throw domainError('BudgetExceeded','Risposta strutturata oltre 64 KiB; restringere lettura o paginazione.');
    const response=result(body);response.content.push(...images);return response;
  };
  return {
    definitions,ledger,capture,identity,snapshots,
    has:name=>definitions.some(d=>d.name===name),
    watch:page=>identity(page),
    async select(context,pageId) {
      const page=pages.get(pageId);if(!page||page.isClosed()||page.context()!==context)throw domainError('StaleObservation','pageId non disponibile o estraneo alla sessione.');
      return page;
    },
    async call(name,args,{page,context,signal,onDispatch}) {
      identity(page);
      if(args.pageId)page=await this.select(context,args.pageId);
      if(name==='cortex_capture')return pack(capture.call(context,args));
      if(name==='cortex_design')return pack(design({args,snapshots,profiles,features}));
      const doc=await documentFor(page,args.frame);
      if(args.frame&&['cortex_evaluate','cortex_devtools'].includes(name))throw domainError('UnsupportedCapability','Script/DevTools su frame richiedono adapter target/epoch dedicato; usare pagina top-level.');
      const options={page,doc,args,identity,snapshots,peek,locate,features,signal,onDispatch};
      if(name==='cortex_observe'){const {data,warnings,images}=await observe(options);return pack(data,warnings,images);}
      if(name==='cortex_inspect'){const {data,warnings}=await inspect(options);return pack(data,warnings);}
      if(name==='cortex_evaluate'){const data={...await evaluate(options),operationId:args.operationId};const response=pack(data);if(data.executionState!=='completed')response.isError=true;return response;}
      if(name==='cortex_devtools')return pack(await devtools.call(page,doc,args));
      throw domainError('UnsupportedCapability','Tool non disponibile.');
    },
    pack,
    async close({preserveLedger=false}={}){capture.close();snapshots.close();profiles.close();if(!preserveLedger)ledger.close();await devtools.close();pages.clear();}
  };
}
