import { createHash, randomUUID } from 'node:crypto';
import { domainError, instrumentation } from './contracts.js';
import { redact } from '../core/cortex-utils.js';

export function browserState() {
  const key=Symbol.for('cortex.observation');
  if(!document[key]) {
    const state={revision:0};
    const observer=new MutationObserver(records=>{if(records.some(r=>{
      if(r.attributeName==='data-cortex-ref')return false;
      // Playwright masks add/remove their own closed-shadow overlay around a
      // screenshot. That temporary overlay is not an application mutation.
      if(r.type==='childList'&&[...r.addedNodes,...r.removedNodes].length&&[...r.addedNodes,...r.removedNodes].every(n=>n.nodeType===1&&n.tagName==='X-PW-GLASS'))return false;
      return true;
    }))state.revision++;});
    observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
    Object.defineProperty(document,key,{value:state});
  }
  return {revision:document[key].revision,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY},dpr:devicePixelRatio,
    visualViewport:visualViewport?{offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale,width:visualViewport.width,height:visualViewport.height}:null,
    fonts:document.fonts?.status??'unsupported',readyState:document.readyState};
}
export const sameState=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clean=value=>typeof value==='string'?redact(value):Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)])):value;
export async function resolveNode(doc,target,locate) {
  const locator=locate(doc,target);
  const count=await locator.count();
  if(count!==1)throw domainError(count?'AmbiguousTarget':'StaleRef','Target assente o ambiguo; aggiornare una lettura mirata.');
  const handle=await locator.elementHandle({timeout:2000});
  if(!handle)throw domainError('StaleRef','Nodo non disponibile.');
  const ref=target.replace(/^ref:/,'');
  if(/^s\d+-e\d+$/.test(ref)&&!await handle.evaluate((e,id)=>e.isConnected&&document[Symbol.for('cortex.refs')]?.refs.get(id)?.deref()===e,ref)) {
    await handle.dispose();throw domainError('StaleRef','Identità del nodo sostituita.');
  }
  return handle;
}
export async function observe({page,doc,args,identity,snapshots,peek,locate}) {
  const startedAt=new Date().toISOString(),mode=args.mode??'hybrid',stability=args.stability??'live';
  if(args.frame&&mode!=='structure')throw domainError('UnsupportedCapability','Immagine di frame selezionato non ancora supportata; usare ispezione del frame.');
  if(args.target&&args.clip)throw domainError('PolicyDenied','Specificare target oppure clip.');
  if(mode==='diff'&&!args.sinceSnapshotId)throw domainError('StaleObservation','Diff richiede sinceSnapshotId.');
  if(stability==='settled') {
    await doc.waitForFunction(()=>document.fonts?.status!=='loading'&&[...document.images].filter(i=>{const r=i.getBoundingClientRect();return r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;}).every(i=>i.complete),null,{timeout:args.timeout??3000});
  }
  let scope;
  if(args.target&&mode!=='image'){
    const handle=await resolveNode(doc,args.target,locate);
    try{
      const candidate=await peek(page,{frame:args.frame,mode:'candidates',nodes:[handle],limit:1,waitForReady:false});
      if(!candidate.candidates?.[0]?.ref)throw domainError('StaleRef','Scope non più disponibile.');
      scope=`[data-cortex-ref="${candidate.candidates[0].ref}"]`;
    }finally{await handle.dispose();}
  }
  const initialIdentity=identity(page);
  const structure=mode!=='image'?await peek(page,{frame:args.frame,scope,limit:args.limit??20,waitForReady:false}):null;
  const before=await doc.evaluate(browserState),clip=args.clip?{...args.clip}:null;
  let area=clip??{x:0,y:0,...before.viewport};
  if(args.target) {
    const handle=await resolveNode(doc,args.target,locate);
    try{const rect=await handle.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});area=rect;}
    finally{await handle.dispose();}
  }
  if(area.x<0||area.y<0||area.width<1||area.height<1||area.x+area.width>before.viewport.width||area.y+area.height>before.viewport.height)
    throw domainError('PolicyDenied','Crop deve essere interamente visibile nella viewport, senza scroll implicito.');
  const mapping=[];
  for(const control of structure?.controls??[]) {
    let handle;
    try{handle=await resolveNode(doc,control.ref,locate);const rect=await handle.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});mapping.push({ref:control.ref,rect,space:args.frame?'frame-local-viewport-css':'top-level-viewport-css'});}
    catch{/* A stale control is excluded and coverage remains partial. */}
    finally{await handle?.dispose().catch(()=>{});}
  }
  let bytes=null,bitmap=null;
  if(['image','hybrid'].includes(mode)) {
    if(Math.ceil(area.width)*Math.ceil(area.height)>4000000)throw domainError('BudgetExceeded','Area oltre 4 megapixel CSS; scegliere un crop.');
    bytes=await page.screenshot({type:'png',fullPage:false,scale:'css',animations:stability==='normalized'?'disabled':'allow',caret:stability==='normalized'?'hide':'initial',
      ...(clip||args.target?{clip:{...area}}:{}),
      mask:[page.locator('input,textarea,iframe,[data-cortex-private]')],maskColor:'#000000',timeout:args.timeout??10000});
    if(bytes.length>4194304)throw domainError('BudgetExceeded','Immagine codificata oltre 4 MiB; scegliere un crop.');
    bitmap={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  const after=await doc.evaluate(browserState),current=identity(page);
  const snapshotId=randomUUID();
  const designSample=await doc.evaluate(()=>[...document.querySelectorAll('h1,h2,label,button,a,input,select,textarea')].slice(0,20).map(e=>{const s=getComputedStyle(e);return {tag:e.tagName.toLowerCase(),fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,backgroundColor:s.backgroundColor,padding:s.padding,borderRadius:s.borderRadius};}));
  const sources=await doc.evaluate(()=>[...document.styleSheets].slice(0,50).map(s=>({url:s.href||'inline',disabled:s.disabled,media:s.media.mediaText,contentHash:'unavailable'})));
  const data={snapshotId,target:current,startedAt,finishedAt:new Date().toISOString(),mode,stability,instrumentation,
    structure,mapping,designSample:clean(designSample),sources:clean(sources),state:after,area,bitmap,imageDelivery:bytes?'inline-emitted':'not-requested',
    coherence:sameState(before,after)&&initialIdentity.documentEpoch===current.documentEpoch?'best-effort':'unstable',
    transformations:stability==='normalized'?['animations-disabled-may-fire-transitionend','caret-hidden','input-textarea-iframe-private-masks']:['input-textarea-iframe-private-masks'],
    coordinateMapping:bitmap?{from:'top-level-viewport-css',to:'server-bitmap-pixels',origin:{x:area.x,y:area.y},scaleX:bitmap.width/area.width,scaleY:bitmap.height/area.height,
      modelImageTransform:'unknown-to-server',actionable:false}:null};
  if(mode==='diff') {
    const base=snapshots.get(args.sinceSnapshotId);
    if(base.target.pageId!==current.pageId||base.target.documentEpoch!==current.documentEpoch||JSON.stringify(base.state.viewport)!==JSON.stringify(after.viewport))data.diff={baseSnapshotId:args.sinceSnapshotId,resetRequired:true,reason:'target-epoch-viewport-changed'};
    else {
      const previous=new Map((base.structure?.controls??[]).map(c=>[c.ref,c])),next=new Map((structure?.controls??[]).map(c=>[c.ref,c]));
      data.diff={baseSnapshotId:args.sinceSnapshotId,resetRequired:false,kind:'observed-controls-only',
        added:[...next].filter(([id])=>!previous.has(id)).map(([,c])=>c),removed:[...previous.keys()].filter(id=>!next.has(id)),
        changed:[...next].filter(([id,c])=>previous.has(id)&&JSON.stringify(c)!==JSON.stringify(previous.get(id))).map(([,c])=>c)};
    }
  }
  snapshots.put(data,snapshotId);
  return {data,images:bytes?[{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]:[],warnings:['Best effort: DOM e pixel non atomici; animazioni/canvas non interamente osservabili.','Input, textarea, iframe e data-cortex-private mascherati.']};
}

// Runs in the selected document; never returns input values, arbitrary properties or executable source.
export function inspectNode(element,options) {
  const secrets=[...document.querySelectorAll('input,textarea')].map(e=>e.value).filter(Boolean);
  const scrub=value=>{let text=String(value??'').slice(0,2048);for(const secret of secrets)text=text.split(secret).join('[redacted]');return text;};
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const properties=options.properties??['display','position','overflow','overflow-x','overflow-y','font-family','font-size','font-weight','line-height','color','background-color','padding','margin','gap','z-index'];
  const style=getComputedStyle(element),data={provenance:{dom:'page-DOM',computed:'getComputedStyle',rules:'CSSOM-matching-candidates',accessibility:'DOM-heuristic',fontUsed:'unavailable',cascadeWinner:'unknown'},node:{tag:element.tagName.toLowerCase(),id:scrub(element.id),role:element.getAttribute('role')??null}};
  const facet=key=>options.facets.includes(key);
  if(facet('dom')) {
    let count=0;const tree=(e,depth)=>{
      if(++count>options.limit)return null;
      const attrs={};for(const name of ['role','aria-label','aria-hidden','aria-expanded','aria-selected','aria-disabled','disabled','type'])if(e.hasAttribute(name))attrs[name]=scrub(e.getAttribute(name));
      return {tag:e.tagName.toLowerCase(),attributes:attrs,children:depth<3?[...e.children].slice(0,options.limit-count).filter(e=>!e.matches('script,style,input,textarea')).map(e=>tree(e,depth+1)).filter(Boolean):[],shadow:e.shadowRoot?'open-not-expanded':'none-or-closed'};
    };data.dom=tree(element,0);data.domCoverage={nodes:count,complete:false,reason:'bounded-light-DOM-no-values'};
  }
  if(facet('computed'))data.computed=Object.fromEntries(properties.map(p=>[p,scrub(style.getPropertyValue(p))]));
  if(facet('box'))data.box={rect:rect(element),client:{width:element.clientWidth,height:element.clientHeight},scroll:{width:element.scrollWidth,height:element.scrollHeight,left:element.scrollLeft,top:element.scrollTop},
    padding:['top','right','bottom','left'].map(s=>style.getPropertyValue('padding-'+s)),border:['top','right','bottom','left'].map(s=>style.getPropertyValue('border-'+s+'-width')),margin:['top','right','bottom','left'].map(s=>style.getPropertyValue('margin-'+s)),transform:style.transform};
  if(facet('layout')) {
    const ancestors=[];for(let e=element.parentElement;e&&ancestors.length<8;e=e.parentElement){const s=getComputedStyle(e);ancestors.push({tag:e.tagName.toLowerCase(),rect:rect(e),overflowX:s.overflowX,overflowY:s.overflowY,position:s.position,zIndex:s.zIndex,transform:s.transform,opacity:s.opacity});}
    data.layout={display:style.display,gap:style.gap,flexDirection:style.flexDirection,gridTemplateColumns:style.gridTemplateColumns,gridTemplateRows:style.gridTemplateRows,
      children:[...element.children].slice(0,options.limit).map(e=>({tag:e.tagName.toLowerCase(),rect:rect(e)})),ancestors,globalPaintOrder:'unknown'};
  }
  if(facet('pseudo'))data.pseudo={states:Object.fromEntries(['hover','focus','focus-visible','disabled','invalid','checked'].map(s=>[s,element.matches(':'+s)])),
    elements:Object.fromEntries(['::before','::after'].map(p=>[p,Object.fromEntries(properties.map(k=>[k,scrub(getComputedStyle(element,p).getPropertyValue(k))]))]))};
  if(facet('accessibility'))data.accessibility={kind:'DOM-heuristic',role:element.getAttribute('role'),name:scrub(element.getAttribute('aria-label')||element.labels?.[0]?.textContent||element.getAttribute('alt')||''),browserAX:'unavailable-in-this-facet',relations:{labelledBy:scrub(element.getAttribute('aria-labelledby'))}};
  if(facet('rules')||facet('source')) {
    const matches=[],inaccessible=[],sources=[];let visited=0;
    for(const sheet of [...document.styleSheets].slice(0,50)){
      sources.push({url:sheet.href||'inline',origin:'stylesheet',originalSourceMap:'not-resolved'});
      const scan=(rules,conditions=[])=>{for(const rule of rules){if(++visited>500)return;
        if(rule.selectorText&&rule.style){let matched=false;try{matched=element.matches(rule.selectorText);}catch{}if(matched&&matches.length<options.limit)matches.push({selector:rule.selectorText.slice(0,350),url:sheet.href||'inline',conditions,declarations:Object.fromEntries(properties.filter(p=>rule.style.getPropertyValue(p)).map(p=>[p,{value:scrub(rule.style.getPropertyValue(p)),important:rule.style.getPropertyPriority(p)==='important'}])),winner:'unknown',sourceRange:'unavailable'});}
        else if(rule.cssRules)scan(rule.cssRules,[...conditions,String(rule.conditionText??rule.name??'group').slice(0,150)]);
      }};
      try{scan(sheet.cssRules);}catch{inaccessible.push(sheet.href||'inline');}
    }
    if(facet('rules'))data.rules={candidates:matches,inline:Object.fromEntries(properties.filter(p=>element.style.getPropertyValue(p)).map(p=>[p,scrub(element.style.getPropertyValue(p))])),inaccessible,visited,complete:false,winner:'unknown',limitations:['inherited-rules-not-expanded','conditions-reported-not-fully-evaluated','layers-and-animation-cascade-not-resolved']};
    if(facet('source'))data.sources=sources;
  }
  return data;
}
export async function inspect({page,doc,args,identity,snapshots,locate}) {
  let target=args.target;
  if(args.point) {
    if(target||args.frame||!args.snapshotId)throw domainError('PolicyDenied','Hit-test richiede snapshotId top-level e nessun target/frame.');
    const snapshot=snapshots.get(args.snapshotId),current=identity(page),state=await page.evaluate(browserState);
    if(snapshot.target.pageId!==current.pageId||snapshot.target.documentEpoch!==current.documentEpoch||!sameState(snapshot.state,state)||snapshot.coherence==='unstable')throw domainError('StaleObservation','Snapshot non più compatibile con il target corrente.');
    const map=snapshot.coordinateMapping;
    if(!map||args.point.x>=snapshot.bitmap.width||args.point.y>=snapshot.bitmap.height)throw domainError('StaleObservation','Punto fuori dalla bitmap server.');
    const x=args.point.x/map.scaleX+map.origin.x,y=args.point.y/map.scaleY+map.origin.y;
    const candidates=await doc.evaluate(({x,y})=>document.elementsFromPoint(x,y).slice(0,5).map(e=>({tag:e.tagName.toLowerCase(),ref:e.getAttribute('data-cortex-ref'),rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}})),{x,y});
    return {data:{target:current,point:{x,y,space:'top-level-viewport-css'},candidates,actionable:false},warnings:['Hit-test corrente: nessun click implicito, identità/occlusione da ricontrollare prima di agire.']};
  }
  if(!target)throw domainError('PolicyDenied','Ispezione richiede target oppure point.');
  const handle=await resolveNode(doc,target,locate);
  try{const data=await handle.evaluate(inspectNode,{facets:args.facets??['computed','box','layout'],properties:args.properties,limit:args.limit??20});
    if(!args.frame&&args.facets?.some(f=>['accessibility','box','computed'].includes(f))) {
      const key=randomUUID(),group='cortex-inspect-'+key;let cdp;
      try {
        await handle.evaluate((e,key)=>{const k=Symbol.for('cortex.inspection.nodes');globalThis[k]??=new Map();globalThis[k].set(key,new WeakRef(e));},key);
        cdp=await page.context().newCDPSession(page);
        await cdp.send('DOM.enable');
        const remote=await cdp.send('Runtime.evaluate',{expression:`globalThis[Symbol.for('cortex.inspection.nodes')].get(${JSON.stringify(key)})?.deref()`,objectGroup:group});
        const objectId=remote.result.objectId;
        if(!objectId)throw domainError('StaleRef','Nodo CDP non più disponibile.');
        const {node}=await cdp.send('DOM.describeNode',{objectId});
        if(args.facets.includes('accessibility')) {
          const {nodes}=await cdp.send('Accessibility.getPartialAXTree',{backendNodeId:node.backendNodeId,fetchRelatives:false});
          data.accessibility={kind:'Chromium-AX',nodes:nodes.slice(0,args.limit??20).map(n=>({ignored:n.ignored,role:n.role?.value,name:n.name?.value??'',
            states:(n.properties??[]).filter(p=>['disabled','expanded','focused','checked','selected','required','invalid','readonly','busy'].includes(p.name)).map(p=>({name:p.name,value:p.value.value}))})),values:'omitted-policy',provenance:'CDP Accessibility.getPartialAXTree'};
          data.accessibility=await handle.evaluate((e,value)=>{const secrets=[...document.querySelectorAll('input,textarea')].map(n=>n.value).filter(Boolean);for(const node of value.nodes)for(const secret of secrets)node.name=node.name.split(secret).join('[redacted]');return value;},data.accessibility);
          data.provenance.accessibility='Chromium-AX';
        }
        if(args.facets.includes('box'))data.box.quads=(await cdp.send('DOM.getBoxModel',{objectId})).model;
        if(args.facets.includes('computed')) {
          await cdp.send('CSS.enable');
          await cdp.send('DOM.getDocument',{depth:0});
          const {nodeIds}=await cdp.send('DOM.pushNodesByBackendIdsToFrontend',{backendNodeIds:[node.backendNodeId]});
          const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:nodeIds[0]});
          data.platformFonts=fonts.slice(0,20);data.provenance.fontUsed='CDP CSS.getPlatformFontsForNode';
        }
      } catch {data.browserDetails={state:'unavailable-error',reason:'CDP node/font/AX facet unavailable; page-derived evidence retained'};}
      finally {
        await cdp?.send('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});await cdp?.detach().catch(()=>{});
        await handle.evaluate((e,key)=>globalThis[Symbol.for('cortex.inspection.nodes')]?.delete(key),key).catch(()=>{});
      }
    }
    return {data:clean({target:identity(page),...data}),warnings:['CSSOM best effort: cascata vincente, font effettivo, shadow chiuso e source map non certificati.']};}
  finally{await handle.dispose();}
}
