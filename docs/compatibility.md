# Compatibilità

Baseline sorgente: 9def48b5deee08ec4bb842447c9b814367645850.

Conservati i quattro nomi/input/output, sessionId/newSession/closeSession, ref ed estrazioni mirate, limiti 25 step/200 atomiche/each max50, cookie e storage nel contesto, errori e screenshot esplicito.
Il namespace interno ref è cortex.refs; gli ID non persistono e non si migrano tra processi.

Cambi intenzionali:
- Identità MCP cortex, versione corrente 0.2.0-dev.1.
- Assenti browser_* e BROWSER_TOOL_PROFILE legacy/all.
- Artifact default ~/.cortex/artifacts; niente path Sophia.
- Core, API embedding e CLI indipendenti; close runtime terminale.
- Coda bounded e cancellazione esplicita; FIFO anche tra sessioni.
- Policy host opzionale come tetto; path relativi senza progetto rifiutati.
- Launch config immutabile dopo avvio; sandbox Chromium abilitata.
- Nessun monitoring legacy o contenuto console/rete raccolto dalla sessione root.
- Persistent profile solo root; nessun browser personale o CDP esterno.

Node >=24.22.1 <25, npm >=11.19.1. Dipendenze iniziali fissate: SDK 1.32.1, dotenv 17.3.1, Playwright 1.58.2 e Chromium 145.0.7632.6.
La verifica locale è stata eseguita su Windows; la matrice CI include Linux, Windows e macOS. Risultati e comando di verifica sono nel [README](../README.md#verifica-e-risoluzione-problemi). macOS significa Chromium su macOS, non Safari/DevTools Safari.

Incremento `0.2.0-dev.1`: default sempre 4 tool; profili opzionali 6/7/fino a 10, contratti nuovi v1. Run aggiunge operationId e hover/focus/scroll/resize; debug può leggere ledger/pagine nei profili estesi. I blocchi immagine vengono conservati nell'envelope delle sessioni isolate.
Screenshot legacy ora fedele ai font/animazioni della pagina: modifica intenzionale della prova visiva; nomi e screenshotLocal preservati.
Il lockfile include aggiornamenti di manutenzione delle dipendenze transitive. Dopo un aggiornamento del checkout eseguire `npm ci --ignore-scripts`; se cambia Playwright, ripetere `npm run browser:install`. Riavviare Cortex/riconnettere il client per caricare codice e catalogo.
Stato dettagliato della roadmap e limitazioni: [evolution.md](evolution.md). Verifica: [README](../README.md#verifica-e-risoluzione-problemi).
