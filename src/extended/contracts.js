import { fail, result } from '../core/cortex-utils.js';
const string=(maxLength=128)=>({type:'string',minLength:1,maxLength});
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const choice=values=>({type:'string',enum:values});
const array=(items,maxItems=20)=>({type:'array',items,minItems:1,maxItems});
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const target={pageId:string(),frame:string(350)};
const outputSchema={type:'object',required:['ok','contractVersion','data','coverage','warnings'],properties:{
  ok:{type:'boolean'},contractVersion:{type:'integer'},data:{type:'object',additionalProperties:true},
  coverage:{type:'object',additionalProperties:true},warnings:{type:'array',items:{type:'string'}},
  sessionId:{type:'string'},isolated:{type:'boolean'},closed:{type:'boolean'},
  error:{type:'object',required:['kind','message'],properties:{kind:{type:'string'},message:{type:'string'}},additionalProperties:false}},additionalProperties:false};
const mutating={readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true};
const readonly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
const definition=(name,description,properties,required=[],annotations=readonly)=>({name,description,
  inputSchema:object({...properties,project_path:string(4096)},required),outputSchema,annotations});
export function resolveFeatures({config={},policy={},env=process.env}={}) {
  // Frozen host capabilities: project .env and tool input cannot escalate them.
  const profile=config.toolProfile??env.CORTEX_TOOL_PROFILE??'base';
  const profiles={base:[],visual:['visual'],diagnostic:['visual','diagnostic'],extended:['visual','diagnostic','evaluate','design','devtools']};
  if(!Object.hasOwn(profiles,profile))throw fail('toolProfile non valido.');
  const modules=config.modules??profiles[profile];
  if(!Array.isArray(modules)||modules.some(value=>!profiles.extended.includes(value)))throw fail('Moduli Cortex non validi.');
  const enabled=new Set(modules),allowScripts=policy.allowScripts===true;
  if(enabled.has('evaluate')&&!allowScripts)enabled.delete('evaluate');
  return Object.freeze({modules:Object.freeze([...enabled]),allowScripts,allowDebugger:policy.allowDebugger===true,
    allowTrace:policy.allowTrace===true,approvedDesign:structuredClone(policy.approvedDesign??null)});
}
export function extendedDefinitions(features) {
  const tools=[];
  if(features.modules.includes('visual'))tools.push(
    definition('cortex_observe','Osservazione v1: immagine MCP inline fedele, struttura e geometria bounded. Snapshot non atomico; diff strutturale esplicito.',{
      ...target,mode:choice(['structure','image','hybrid','diff']),target:string(350),
      clip:object({x:{type:'number',minimum:0},y:{type:'number',minimum:0},width:{type:'number',minimum:1},height:{type:'number',minimum:1}},['x','y','width','height']),
      stability:choice(['live','settled','normalized']),limit:integer(1,50),sinceSnapshotId:string(),timeout:integer(100,10000)},[],mutating),
    definition('cortex_inspect','Ispezione mirata DOM/computed/box/layout/pseudo/rules/accessibility/source con provenienza e limiti.',{
      ...target,target:string(350),snapshotId:string(),point:object({x:{type:'number',minimum:0},y:{type:'number',minimum:0}},['x','y']),
      facets:array(choice(['dom','computed','box','layout','pseudo','rules','accessibility','source']),8),properties:array(string(80),40),limit:integer(1,50)}));
  if(features.modules.includes('diagnostic'))tools.push(definition('cortex_capture','Capture preventiva console/rete: start/stop/status/summary/list/detail. Nessun refetch. Body omessi senza acquisizione bounded.',{
    ...target,action:choice(['start','stop','status','summary','list','detail']),captureId:string(),eventId:string(),
    channels:array(choice(['network','console','websocket','download']),4),durationMs:integer(100,120000),
    maxEvents:integer(1,5000),maxBytes:integer(1024,4194304),cursor:string(),limit:integer(1,100),kind:choice(['network','console','websocket','download']),operationId:string()},['action'],mutating));
  if(features.modules.includes('evaluate'))tools.push(definition('cortex_evaluate','JavaScript browser opt-in host, potentially mutating. Target/epoch obbligatori. Timeout chiude target, stato unknown senza replay.',{
    ...target,pageId:string(),expectedDocumentEpoch:integer(1,2147483647),operationId:string(),code:string(32768),argumentJson:string(16384),timeout:integer(100,10000)},['pageId','expectedDocumentEpoch','operationId','code'],mutating));
  if(features.modules.includes('design'))tools.push(definition('cortex_design','Profilo v1 in memoria: build/get/compare/export/import. Approvazione solo dalla policy host; export JSON, nessun filesystem pubblico.',{
    action:choice(['build','get','compare','export','import']),profileId:string(),snapshotIds:array(string(),20),profileJson:string(65536)},['action'],mutating));
  if(features.modules.includes('devtools'))tools.push(definition('cortex_devtools','DevTools Chromium: capabilities, metrics, memory, storage inventario, coverage, debugger/trace con lease host. Nessun pass-through.',{
    ...target,action:choice(['capabilities','metrics','memory','storage','coverage-start','coverage-stop','pause','resume','trace-start','trace-stop']),durationMs:integer(100,10000)},['action'],mutating));
  return tools;
}
export function domainError(kind,message) {const error=fail(message);error.name=kind;return error;}
export const instrumentation={profile:'guarded',cache:'disabled-by-routing',serviceWorkers:'blocked',backend:'chromium-playwright',atomic:false};
export function normalizeExtendedResult(response) {
  if(response.structuredContent?.contractVersion===1)return response;
  const {ok=false,error,sessionId,isolated,closed,...data}=response.structuredContent??{};
  const normalized=result({ok,contractVersion:1,data,coverage:{scope:'requested-target',complete:false,reasons:['operation-failed']},warnings:[],
    ...(error?{error}:{}),...(sessionId?{sessionId,isolated:!!isolated}:{}),...(closed!==undefined?{closed}: {})},Boolean(response.isError)||!ok);
  normalized.content.push(...(response.content??[]).filter(block=>block.type!=='text'));return normalized;
}
