# Provenienza e licenze

| Componente | Versione | Licenza dichiarata |
|---|---|---|
| @modelcontextprotocol/sdk | 1.32.1 | MIT |
| dotenv | 17.3.1 | BSD-2-Clause |
| playwright / playwright-core | 1.58.2 | Apache-2.0 |
| fsevents, opzionale macOS | 2.3.2 | MIT |
| @hono/node-server, transitiva SDK | 2.1.6 | MIT |

I testi delle dipendenze sono distribuiti nei rispettivi package npm installati. Chromium e i suoi componenti hanno notice propri nella distribuzione browser; non sono inclusi nel tarball Cortex.

Core e test sono stati trasferiti dal precedente progetto contenitore alla baseline 9def48b5deee08ec4bb842447c9b814367645850 (23 ottobre 2026). L'origine Cortex Browser MCP 0.1.0 è conservata nei sorgenti. Il package contenitore dichiarava ISC; ciò non modifica le licenze delle dipendenze.

L'8 novembre 2026 l'autore ha confermato di avere creato il codice Cortex e di esserne proprietario, autorizzandone la pubblicazione con divieto di rivendita. I materiali Cortex di questa distribuzione sono rilasciati sotto la licenza personalizzata in LICENSE. La conferma è dell'autore, non una ricostruzione indipendente della catena dei diritti. Eventuali diritti validamente concessi in precedenza restano disciplinati dalle relative licenze.

I nuovi adattamenti comprendono configurazione, provider, lifecycle, adapter stdio e verifica autonoma. Le dipendenze npm e Chromium conservano le proprie licenze, senza il divieto di rivendita Cortex. Il lockfile identifica le versioni transitive; i loro testi/notice restano nei rispettivi package.
