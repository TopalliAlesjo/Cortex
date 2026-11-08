import { createHash, randomUUID } from 'node:crypto';
import { domainError } from './contracts.js';
import { redactData } from '../core/cortex-utils.js';

export class OperationLedger {
  constructor(budget){this.budget=budget;this.records=new Map();this.bytes=0;}
  begin(id,args) {
    id??=randomUUID();
    const hash=createHash('sha256').update(JSON.stringify(args)).digest('hex'),known=this.records.get(id);
    if(known){if(known.hash!==hash)throw domainError('PolicyDenied','operationId già usato con argomenti differenti.');return {id,replay:true,record:known};}
    // Retain ID tombstones for the entire session; quota exhaustion never permits replay.
    if(this.records.size>=256)throw domainError('BudgetExceeded','Registro operazioni pieno; nessuna esecuzione effettuata.');
    const record={operationId:id,hash,executionState:'not-started',effects:'none-known',startedAt:Date.now(),steps:[]};
    this.budget.reserve(1024);this.bytes+=1024;this.records.set(id,record);return {id,replay:false,record};
  }
  dispatch(id,step){const record=this.records.get(id);if(!record)return;if(step){this.budget.reserve(256);this.bytes+=256;record.steps.push({...step,state:'dispatched'});}record.executionState='dispatched';}
  finish(id,response,state='completed') {
    const record=this.records.get(id);if(!record)return;
    record.executionState=state;record.finishedAt=Date.now();record.effects=state==='not-started'?'none-known':'possible';
    const bytes=Buffer.byteLength(JSON.stringify(response));
    if(bytes<=65536){try{this.budget.reserve(bytes);record.response=structuredClone(response);this.bytes+=bytes;}catch{record.resultUnavailable='quota';}}
    else record.resultUnavailable='result-size';
  }
  get(id){const record=this.records.get(id);if(!record)throw domainError('ExecutionUncertain','operationId sconosciuto in questa sessione; non ripetere implicitamente.');const {response,hash,...publicRecord}=record;return structuredClone(publicRecord);}
  close(){this.budget.release(this.bytes);this.bytes=0;this.records.clear();}
}

// Runs in the browser. Getters and toJSON are never invoked intentionally.
export async function executeScript({code,argument}) {
  const value=await new Function('argument','"use strict";return (async()=>{'+code+'\n})();')(argument);
  const seen=new WeakMap(),encoder=new TextEncoder();let remaining=250,bytesLeft=32768;
  // Charge primitives, keys and conservative container overhead while still in
  // the renderer. Never transfer an over-budget value over the Playwright lane.
  const charge=value=>{bytesLeft-=encoder.encode(JSON.stringify(value)).byteLength+128;if(bytesLeft<0)throw new RangeError('result-budget');return value;};
  const serialize=(input,depth=0)=>{
    charge(null);
    if(input===null||typeof input==='boolean')return input;
    if(typeof input==='string')return charge(input.length>8192?{type:'string',value:input.slice(0,8192),truncated:true}:input);
    if(typeof input==='number')return Number.isFinite(input)?input:{type:'number',value:String(input)};
    if(['undefined','function','symbol','bigint'].includes(typeof input))return {type:typeof input,...(typeof input==='bigint'?{value:String(input).slice(0,1024)}:{})};
    if(seen.has(input))return {type:'reference',id:seen.get(input)};
    if(depth>=6||remaining--<=0)return {type:'truncated'};
    seen.set(input,remaining);
    if(input instanceof Element)return {type:'DOM',tag:input.tagName.toLowerCase(),nodeRef:input.getAttribute('data-cortex-ref')??null};
    const output=Object.create(null),keys=Reflect.ownKeys(input).filter(key=>typeof key==='string').slice(0,50);
    for(const key of keys){charge(key);const descriptor=Object.getOwnPropertyDescriptor(input,key);output[key]=descriptor&&'value'in descriptor?serialize(descriptor.value,depth+1):{type:'accessor',state:'not-invoked'};}
    return {type:Array.isArray(input)?'array':'object',properties:output};
  };
  try {
    const serialized=serialize(value),bytes=encoder.encode(JSON.stringify(serialized)).byteLength;
    return bytes<=32768?{state:'available',value:serialized,bytes}:{state:'truncated',reason:'32-KiB-result-budget'};
  } catch {return {state:'truncated',reason:'result-budget-or-unserializable'};}
}
export async function evaluate({page,doc,args,identity,signal,features,onDispatch}) {
  if(!features.allowScripts)throw domainError('PolicyDenied','JavaScript non autorizzato dall’host.');
  if(Buffer.byteLength(args.code)>32768||Buffer.byteLength(args.argumentJson??'')>16384)
    throw domainError('BudgetExceeded','Codice o argomento JavaScript oltre quota UTF-8; script non avviato.');
  const current=identity(page);
  if(args.pageId!==current.pageId||args.expectedDocumentEpoch!==current.documentEpoch)throw domainError('StaleObservation','Target/epoch differente; script non avviato.');
  let argument=null;
  try{if(args.argumentJson!==undefined)argument=JSON.parse(args.argumentJson);}catch{throw domainError('PolicyDenied','argumentJson non valido.');}
  let timer,abortHandler,cdp,dispatched=false,interrupted=false,targetClosed=false,terminationConfirmed=false;
  try {
    cdp=await page.context().newCDPSession(page);
    const stop=new Promise(resolve=>{
      abortHandler=()=>{interrupted=true;resolve({interrupted:true});};
      signal?.addEventListener('abort',abortHandler,{once:true});
      timer=setTimeout(abortHandler,args.timeout??2000);
    });
    if(signal?.aborted)return {executionState:'not-started',effects:'none-known',terminationConfirmed:false,targetClosed:false};
    onDispatch?.();dispatched=true;
    const execution=doc.evaluate(executeScript,{code:args.code,argument}).then(value=>({value}),()=>({failed:true}));
    const outcome=await Promise.race([execution,stop]);
    if(outcome.interrupted) {
      // This control lane is outside the runtime FIFO. Termination is best effort;
      // closing the owned page also prevents queued timers from surviving recovery.
      const bounded=async(promise)=>{let t;try{return await Promise.race([promise,new Promise(resolve=>{t=setTimeout(()=>resolve(false),1000);})]);}finally{clearTimeout(t);}};
      await bounded(cdp.send('Runtime.terminateExecution').then(()=>true,()=>false));
      await bounded(page.close({runBeforeUnload:false}).then(()=>true,()=>false));
      targetClosed=page.isClosed();terminationConfirmed=targetClosed;
      return {executionState:'unknown',effects:'possible',terminationConfirmed,targetClosed,reason:signal?.aborted?'cancelled':'timeout',noReplay:true};
    }
    if(outcome.failed)return {executionState:'failed',effects:'possible',terminationConfirmed:false,targetClosed:false,error:{kind:'ScriptFailed',message:'Script fallito; consultare capture preventiva per dettagli redatti.'}};
    const result=redactData(outcome.value);
    // Keep a second byte check after redaction: replacement text can grow.
    if(result.state==='available') {
      result.bytes=Buffer.byteLength(JSON.stringify(result.value));
      if(result.bytes>32768){delete result.value;delete result.bytes;result.state='truncated';result.reason='32-KiB-result-budget';}
    }
    return {executionState:'completed',effects:'possible',terminationConfirmed:false,targetClosed:false,
      result};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abortHandler);await cdp?.detach().catch(()=>{});}
}
