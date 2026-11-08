import { randomUUID } from 'node:crypto';
import { permitted, redact, safeUrl } from '../core/cortex-utils.js';
import { domainError, instrumentation } from './contracts.js';

export class CaptureCollector {
  constructor({budget,pageIdentity,origins,now=Date.now}={}) {
    Object.assign(this,{budget,pageIdentity,origins,now});this.captures=new Map();this.listeners=[];this.active=null;this.context=null;
    this.bytes=0;this.closed=false;this.operation=null;
    this.sweepTimer=setInterval(()=>this.sweep(),30000);this.sweepTimer.unref?.();
  }
  on(emitter,event,callback) {
    const safe=(...args)=>{try{callback(...args);}catch{if(this.active)this.active.listenerErrors++;}};
    emitter.on(event,safe);this.listeners.push(()=>emitter.off(event,safe));
  }
  sweep(){for(const [id,c] of this.captures)if(c.stoppedAt&&this.now()-c.stoppedAt>=600000)this.remove(id);}
  remove(id){const c=this.captures.get(id);if(c){this.bytes-=c.bytes;this.budget.release(c.bytes);this.captures.delete(id);}}
  add(c,entry) {
    if(this.active!==c||c.stoppedAt)return null;
    entry={...entry,eventId:randomUUID(),sequence:++c.sequence,at:this.now(),operationId:this.operation??null};
    const bytes=Buffer.byteLength(JSON.stringify(entry));
    if(c.events.size>=c.maxEvents||c.bytes+bytes>c.maxBytes||this.bytes+bytes>4194304){c.dropped++;return null;}
    try{this.budget.reserve(bytes);}catch{c.dropped++;return null;}
    c.bytes+=bytes;this.bytes+=bytes;c.events.set(entry.eventId,entry);return entry;
  }
  update(c,entry,patch) {
    if(this.active!==c||!entry||c.stoppedAt)return;
    const before=Buffer.byteLength(JSON.stringify(entry)),after=Buffer.byteLength(JSON.stringify({...entry,...patch})),delta=after-before;
    if(delta>0&&(c.bytes+delta>c.maxBytes||this.bytes+delta>4194304)){c.dropped++;return;}
    try {if(delta>0)this.budget.reserve(delta);else this.budget.release(-delta);}catch{c.dropped++;return;}
    Object.assign(entry,patch);c.bytes+=delta;this.bytes+=delta;
  }
  start(context,args={}) {
    if(this.active)throw domainError('PolicyDenied','Capture già attiva nella sessione.');
    this.sweep();while(this.captures.size>=4)this.remove(this.captures.keys().next().value);
    const c={captureId:randomUUID(),startedAt:this.now(),stoppedAt:null,reason:null,sequence:0,dropped:0,listenerErrors:0,bytes:0,
      maxEvents:args.maxEvents??5000,maxBytes:args.maxBytes??4194304,channels:args.channels??['network','console'],events:new Map(),requests:new WeakMap(),pending:0,pageId:args.pageId??null};
    this.captures.set(c.captureId,c);this.active=c;this.context=context;
    const pageInfo=request=>{try{return this.pageIdentity(request.frame().page());}catch{return {pageId:null,documentEpoch:null};}};
    const eligible=info=>!c.pageId||c.pageId===info.pageId;
    const owned=request=>permitted(request.url(),this.origins());
    if(c.channels.includes('network')) {
      this.on(context,'request',request=>{
        if(!owned(request))return;
        const info=pageInfo(request);if(!eligible(info))return;
        const previous=c.requests.get(request.redirectedFrom());
        const entry=this.add(c,{kind:'network',...info,url:safeUrl(request.url()),method:request.method().slice(0,16),resourceType:request.resourceType(),
          state:'pending',status:null,redirectedFrom:previous?.eventId??null,redirectedTo:null,
          body:{state:'omitted-policy',reason:'No bounded body acquisition backend enabled'},headers:{state:'omitted-policy'},initiator:{state:'unsupported'}});
        if(entry){c.requests.set(request,entry);c.pending++;if(previous)this.update(c,previous,{redirectedTo:entry.eventId});}
      });
      this.on(context,'response',response=>{const entry=c.requests.get(response.request());if(entry)this.update(c,entry,{status:response.status(),fromServiceWorker:response.fromServiceWorker(),responseAt:this.now()});});
      this.on(context,'requestfinished',request=>{const entry=c.requests.get(request);if(entry&&entry.state==='pending'){c.pending--;this.update(c,entry,{state:'completed',finishedAt:this.now()});}});
      this.on(context,'requestfailed',request=>{const entry=c.requests.get(request);if(entry&&entry.state==='pending'){c.pending--;this.update(c,entry,{state:'failed',failure:redact(String(request.failure()?.errorText??'unknown').slice(0,512)),finishedAt:this.now()});}});
    }
    const attached=new WeakSet();
    const watch=page=>{
      if(attached.has(page))return;attached.add(page);
      const info=()=>this.pageIdentity(page);
      if(c.channels.includes('console')) {
        this.on(page,'console',message=>{if(!permitted(page.url(),this.origins())||!eligible(info()))return;const l=message.location();this.add(c,{kind:'console',...info(),type:message.type(),text:redact(message.text().slice(0,2048)),location:{url:safeUrl(l.url),line:l.lineNumber,column:l.columnNumber},stack:{state:'unsupported'},arguments:{state:'omitted-policy'}});});
        this.on(page,'pageerror',error=>{if(permitted(page.url(),this.origins())&&eligible(info()))this.add(c,{kind:'console',...info(),type:'pageerror',text:redact(String(error.message).slice(0,2048)),stack:redact(String(error.stack??'').slice(0,4096))});});
      }
      if(c.channels.includes('websocket'))this.on(page,'websocket',ws=>{
        if(!eligible(info()))return;
        c.socketCount=(c.socketCount??0)+1;if(c.socketCount>64){c.dropped++;return;}
        let url;try{url=new URL(ws.url());url.protocol=url.protocol==='wss:'?'https:':'http:';}catch{return;}
        if(!permitted(url.href,this.origins()))return;
        const socketId=randomUUID();this.add(c,{kind:'websocket',...info(),socketId,url:safeUrl(url.href),event:'open'});
        for(const event of ['framesent','framereceived'])this.on(ws,event,frame=>this.add(c,{kind:'websocket',...info(),socketId,event,bytes:Buffer.byteLength(frame.payload),payload:{state:'omitted-policy'}}));
        this.on(ws,'close',()=>this.add(c,{kind:'websocket',...info(),socketId,event:'close'}));
        this.on(ws,'socketerror',()=>this.add(c,{kind:'websocket',...info(),socketId,event:'error'}));
      });
      if(c.channels.includes('download'))this.on(page,'download',download=>{if(eligible(info()))this.add(c,{kind:'download',...info(),url:safeUrl(download.url()),suggestedFilename:redact(download.suggestedFilename().slice(0,128)),file:{state:'omitted-policy'}});});
    };
    context.pages().forEach(watch);this.on(context,'page',watch);
    this.on(context,'close',()=>this.stop('context-closed'));
    this.timer=setTimeout(()=>this.stop('duration-limit'),args.durationMs??30000);this.timer.unref?.();
    return this.status(c);
  }
  stop(reason='requested') {
    const c=this.active;if(!c)return null;
    clearTimeout(this.timer);for(const off of this.listeners.splice(0))off();
    c.stoppedAt=this.now();c.reason=reason;this.active=null;this.context=null;return this.status(c);
  }
  get(id){this.sweep();const c=id?this.captures.get(id):this.active;if(!c)throw domainError('CaptureExpired','Capture assente, scaduta o estranea alla sessione.');return c;}
  status(c){return {captureId:c.captureId,state:c.stoppedAt?'sealed':'armed',startedAt:c.startedAt,stoppedAt:c.stoppedAt,
    reason:c.reason,events:c.events.size,pending:[...c.events.values()].filter(e=>e.kind==='network'&&e.state==='pending').length,dropped:c.dropped,listenerErrors:c.listenerErrors,
    instrumentation,coverage:{scope:c.pageId?'selected-page':'context-pages-and-frame-requests',complete:false,
      reasons:['no-pre-start-history','workers-and-sse-payloads-not-attached',...(c.dropped?['quota-loss']:[]),...(c.listenerErrors?['listener-error']:[])],
      enumeratedEventsComplete:c.dropped===0&&c.listenerErrors===0},bodyPolicy:'off',bytes:c.bytes};}
  call(context,args) {
    const fields={start:['pageId','channels','durationMs','maxEvents','maxBytes'],stop:['captureId'],status:['captureId'],summary:['captureId'],list:['captureId','cursor','limit','kind'],detail:['captureId','eventId']};
    if(Object.keys(args).some(key=>!['action','project_path',...fields[args.action]].includes(key)))throw domainError('PolicyDenied','Campi non ammessi per questa azione capture.');
    if(args.action==='start')return this.start(context,args);
    const c=this.get(args.captureId);
    if(args.action==='stop'){if(this.active!==c)throw domainError('PolicyDenied','Capture già chiusa.');return this.stop();}
    if(args.action==='detail'){const event=c.events.get(args.eventId);if(!event)throw domainError('BodyUnavailable','Evento non acquisito o non disponibile.');return structuredClone(event);}
    if(args.action==='list'){
      if(!c.stoppedAt)throw domainError('PolicyDenied','Chiudere la capture prima della paginazione stabile.');
      const offset=args.cursor?Number(args.cursor.split(':')[1]):0;
      if(args.cursor&&(!args.cursor.startsWith(c.captureId+':')||!Number.isSafeInteger(offset)||offset<0))throw domainError('CaptureExpired','Cursore non valido per questa capture.');
      const events=[...c.events.values()].filter(e=>!args.kind||e.kind===args.kind),limit=args.limit??20;
      // Cursor binds the filter to prevent silent skips after changing kind.
      if(args.cursor&&args.cursor.split(':')[2]!==String(args.kind??'all'))throw domainError('CaptureExpired','Filtro diverso da quello del cursore.');
      return {...this.status(c),events:structuredClone(events.slice(offset,offset+limit)),nextCursor:offset+limit<events.length?`${c.captureId}:${offset+limit}:${args.kind??'all'}`:null};
    }
    const counts={};for(const e of c.events.values())counts[e.kind]=(counts[e.kind]??0)+1;
    return {...this.status(c),...(args.action==='summary'?{counts}:{} )};
  }
  close(){this.stop('session-close');clearInterval(this.sweepTimer);for(const id of this.captures.keys())this.remove(id);this.closed=true;}
}
