// Adapted from Cortex Browser MCP 0.1.0 (local archive); no second MCP runtime.
export const short = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export function permitted(url, origins) {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && origins.includes(u.origin); }
  catch { return false; }
}
export const sensitive = text => /\b(elimina|eliminare|cancella|cancellare|delete|remove|invia|send|paga|pay|approva|approve|pubblica|publish)\b/i.test(text);
export const result = (body, isError = false) => ({content:[{type:'text',text:JSON.stringify(body)}],structuredContent:body,...(isError?{isError:true}:{})});
export function safeUrl(value) {
  try { const u = new URL(value); return short(`${u.origin}${u.pathname}`, 180); }
  catch { return ''; }
}
export function redact(value) {
  const text=String(value??'');
  if(/^\s*[\[{]/.test(text)) {
    try {return JSON.stringify(redactData(JSON.parse(text)));}catch{/* Fall back for prefixed or truncated console text. */}
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, value => safeUrl(value))
    .replace(/\b(?:Bearer\s+)[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|session(?:id)?|phpsessid)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}\]]+)/gi, '$1=[redacted]');
}
const secretKey=/^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|session(?:[_-]?id)?|phpsessid)$/i;
// Values here are detached JSON/browser-serializer data, never live page objects.
export function redactData(value) {
  if(typeof value==='string')return redact(value);
  if(Array.isArray(value))return value.map(redactData);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[redact(key),secretKey.test(key)?'[redacted]':redactData(item)]));
  return value;
}
export function errorInfo(e) {
  // Never forward Playwright messages: call logs can contain fill values and URLs.
  const message=String(e?.message || '');
  const safeMessage=e?.cortexMessage || (/Executable doesn't exist/i.test(message) ? 'Chromium non installato per questa versione di Playwright. Dalla cartella Cortex eseguire npm run browser:install, poi riavviare il server MCP.'
    : /Chromium sandboxing failed|No usable sandbox|Failed to move to new namespace|SUID sandbox helper|Running as root without --no-sandbox/i.test(message) ? 'Sandbox Chromium non disponibile. Su Linux usare un utente non root e configurare il sandbox helper o il profilo AppArmor; vedere docs/security.md. Cortex mantiene la sandbox abilitata.'
    : e?.name==='TimeoutError' ? 'Timeout dello step; verificare stato e target con cortex_debug.'
    : /strict mode violation/i.test(message) ? 'Target ambiguo: usare withinRow o un selettore univoco.'
    : /executable|browserType.launch|browser.*closed/i.test(message) ? 'Browser non disponibile; verificare eseguibile e sessione.'
    : /interrupted by another navigation/i.test(message) ? 'Navigazione interrotta da un altro caricamento; riaprire la pagina.'
    : /net::|ERR_/i.test(message) ? 'Navigazione o richiesta di rete fallita; consultare cortex_debug.'
    : 'Operazione fallita; usare cortex_debug o un peek mirato.');
  return {kind:short(e?.name || 'Error',40),message:safeMessage};
}
export function fail(message) { const error = new Error(message); error.cortexMessage = message; return error; }

// One validator for the engine and the session envelope: identical diagnostics
// must precede actions regardless of whether sessionId is supplied.
export function validateCortexArguments(value,spec,location='arguments') {
  if(spec.type==='object') {
    if(!value||typeof value!=='object'||Array.isArray(value))throw fail('Argomenti non validi.');
    if(Object.keys(value).some(key=>!Object.hasOwn(spec.properties,key)))throw fail('Parametro non supportato.');
    for(const key of spec.required||[])if(!Object.hasOwn(value,key))throw fail('Parametro obbligatorio mancante.');
    for(const [key,item] of Object.entries(value))validateCortexArguments(item,spec.properties[key],`${location}.${key}`);
  } else if(spec.type==='array') {
    if(!Array.isArray(value)||value.length<(spec.minItems??0)||value.length>(spec.maxItems??Infinity))throw fail('Numero elementi fuori limite.');
    for(const [index,item] of value.entries()) {
      try {validateCortexArguments(item,spec.items,`${location}[${index}]`);}
      catch(error) {error.cortexFailedAt=index+1;throw error;}
    }
  } else {
    if(spec.type==='integer'?!Number.isInteger(value):spec.type==='number'?!Number.isFinite(value):typeof value!==spec.type)throw fail('Tipo parametro non valido.');
    if(spec.minLength!==undefined&&value.length<spec.minLength||spec.maxLength!==undefined&&value.length>spec.maxLength)throw fail('Lunghezza parametro non valida.');
    if(spec.minimum!==undefined&&value<spec.minimum||spec.maximum!==undefined&&value>spec.maximum)throw fail(`Parametro fuori intervallo: ${location} (${spec.minimum??'-'}..${spec.maximum??'+'}).`);
    if(spec.enum&&!spec.enum.includes(value))throw fail('Valore parametro non supportato.');
    if(spec.pattern&&!new RegExp(spec.pattern).test(value))throw fail('Formato parametro non valido.');
  }
}
