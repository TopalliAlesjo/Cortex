import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createCortexRuntime } from '../index.js';
export function createCortexMcpServer({runtime=createCortexRuntime()}={}) {
  const server=new Server({name:'cortex',version:'0.2.0-dev.1'},{
    capabilities:{tools:{}},
    instructions:'Usa cortex_open con newSession=true, conserva sessionId, peek mirati e cortex_run in batch. Se presenti nel catalogo: observe per pixel fedeli, inspect per layout, capture prima delle azioni. JavaScript/DevTools solo con capability host. Chiudi la tua sessione con cortex_debug(closeSession=true). Dopo timeout consulta operationId/stato, nessun replay automatico.'
  });
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:structuredClone(runtime.definitions)}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>runtime.call(request.params.name,request.params.arguments??{},{signal:extra.signal}));
  return {server,runtime,async close(){await runtime.close();await server.close();}};
}
