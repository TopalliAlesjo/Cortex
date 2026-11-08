# Evoluzione Cortex — incremento di sviluppo, 27 ottobre 2026

Questo incremento non certifica tutta la roadmap: distingue funzioni operative, copertura parziale e verifiche esterne ancora necessarie. Package npm privato; lo stato dei diritti è indicato in LICENSE.

## Attivazione e contratti

La configurazione host `config.toolProfile` sceglie un catalogo immutabile per connessione:

| Profilo | Tool |
|---|---|
| `base` (default) | 4 legacy |
| `visual` | 4 + observe/inspect |
| `diagnostic` | 4 + observe/inspect/capture |
| `extended` | fino a 10; evaluate assente senza `policy.allowScripts: true` |

`config.modules` può selezionare `visual`, `diagnostic`, `evaluate`, `design`, `devtools`. L'ambiente bootstrap `CORTEX_TOOL_PROFILE` seleziona il profilo; il `.env` progetto NON può abilitare moduli, script, debugger o profiling. I permessi avanzati sono esclusivamente `policy.allowScripts`, `policy.allowDebugger`, `policy.allowTrace`. Quest'ultimo abilita timeline target e coverage, non trace globale del browser.

```js
import { createCortexRuntime } from 'cortex-browser-mcp';
const runtime = createCortexRuntime({
  projectPath: '/absolute/project',
  config: { toolProfile: 'diagnostic', origins: ['http://127.0.0.1:8080'] },
  policy: { origins: ['http://127.0.0.1:8080'] }
});
// Per ogni attività: cortex_open({url, newSession:true, capture:true}),
// quindi sessionId su tutti i tool. Nessun browser personale viene riutilizzato.
```

I tool nuovi hanno `contractVersion:1`, `data`, `coverage`, `warnings`, outputSchema e fallback JSON concorde. Le immagini sono blocchi MCP `ImageContent`, mai stringhe dentro structuredContent. `imageDelivery=inline-emitted` significa emissione dal server, non prova della percezione del modello. Le risposte riportano queueMs/serverCallMs misurati, senza includere il tempo del modello.

## Funzioni disponibili

### Osservazione e ispezione

- `cortex_observe`: structure, image, hybrid, diff dei controlli osservati; live, settled o normalized espliciti. Viewport oppure crop/target già visibile, senza scroll automatico. Settled attende font correnti e immagini visibili entro timeout; non prova quiete geometrica universale.
- Font preservati anche nel debug legacy. Live conserva animazioni/caret. Normalized disabilita animazioni/caret e dichiara la possibile emissione di transitionend.
- Le immagini nuove mascherano input, textarea, iframe e `[data-cortex-private]`. Non è una redazione universale di testi aziendali o canvas. Il debug legacy mantiene il file locale esplicitamente richiesto e non cambia policy privacy.
- snapshotId/pageId/epoch, intervallo acquisizione, viewport/scroll/DPR, PNG size/hash, mapping CSS→bitmap, coerenza best-effort/unstable. Nessuna atomicità promessa. Hit-test dalla bitmap server solo con stato ancora compatibile; nessun click a coordinate implicito. Trasformazioni della preview/client non sono note al server.
- `cortex_inspect`: DOM light bounded senza valori input, computed richiesto, CSSOM candidate con condizioni e winner unknown, box/quads Chromium, AX browser parziale, layout/antenati/overflow, pseudo/stati osservati, font effettivi via CDP quando disponibili. Fallback dichiarati per facet non disponibili.
- Frame autorizzati: lettura strutturale e ispezione DOM/CSS locali. Immagini frame, mapping di frame trasformati, script/DevTools frame e AX OOPIF non implementati. Shadow chiusi e source map non risolti. I ref restano verificati sul nodo vivo per le azioni legacy.
- `cortex_run` aggiunge hover/focus/scroll di un contenitore/resize top-level; restano 25 step, 200 atomiche, stop al primo errore. La diff è strutturale, non pixel diff e non valuta qualità estetica.

### Diagnostica e JavaScript

- `cortex_open(capture:true)` arma listener prima del goto; `cortex_capture(start)` acquisisce solo eventi futuri. Una capture attiva/sessione, stop automatico, status/summary/list/detail e paginazione solo dopo seal.
- Context request/response/failure, hop redirect, console warning/error e stack pageerror, identificatori opachi, URL e token riconoscibili redatti. HTTP 500 è risposta ricevuta, non requestfailed.
- WS opzionale: lifecycle e conteggi byte dei frame, payload omesso, massimo 64 socket agganciati. Download: soli metadata, nessun salvataggio. SSE opaco; worker e traffico pre-start non certificati. Le quote riguardano dati gestiti, non i buffer interni Playwright/CDP.
- Body/header/payload off: nessun `response.body()` e nessun refetch. Il requisito body bounded resta **da implementare** con backend streaming o processo dedicato; Content-Length non è una garanzia sufficiente.
- `operationId` opzionale in run, obbligatorio in evaluate. Nei profili estesi run ne genera uno se assente. Il ledger conserva gli ID per la vita della sessione, restituisce il risultato noto per duplicati, rifiuta argomenti diversi e nuovi ID oltre quota. Dopo chiusura/crash non esiste garanzia exactly-once del backend. Il ledger root sopravvive al cleanup idle del browser.
- `cortex_debug(operationId)` legge stato e step; `pages:true` elenca pagine possedute. I nuovi tool accettano pageId posseduti per operazioni mirate. La selezione permanente tab tramite run non è implementata.
- `cortex_evaluate` accetta corpo JavaScript con `return`, `argumentJson`, pageId/epoch e timeout. È sempre potenzialmente mutativo. Nessun accesso Node/host. Serializer bounded senza invocazione volontaria di getter/toJSON, tag per cicli/BigInt/undefined e DOM descriptor.
- Timeout/cancel: control lane timer separata dalla FIFO, tentativo `Runtime.terminateExecution`, chiusura della pagina posseduta, esito unknown e no replay. Non è una sandbox contro renderer compromessi né un hard kill per processo. Proxy/getter ostili possono bloccare il target: serve isolamento di processo per una garanzia più forte.

### Design e DevTools

- `cortex_design`: build/get/compare/export/import di profili v1 in memoria, prove da snapshot della stessa sessione, campioni ordinati di CSS e copertura/stati mancanti. Draft/observed separati dall'approvazione. Import legacy v0/assenza versione migra a v1 senza mutare l'input; versioni future rifiutate. L'import non conserva approvazioni.
- Solo la policy host può approvare campioni tramite `approvedDesign={samplesHash,approver,version}`. Nessun parametro del modello concede approvazione. Export è JSON da salvare esplicitamente tramite host; nessuna persistenza automatica o file input arbitrario.
- La comparison confronta campioni ordinati; non è matching semantico di componenti. URL stylesheet senza hash contenuto non provano freshness: stale può essere unknown. Non certifica estetica, UX, WCAG o soddisfazione utente.
- `cortex_devtools`: metriche CDP, heap usage numerico, conteggi storage senza chiavi/valori/cookie, coverage di esecuzione con lease, pause/resume con auto-resume max 2 s, timeline target limitata a LCP/layout-shift.
- `trace-start` è esplicitamente **target-performance-timeline**, non Tracing globale Chromium. Trace browser-wide, heap snapshot, breakpoint/source debugger e metodi CDP arbitrari restano non disponibili, per evitare esposizione di altre sessioni e payload non bounded.

## Quote e lifecycle

| Risorsa | Limite di questo incremento |
|---|---|
| Dati gestiti runtime | 64 MiB serializzati/riservati condivisi; non RSS |
| Snapshot/sessione | 20, 4 MiB metadata totali, TTL 30 min e sweep periodico |
| PNG/call | max 4 MP CSS, 4 MiB codificati; una immagine/call, nessun file persistente nuovo |
| Capture/sessione | 1 attiva, 4 conservate, 30 s default / 120 s max |
| Eventi | 5000/capture, 4 MiB metadata totali/sessione; drop espliciti |
| Capture sealed | TTL 10 min, sweep 30 s, nessun dettaglio retroattivo |
| Ledger/sessione | 256 ID, tombstone conservati fino a close, risposte cache max 64 KiB |
| Script | 32 KiB codice, 16 KiB argomento JSON, 2 s default/10 s max, risultato 32 KiB, profondità 6 |
| Profilo | 10/sessione, 1 MiB totale, TTL 30 min |
| DevTools | riserva 1 MiB/pagina posseduta, max 10 s coverage/timeline, 1000 eventi timeline |
| Output strutturato | max 64 KiB; richiedere scope/list più piccoli al superamento |

Cleanup su close/session close/idle; collector sganciati, timer cancellati, gruppi oggetti/CDP rilasciati. Immagini nuove in memoria solo durante la call: nessuna promessa di cancellazione degli artifact del debug legacy. Le modalità guarded (cache disabilitata dal routing, SW bloccati) restano invariate e dichiarate. Profilo fidelity e remoto HTTP multi-tenant non introdotti.

## Tracciamento roadmap

| Milestone | Stato implementativo | Gate ancora aperto |
|---|---|---|
| M0 | Contratti, matrice e licenza source available; titolarità confermata dall'autore | Cronologia Git pubblica non ancora creata; verifica indipendente di eventuali diritti pregressi non eseguita |
| M1 | Immagine inline fedele con mask, crop, metadata, hit-test e diff controlli | Canary di percezione su client/modello reali; pixel diff, frame transforms, crop da snapshot originale |
| M2 | Capture preventiva, metadata/console/query/detail, quote e seal | Body/header streaming bounded, SSE/worker completi e coverage backend |
| M3 | DOM/CSSOM/computed/layout/AX/quads/font mirati | Cascata completa, source map, shadow/frame avanzati |
| M4 | Evaluate opt-in, serializer, target epoch, timeout/close e ledger | Processo browser dedicato e hard kill di script ostili |
| M5 | Profili draft/host-approved, import/migrazione/export e comparison | Asset hash/source provenance completi, matching componenti e review indipendente |
| M6 | Timing/cap/diff controlli, harness osservazioni A/B/C | Ablazioni, costo/token dei modelli e protocollo scientifico §12 |
| M7 | Workflow CI nativo previsto e stdio/SDK fixture | Esecuzioni native Linux/macOS, GUI client e remoto autenticato |
| M8 | Metriche/storage counts/heap usage, coverage/timeline target, debugger lease | Heap snapshot, trace globale isolato, debugger sorgenti |

Non marcare l'intera roadmap come completata sulla base di questi smoke. Un confronto con modelli AI, valutatori indipendenti e soak di 60 minuti richiede una campagna distinta.

## Validazione e fonti tecniche

Gate standalone: `npm run test:verify` (unit, browser/stdio, lifecycle, scenari SDK/Chromium e consumer tarball). Risultati locali e istruzioni nel [README](../README.md#verifica-e-risoluzione-problemi).

Riferimenti primari consultati: [MCP Tools e ImageContent](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [Playwright screenshot](https://playwright.dev/docs/api/class-page#page-screenshot), [Chromium PerformanceTimeline](https://chromedevtools.github.io/devtools-protocol/tot/PerformanceTimeline/). L'implementazione è confrontata anche con il codice Playwright installato 1.58.2; upstream corrente non costituisce certificazione della versione fissata.

Riavviare il server Cortex e riconnettere il client per caricare codice/catalogo aggiornati. Se cambia il lockfile, eseguire `npm ci --ignore-scripts`; se cambia Playwright, reinstallare il browser con `npm run browser:install`.
