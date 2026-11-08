import { randomUUID } from 'node:crypto';
import { domainError } from './contracts.js';
// Logical serialized bytes, not process RSS or backend-buffer guarantees.
export function createBudget(maxBytes=64*1024*1024) {
  let used=0;
  return {reserve(bytes){if(!Number.isSafeInteger(bytes)||bytes<0||used+bytes>maxBytes)throw domainError('BudgetExceeded','Quota dati Cortex raggiunta.');used+=bytes;},
    release(bytes){used=Math.max(0,used-bytes);},get used(){return used;},maxBytes};
}
export class BoundedStore {
  constructor({budget,maxEntries=20,maxBytes=4*1024*1024,ttlMs=1800000,now=Date.now}={}) {
    Object.assign(this,{budget,maxEntries,maxBytes,ttlMs,now});this.entries=new Map();this.bytes=0;
    this.timer=setInterval(()=>this.sweep(),Math.min(ttlMs,30000));this.timer.unref?.();
  }
  sweep(){for(const [id,entry] of this.entries)if(this.now()>=entry.expires)this.delete(id);}
  put(value,id=randomUUID()) {
    this.sweep();const bytes=Buffer.byteLength(JSON.stringify(value));
    if(bytes>this.maxBytes)throw domainError('BudgetExceeded','Record oltre quota.');
    if(this.entries.has(id))this.delete(id);
    while(this.entries.size>=this.maxEntries||this.bytes+bytes>this.maxBytes)this.delete(this.entries.keys().next().value);
    this.budget?.reserve(bytes);this.bytes+=bytes;
    this.entries.set(id,{value:structuredClone(value),bytes,expires:this.now()+this.ttlMs});return id;
  }
  get(id,kind='StaleObservation') {this.sweep();const entry=this.entries.get(id);if(!entry)throw domainError(kind,'Identificatore non disponibile, scaduto o estraneo alla sessione.');return structuredClone(entry.value);}
  delete(id){const entry=this.entries.get(id);if(entry){this.bytes-=entry.bytes;this.budget?.release(entry.bytes);this.entries.delete(id);}}
  close(){clearInterval(this.timer);for(const id of this.entries.keys())this.delete(id);}
}
