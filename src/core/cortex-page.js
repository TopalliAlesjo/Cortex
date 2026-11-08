// Runs in the selected browser document. No caller-supplied JavaScript is executed.
export function readCortexPage(options) {
  const {mode='controls',query='',limit=20,offset=0,tableOffset=0,scope,items,fields=[],prefix,maxChars=8000,nodes=[],action,hint='',expectedScopeRef}=options;
  const key=Symbol.for('cortex.refs');
  if(!document[key]) Object.defineProperty(document,key,{value:{prefix,next:0,nodes:new WeakMap(),refs:new Map()}});
  const registry=document[key];
  const visible=e=>Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');
  const secrets=[...document.querySelectorAll('input,textarea')].filter(e=>e.type==='password'||/password|token|secret|cookie|session|api.?key/i.test(`${e.name} ${e.id}`)).map(e=>e.value).filter(Boolean);
  const normalized=v=>String(v??'').replace(/\s+/g,' ').trim();
  const cleaned=v=>{let text=normalized(v);for(const secret of secrets)text=text.split(secret).join('[redacted]');return text;};
  const clip=(v,max=105)=>cleaned(v).slice(0,max);
  const text=e=>{
    if(!e||!visible(e)||e.matches('input,textarea,select,script,style'))return '';
    const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);
    const parts=[];let node;
    while((node=walker.nextNode()))if(!node.parentElement.closest('input,textarea,select,script,style')&&visible(node.parentElement))parts.push(node.textContent);
    return cleaned(parts.join(' '));
  };
  const name=e=>e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ')||e.labels?.[0]?.textContent||e.getAttribute('placeholder')||e.getAttribute('title')||(e.matches('input[type="submit"],input[type="reset"],input[type="button"]')?e.getAttribute('value'):null)||(e.matches('input,textarea')?e.name||e.id:text(e)||e.querySelector('img[alt],img[title]')?.getAttribute('alt')||e.querySelector('img[title]')?.title);
  const ref=e=>{
    let id=registry.nodes.get(e);
    if(!id||registry.refs.get(id)?.deref()!==e){id=`${registry.prefix}-e${++registry.next}`;registry.nodes.set(e,id);registry.refs.set(id,new WeakRef(e));}
    e.setAttribute('data-cortex-ref',id);
    // Bound the session's ephemeral registry, never retain old DOM nodes strongly.
    while(registry.refs.size>5000)registry.refs.delete(registry.refs.keys().next().value);
    return id;
  };
  const describe=(e,context=false,label=clip(name(e),85))=>{
    const role=e.getAttribute('role')||(e.tagName==='INPUT'?e.type||'input':e.tagName.toLowerCase());
    const implicit=e.matches('a[href]')?'link':e.matches('textarea,input[type="text"],input:not([type]),input[type="email"],input[type="url"],input[type="tel"]')?'textbox':e.matches('input[type="search"]')?'searchbox':e.matches('select')?(e.multiple||e.size>1?'listbox':'combobox'):e.matches('button,input[type="submit"],input[type="button"],input[type="reset"]')?'button':null;
    const ariaRole=e.getAttribute('role')||implicit;
    const states={};
    for(const state of ['expanded','selected','checked','required']){
      const value=e.getAttribute(`aria-${state}`);
      if(value!==null)states[state]=value==='true'?true:value==='false'?false:clip(value,12);
    }
    if(e.matches('input[type=checkbox],input[type=radio]'))states.checked=e.checked;
    if(e.matches('summary'))states.expanded=e.parentElement?.open===true;
    let href;
    if(context&&e.matches('a[href]')){
      try{const url=new URL(e.getAttribute('href'),document.baseURI);if(['http:','https:'].includes(url.protocol))href=clip(`${url.origin}${url.pathname}`,180);}catch{/* no raw URL */}
    }
    const row=context?clip(text(e.closest('tr,[role="row"]')),120):'';
    return {ref:ref(e),role,...(ariaRole&&ariaRole!==role?{ariaRole}:{}),name:label,...states,...(href?{href}:{}),...(row?{row}:{}),...(e.disabled?{disabled:true}:{})};
  };
  // Internal projection: only exact matched nodes supplied by the server, max 5.
  if(mode==='candidates')return {candidates:nodes.slice(0,5).filter(visible).map(e=>describe(e,true))};
  let root;
  if(scope){const matches=document.querySelectorAll(scope);if(!matches.length)throw new Error('CortexScopeMissing');if(matches.length!==1)throw new Error(`CortexScopeAmbiguous:${matches.length}`);root=matches[0];}
  else root=[...document.querySelectorAll('[role="dialog"],dialog[open],.modal.show,.modal.in')].find(visible)||document.querySelector('main')||document.body;
  if(expectedScopeRef&&(!root?.isConnected||registry.refs.get(expectedScopeRef)?.deref()!==root))throw new Error('CortexScopeStale');
  if(!root)return {controls:[],tables:[],alerts:[],moreControls:false};
  const includingRoot=selector=>[...(root.matches(selector)?[root]:[]),...root.querySelectorAll(selector)];
  if(mode==='recovery') {
    const selector=action==='fill'?'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),textarea,[contenteditable="true"]':action==='select'?'select':['check','uncheck'].includes(action)?'input[type="checkbox"],input[type="radio"],[role="checkbox"]':'button,input[type="submit"],a[href],summary,[role="button"],[role="tab"]';
    const all=includingRoot(selector).filter(e=>visible(e)&&!e.disabled&&!e.readOnly);
    const exact=hint?all.filter(e=>cleaned(name(e))===hint):[];
    return {controls:(exact.length?exact:all).slice(0,5).map(e=>describe(e,true))};
  }
  const match=v=>!query||cleaned(v).toLowerCase().includes(query.toLowerCase());
  const fieldValues=e=>{
    const row=Object.create(null),truncated=[];
    for(const field of fields){
      const nodes=field.selector&&field.selector!==':scope'?[...e.querySelectorAll(field.selector)].filter(visible):[e];
      if(nodes.length>1)throw new Error('CortexFieldAmbiguous');
      const node=nodes[0];let value=null;
      if(node&&!node.matches('input,textarea,select')){
        if(!field.attribute||field.attribute==='text')value=text(node);
        else if(field.attribute==='name')value=cleaned(name(node));
        else if(field.attribute==='href'){
          const raw=node.getAttribute('href');
          if(raw){try{const url=new URL(raw,document.baseURI);if(['https:','http:'].includes(url.protocol))value=`${url.origin}${url.pathname}`;}catch{/* no raw URLs */}}
        }else value=cleaned(node.getAttribute(field.attribute));
      }else if(node&&field.attribute==='checked'&&['checkbox','radio'].includes(node.type))value=node.checked;
      if(typeof value==='string'&&value.length>(field.maxLength||300)){value=value.slice(0,field.maxLength||300);truncated.push(field.name);}
      row[field.name]=value;
    }
    if(truncated.length)row.truncatedFields=truncated;
    return row;
  };
  if(mode==='extract'||mode==='refs'){
    const all=(items===':scope'?[root]:[...root.querySelectorAll(items||'tbody tr')]).filter(visible);
    const records=[];let used=0;
    for(const node of all.slice(offset,offset+limit)){
      const row={...(mode==='refs'?{ref:ref(node)}:{}),...fieldValues(node)};
      const size=JSON.stringify(row).length;
      if(used+size>maxChars)break;
      records.push(row);used+=size;
    }
    const nextOffset=offset+records.length;
    return {records,total:all.length,offset,...(nextOffset<all.length?{nextOffset}:{}),incomplete:nextOffset<all.length||records.some(r=>r.truncatedFields)};
  }
  const controls=[];let moreControls=false;
  if(mode==='controls'){
    let skipped=0;
    for(const e of includingRoot('button,input:not([type="hidden"]),textarea,select,a[href],summary,[role="button"],[role="combobox"],[role="tab"],[role="checkbox"]')){
      if(!visible(e))continue;
      const label=clip(name(e),85),rowText=clip(e.closest('tr,[role="row"]')?.textContent,160);
      if(!match(`${label} ${rowText}`))continue;
      if(skipped++<offset)continue;
      if(controls.length===limit){moreControls=true;break;}
      controls.push(describe(e,Boolean(query),label));
    }
  }
  const tables=[];let moreTables=false,skipped=0;
  for(const table of includingRoot('table,[role="grid"],[role="table"]').filter(visible)){
    const rows=[...table.querySelectorAll('tbody tr,[role="row"]')].filter(visible);
    const section=table.closest('[role="tabpanel"],section,article,details');
    const title=table.getAttribute('aria-label')||table.querySelector('caption')?.textContent||document.getElementById(section?.getAttribute('aria-labelledby'))?.textContent||section?.querySelector('h1,h2,h3,h4,summary')?.textContent;
    const sectionMatch=Boolean(query&&title&&match(title)),matched=rows.filter(r=>sectionMatch||match(r.textContent));
    if(query&&!sectionMatch&&!matched.length&&!match(table.textContent))continue;
    if(skipped++<tableOffset)continue;
    if(tables.length===3){moreTables=true;break;}
    const count=mode==='grid'?limit:3,selected=matched.slice(offset,offset+count);
    tables.push({columns:[...table.querySelectorAll('th,[role="columnheader"]')].slice(0,12).map(h=>clip(text(h),40)),domRows:rows.length,...(title?{title:clip(title)}:{}),matched:selected.map(r=>clip(text(r),150)),...(offset+selected.length<matched.length?{nextOffset:offset+selected.length}:{}),...(selected.some(r=>text(r).length>150)?{truncated:true}:{})});
  }
  const alerts=includingRoot('[role="alert"],.alert-danger,.alert-success,.toast,.errorSummary,.validation-summary-errors').filter(visible).slice(0,4).map(e=>clip(text(e),150));
  return {heading:clip(text(root.querySelector('h1,h2'))),controls,tables,alerts,moreControls,...(moreControls?{nextOffset:offset+controls.length}:{}),...(moreTables?{moreTables:true,nextTableOffset:tableOffset+tables.length}:{})};
}
