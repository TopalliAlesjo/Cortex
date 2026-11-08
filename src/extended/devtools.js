import { domainError } from './contracts.js';
import { safeUrl } from '../core/cortex-utils.js';

export class Devtools {
  constructor(features,budget){this.features=features;this.budget=budget;this.records=new Map();}
  async record(page) {
    let record=this.records.get(page);if(record)return record;
    this.budget.reserve(1048576);
    try{record={cdp:await page.context().newCDPSession(page),timers:new Set(),paused:false,coverage:false,trace:false,events:[],dropped:0};}
    catch(error){this.budget.release(1048576);throw error;}
    this.records.set(page,record);
    page.once('close',()=>{void this.dispose(page);});return record;
  }
  lease(record,callback,duration) {
    const timer=setTimeout(()=>{record.timers.delete(timer);void callback().catch(()=>{});},duration);timer.unref?.();record.timers.add(timer);return timer;
  }
  clearLease(record,key){clearTimeout(record[key]);record.timers.delete(record[key]);record[key]=null;}
  async resume(record) {
    this.clearLease(record,'pauseTimer');record.paused=false;
    // pause() may mean "pause on the next JavaScript task". A resume sent
    // before that task fails; disabling the debugger also cancels that intent.
    await record.cdp.send('Debugger.setSkipAllPauses',{skip:true}).catch(()=>{});
    await record.cdp.send('Debugger.resume').catch(()=>{});
    await record.cdp.send('Debugger.disable').catch(()=>{});
  }
  async stopCoverage(record) {
    this.clearLease(record,'coverageTimer');
    if(record.coveragePromise)return record.coveragePromise;
    if(!record.coverage)return record.coverageResult??{state:'not-started'};
    record.coverage=false;
    record.coveragePromise=(async()=>{
    const {result}=await record.cdp.send('Profiler.takePreciseCoverage');
    await record.cdp.send('Profiler.stopPreciseCoverage');
    record.coverageResult={state:'sealed',kind:'execution-coverage-not-correctness',scripts:result.slice(0,100).map(s=>({url:safeUrl(s.url),functions:s.functions.length,executedFunctions:s.functions.filter(f=>f.ranges.some(r=>r.count>0)).length})),omittedScripts:Math.max(0,result.length-100),source:{state:'omitted-policy'},backendAcquisition:'not-hard-memory-bounded'};
    return record.coverageResult;
    })();return record.coveragePromise;
  }
  async call(page,doc,args) {
    const action=args.action;
    if(action==='capabilities')return {backend:'chromium',metrics:true,heapUsage:true,storage:'counts-only',coverage:'execution-summary',
      debugger:this.features.allowDebugger?'lease-auto-resume':'host-disabled',trace:this.features.allowTrace?'target-performance-timeline':'host-disabled',
      unsupported:['arbitrary-CDP','heap-snapshot','browser-wide-trace','storage-values','breakpoints','source-map-debugger','fidelity-cache-serviceworkers-mode']};
    if(action==='storage')return doc.evaluate(()=>{
      const count=storage=>{try{return {state:'available',entries:storage.length,values:'omitted-policy',keys:'omitted-policy'};}catch{return {state:'unavailable-error'};}};
      return {localStorage:count(localStorage),sessionStorage:count(sessionStorage),cookies:{state:'omitted-policy'},indexedDB:{state:'unsupported'}};
    });
    if(['pause','resume'].includes(action)&&!this.features.allowDebugger)throw domainError('PolicyDenied','Debugger non autorizzato dall’host.');
    if(['trace-start','trace-stop','coverage-start','coverage-stop'].includes(action)&&!this.features.allowTrace)throw domainError('PolicyDenied','Profiling non autorizzato dall’host.');
    const record=await this.record(page),cdp=record.cdp;
    if(action==='metrics'){await cdp.send('Performance.enable');const {metrics}=await cdp.send('Performance.getMetrics');return {metrics:metrics.slice(0,100),provenance:'CDP Performance',units:'CDP-defined-per-metric',perturbation:'instrumentation-enabled'};}
    if(action==='memory')return {heapUsage:await cdp.send('Runtime.getHeapUsage'),provenance:'CDP Runtime',units:'bytes',includesNodeOrBrowserRSS:false};
    if(action==='pause') {
      if(record.paused)throw domainError('PolicyDenied','Target già sospeso.');
      await cdp.send('Debugger.enable');await cdp.send('Debugger.setSkipAllPauses',{skip:false});record.paused=true;
      record.pauseTimer=this.lease(record,()=>this.resume(record),Math.min(args.durationMs??1000,2000));
      await cdp.send('Debugger.pause');return {state:'paused-requested',autoResumeMs:Math.min(args.durationMs??1000,2000),controlLane:'independent-timer',effects:'timing-perturbation'};
    }
    if(action==='resume'){await this.resume(record);return {state:'resumed-requested'};}
    if(action==='coverage-start') {
      if(record.coverage)throw domainError('PolicyDenied','Coverage già attiva.');
      await cdp.send('Profiler.enable');await cdp.send('Profiler.startPreciseCoverage',{callCount:true,detailed:false});record.coverage=true;record.coverageResult=null;record.coveragePromise=null;
      record.coverageTimer=this.lease(record,()=>this.stopCoverage(record),args.durationMs??5000);return {state:'armed',autoStopMs:args.durationMs??5000,perturbation:'precise-coverage-enabled',backendAcquisition:'not-hard-memory-bounded'};
    }
    if(action==='coverage-stop')return this.stopCoverage(record);
    if(action==='trace-start') {
      if(record.trace)throw domainError('PolicyDenied','Timeline già attiva.');
      record.events=[];record.dropped=0;
      record.handler=({event})=>{
        if(!record.trace)return;
        if(record.events.length>=1000){record.dropped++;return;}
        record.events.push({type:event.type,name:String(event.name??'').slice(0,100),time:event.time,duration:event.duration,
          ...(event.layoutShiftDetails?{layoutShift:{value:event.layoutShiftDetails.value,hadRecentInput:event.layoutShiftDetails.hadRecentInput}}:{}),
          ...(event.lcpDetails?{lcp:{renderTime:event.lcpDetails.renderTime,loadTime:event.lcpDetails.loadTime,size:event.lcpDetails.size}}:{})});
      };
      cdp.on('PerformanceTimeline.timelineEventAdded',record.handler);
      try{await cdp.send('PerformanceTimeline.enable',{eventTypes:['largest-contentful-paint','layout-shift']});record.trace=true;}
      catch(error){cdp.off('PerformanceTimeline.timelineEventAdded',record.handler);throw error;}
      record.traceTimer=this.lease(record,()=>this.stopTrace(record),args.durationMs??5000);
      return {state:'armed',kind:'target-performance-timeline',autoStopMs:args.durationMs??5000,browserWideTrace:'unsupported-for-shared-browser'};
    }
    if(action==='trace-stop')return this.stopTrace(record);
    throw domainError('UnsupportedCapability','Azione DevTools non supportata.');
  }
  async stopTrace(record) {
    this.clearLease(record,'traceTimer');
    if(record.trace){record.trace=false;await record.cdp.send('PerformanceTimeline.enable',{eventTypes:[]});record.cdp.off('PerformanceTimeline.timelineEventAdded',record.handler);}
    return {state:'sealed',kind:'target-performance-timeline',events:structuredClone(record.events),dropped:record.dropped,complete:false,reasons:['selected-event-types-only']};
  }
  async dispose(page){const record=this.records.get(page);if(!record)return;this.records.delete(page);for(const timer of record.timers)clearTimeout(timer);
    if(record.paused)await this.resume(record);
    if(record.coverage)await record.cdp.send('Profiler.stopPreciseCoverage').catch(()=>{});
    await record.cdp.detach().catch(()=>{});this.budget.release(1048576);
  }
  async close(){await Promise.all([...this.records.keys()].map(page=>this.dispose(page)));}
}
