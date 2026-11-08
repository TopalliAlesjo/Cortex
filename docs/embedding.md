# Embedding

~~~js
import { createCortexRuntime } from 'cortex-browser-mcp';
const runtime = createCortexRuntime({
  config: { origins: ['https://example.test'] },
  policy: { origins: ['https://example.test'] },
  idleTimeoutMs: 600000,
  maxPending: 64
});
try {
  const opened = await runtime.call('cortex_open', {
    url: 'https://example.test', newSession: true
  });
  const sessionId = opened.structuredContent.sessionId;
  const controller = new AbortController();
  await runtime.call('cortex_peek', { sessionId }, { signal: controller.signal });
} finally {
  await runtime.close();
}
~~~

API: definitions, call(name,args,options?), close(). call restituisce lo stesso envelope dei tool MCP: content, structuredContent e isError solo nei fallimenti. Il core non importa SDK MCP, non installa process hook e non modifica console globale.

createCortexMcpServer({runtime}) da cortex-browser-mcp/mcp restituisce server, runtime e close: l'host sceglie come collegare un trasporto; questa distribuzione fornisce solo CLI stdio.

Close è idempotente e terminale: nuove chiamate restituiscono RuntimeClosed. Il browser posseduto viene chiuso; mai attach al browser personale.
L'idle timer opera solo quando non ci sono richieste attive o accodate. Libera browser e sessioni; una nuova call può avviare un nuovo browser, ma vecchi ID non vengono ricreati.

Le call sono serializzate globalmente, coda maxPending (default 64). La cancellazione di una call accodata la rimuove prima dell'esecuzione. Quella attiva chiude la pagina del flusso e attende il lavoro prima della call successiva. Non annulla operazioni già ricevute dall'applicazione web.
Startup Playwright ha timeout 30s; budget engine 60s, senza attesa in coda. La cancellazione prima che la pagina sia disponibile viene applicata appena lo startup termina. Il timeout client non equivale a rollback.
