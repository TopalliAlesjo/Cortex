# Sicurezza

Preservati proxy HTTP/CONNECT/Upgrade su loopback, origin esatti, route Playwright, controllo Location redirect tramite CDP interno e service worker bloccati.
Nessun trasporto MCP HTTP remoto o attach CDP esterno. JavaScript arbitrario browser soltanto con capability host esplicita; non dispone di Node/filesystem. I quattro tool Cortex legacy restano disponibili; nessun namespace browser_* Sophia.

Il browser usa la sandbox Chromium predefinita abilitata: nessun --no-sandbox. Su Linux root/container predisporre un utente e un ambiente sandbox compatibili; non si applica un fallback permissivo.

Sessioni isolate: massimo 4, massimo 3 pagine per contesto. TTL 10 minuti, cleanup alla chiamata successiva. Cookie/localStorage/ref/diagnostica separati; processo browser condiviso, non isolamento OS.
La sessione senza sessionId rimane condivisa. Usare newSession:true per attività indipendenti.

Redazione di token riconoscibili e URL senza query/fragment; niente valori input o log rete/console integrali nell'output. Testi visibili, path URL e PNG possono comunque contenere dati aziendali.
Debug legacy: screenshot esclusivamente richiesto, PNG viewport locale creato in modo esclusivo con permessi privati dove supportati; retention a cura dell'host.
Observe opzionale: ImageContent inline, massimo 4 MP CSS/4 MiB PNG, maschera input/textarea/iframe/data-cortex-private, nessun file persistente. Non sostituisce una policy privacy sui dati visibili/canvas. I font non vengono più sostituiti.
La policy host può limitare progetti, artifact e profili; in sua assenza il client locale dispone delle autorizzazioni filesystem del processo.

allowDestructive è un override dell'euristica sulle etichette, non RBAC o autorizzazione al pagamento/invio/eliminazione.
StaleRef e AmbiguousTarget dichiarano lo step non eseguito; altri errori/timeout non danno la stessa garanzia. Non ripetere batch completati o con esito incerto.

Il proxy non è un firewall OS: non garantisce contenimento di Chromium compromesso, processi esterni, DNS rebinding o ogni protocollo browser. Nessun bypass TLS/certificate replacement.
La licenza è descritta in [licensing.md](licensing.md); le verifiche disponibili sono nel [README](../README.md#verifica-e-risoluzione-problemi). Eseguire `npm audit --omit=dev` per controllare le segnalazioni correnti delle dipendenze; i test non costituiscono una certificazione generale di sicurezza.

Le capture sono opt-in e preventive: console/rete redatte entro quote, body/header off. Le finestre sealed sono immutabili e scadono; nessun refetch per recuperare contenuti mancanti. I limiti sono su dati gestiti, non RSS o buffer interni del browser.
Evaluate timeout/cancel usa control lane e chiusura della pagina posseduta; esito unknown non autorizza replay. Il browser condiviso non fornisce isolamento di processo contro codice ostile.
DevTools non espone CDP arbitrario né trace browser-wide/heap snapshot/storage values. Debugger e profiling richiedono permessi host separati e hanno lease automatiche.
Dettagli e gap: [evolution.md](evolution.md). Nessuna certificazione fidelity/cache/SW, remoto multi-tenant o sandbox avversariale introdotta.
