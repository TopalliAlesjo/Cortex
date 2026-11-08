# Cortex Browser MCP

Automazione browser per agenti AI: **letture mirate e azioni in batch**, usando Chromium tramite Playwright e il protocollo MCP su stdio.

Cortex punta a ridurre il contesto superfluo e i passaggi tra agente e browser: apri una pagina, leggi i controlli o i dati necessari, esegui più azioni e verifiche in una chiamata. Il profilo predefinito espone quattro tool.

**Prima prova dell'autore con Codex: circa +70% di velocità stimata e 20% in meno di quota consumata nella finestra di 5 ore rispetto a Playwright MCP.** L'autore ha dato lo stesso prompt a Codex una volta con Playwright MCP e una con Cortex, confrontando minutaggio e variazione della quota. È un risultato riferito dall'autore su quel confronto, non ancora riprodotto indipendentemente. La quota osservata non è un conteggio diretto dei token.

**Stato:** anteprima `0.2.0-dev.1`. Funzioni e limiti in [evolution.md](docs/evolution.md). Codice source available: uso e modifiche consentiti, rivendita e servizi Cortex a pagamento vietati senza accordo separato. Vedere [licenza](LICENSE), [spiegazione](docs/licensing.md) e [provenienza](THIRD_PARTY_NOTICES.md).

## Cosa fa

| Tool base | Uso |
|---|---|
| `cortex_open` | Apre un URL autorizzato, senza snapshot automatico. |
| `cortex_peek` | Cerca controlli, legge griglie o estrae campi selezionati con limiti e paginazione. |
| `cortex_run` | Esegue azioni e assert in batch, anche su record ripetuti con `each`. |
| `cortex_debug` | Restituisce diagnostica compatta, salva uno screenshot su richiesta e chiude sessioni isolate. |

Esempi: compilare form, verificare flussi AJAX, leggere tabelle, espandere sezioni ripetute e controllare il risultato senza rileggere ogni volta tutta la pagina.

Profili opzionali aggiungono screenshot inline MCP, ispezione DOM/CSS/accessibilità, capture preventiva di rete/console e strumenti di sviluppo. JavaScript arbitrario, debugger e profiling richiedono permessi espliciti dell'host. Vedere [funzioni e limiti](docs/evolution.md).

## Installazione da sorgente

Richiede **Node >=24.22.1 <25** e **npm >=11.19.1**. La versione Node di riferimento è in `.nvmrc`. Serve anche il Chromium della versione Playwright fissata nel lockfile.

Dalla cartella del progetto:

```sh
npm ci --ignore-scripts
npm run browser:install
```

Su Linux, se mancano librerie di sistema, usare `npx playwright install --with-deps chromium` con le autorizzazioni necessarie. L'avvio MCP non scarica browser automaticamente.

## Collegamento al client MCP

Adatta il percorso assoluto e gli origin autorizzati nell'[esempio JSON](examples/mcp.json):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["C:/cortex/bin/cortex.mjs"],
      "env": {
        "CORTEX_ALLOWED_ORIGINS": "http://127.0.0.1:8080"
      }
    }
  }
}
```

Su Linux/macOS sostituisci il percorso con quello del checkout. Se il client non trova Node, usa il percorso assoluto del suo eseguibile. Il file va nella configurazione del tuo client: non è letto automaticamente da Cortex.

Gli origin sono esatti, inclusa la porta, senza slash finale. Autorizza anche API, asset o destinazioni di login esterni necessari alla pagina. Nessuna wildcard. Senza origin validi le chiamate browser sono rifiutate.

Per una prova manuale in PowerShell:

```powershell
$env:CORTEX_ALLOWED_ORIGINS = 'http://127.0.0.1:8080'
node bin/cortex.mjs
```

Il processo attende un client MCP su stdio: **non apre una pagina web e non stampa un banner**. Il browser viene avviato alla prima chiamata valida, dopo `initialize` e `tools/list`.

Il `.env` del progetto viene letto solo passando `--project <percorso-assoluto>` oppure `project_path` al tool. Il solo fatto di avviare Cortex dalla cartella contenente `.env` non lo carica. Altri dettagli: [configurazione](docs/configuration.md).

## Flusso di utilizzo

1. Chiama `cortex_open` con `url` e `newSession: true`.
2. Conserva il `sessionId` restituito e passalo alle chiamate successive.
3. Usa `cortex_peek` per ottenere controlli e ref correnti.
4. Esegui azioni e verifiche con `cortex_run`.
5. Chiudi con `cortex_debug` e `closeSession: true`.

Esempio di argomenti per `cortex_run`, dopo aver verificato i target nella pagina:

```json
{
  "sessionId": "ID_RESTITUITO_DA_CORTEX_OPEN",
  "operationId": "ricerca-1",
  "steps": [
    {"op": "fill", "target": "label:Nome", "value": "Mario"},
    {"op": "click", "target": "role:button|Cerca"},
    {"op": "expect_text", "target": "#status", "value": "Ricerca completata"}
  ]
}
```

Un batch ammette fino a 25 step e 200 operazioni atomiche, con budget di 60 secondi. Non è una transazione: gli effetti già prodotti rimangono anche se uno step fallisce. Dopo timeout o cancellazione verifica lo stato prima di riprovare. `operationId` consente di riconoscere duplicati nella stessa sessione, entro le quote del registro; non è una garanzia di esecuzione unica dell'applicazione remota.

## Verifica e risoluzione problemi

```sh
npm test
```

Il gate esegue unit test, integrazione Chromium/stdio, lifecycle, profili estesi e installazione del tarball in un consumer temporaneo. Usa fixture locali; richiede Chromium installato e accesso al registry npm per il consumer.

Ultima verifica locale: Windows x64 con Node 24.22.1 e npm 11.20.0, 37 test unitari, 19 scenari MCP estesi e gate completo superati. La matrice GitHub Actions include Linux, Windows e macOS; questi risultati locali non certificano gli altri sistemi.

| Problema | Controllo |
|---|---|
| `EBADENGINE` | Controlla `node --version` e `npm --version`, anche nel processo avviato dal client. |
| Chromium non installato | Esegui `npm run browser:install` nella cartella Cortex. |
| Origin non consentito | Controlla schema, host, porta e origin di redirect/API/asset. |
| Il terminale sembra fermo | È normale: stdio attende richieste MCP. |
| Un ref non è più valido | Esegui un nuovo peek mirato e riprendi dallo step fallito. |

## Efficienza e confronto

Le scelte concrete sono letture selettive, nessuno snapshot automatico all'apertura, catalogo base di quattro tool e batch di azioni/assert. Possono ridurre dati restituiti e chiamate MCP nei flussi adatti.

La prima prova dell'autore con Codex ha riportato il vantaggio indicato sopra; non è ancora disponibile un benchmark comparativo riproducibile che ne stabilisca la generalità o misuri il risparmio in token e costo. Il pilot incluso misura solo Cortex su una fixture sintetica, senza modello AI o conteggio token, ed è distinto dalla prova dell'autore. Playwright MCP offre a sua volta opzioni per ridurre gli snapshot.

Cortex usa Chromium, stdio locale e una coda globale: non offre esecuzione browser parallela, attach al browser personale, Firefox/WebKit o un servizio MCP remoto multiutente.

## Documentazione

- [Configurazione](docs/configuration.md) e [API embedding](docs/embedding.md).
- [Sicurezza](docs/security.md), [compatibilità](docs/compatibility.md) e [roadmap](docs/evolution.md).

Il package resta `private: true`: la pubblicazione su npm è disabilitata. I rapporti interni, i file ambiente, i profili e gli artifact locali sono esclusi dal repository previsto tramite `.gitignore`; i file distribuibili via npm sono limitati anche dal campo `files` di `package.json`.
