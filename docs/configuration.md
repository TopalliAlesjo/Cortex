# Configurazione

Precedenza: default sicuri < ambiente acquisito alla creazione runtime < .env del project_path esplicito < config dell'host. Il file progetto è riletto a ogni chiamata; process.env non viene modificato.
--project nella CLI fornisce il progetto predefinito. project_path del tool rimane esplicito e deve essere assoluto. Nessun .env viene letto dal cwd implicitamente.

| Variabile | Valore |
|---|---|
| CORTEX_ALLOWED_ORIGINS | Obbligatoria, origin HTTP(S) esatti separati da virgola; niente wildcard/slash finale/credenziali |
| CORTEX_HEADLESS | Default true; esattamente false abilita headed |
| CORTEX_CHROME_PATH | Eseguibile esplicito; altrimenti Chromium della versione Playwright |
| CORTEX_PROFILE_DIR | Profilo root dedicato persistente, opt-in |
| CORTEX_ARTIFACTS | Default ~/.cortex/artifacts; PNG locali su richiesta |
| PLAYWRIGHT_BROWSERS_PATH | Discovery/cache supportata da Playwright |

Path relativi richiedono progetto esplicito e sono risolti su quel progetto. Alias transitori BROWSER_HEADLESS e BROWSER_EXECUTABLE_PATH sono accettati solo in assenza dei corrispondenti CORTEX_*.
BROWSER_TOOL_PROFILE, ALLOWED_URLS, ALLOW_FILE_URLS e PLAYWRIGHT_CDP_URL non abilitano capability o autorizzazioni.

Le opzioni embedding config sono origins, artifacts, headless, executablePath, profileDir. La policy fiduciarIa (origins, projectRoots, artifactRoots, profileRoots) è un tetto non sovrascrivibile dal progetto.
Le root policy sono assolute, controllate anche attraverso symlink/junction esistenti. Non si tratta di una difesa da modifiche concorrenti ostili del filesystem.

La configurazione launch è fissata dal primo avvio e non può cambiare per i contesti isolati successivi. Per cambiare eseguibile/headless/profilo: nuova istanza runtime.
Una sessione isolata eredita project_path iniziale; non può cambiarlo. Il profilo persistente root non è ereditato dai contesti isolati.

## Moduli opzionali (0.2.0-dev.1)

`config.toolProfile` / ambiente bootstrap `CORTEX_TOOL_PROFILE`: `base` (4 tool, default), `visual` (6), `diagnostic` (7), `extended` (fino a 10).
`config.modules` seleziona esplicitamente `visual`, `diagnostic`, `evaluate`, `design`, `devtools`.
Discovery congelata alla creazione: queste capability non leggono il `.env` del progetto.
`policy.allowScripts: true` è obbligatorio per pubblicare evaluate; `allowDebugger` abilita pause/resume, `allowTrace` abilita coverage/timeline. I flag CLI equivalenti sono `--profile`, `--allow-scripts`, `--allow-debugger`, `--allow-profiling`.
`policy.approvedDesign={samplesHash,approver,version}` approva solo campioni con hash esatto fornito dall'host.
Vedere [evolution.md](evolution.md) per limiti, quote, compatibilità e superfici non implementate.
