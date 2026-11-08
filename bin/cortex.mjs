#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCortexRuntime } from '../src/index.js';
import { createCortexMcpServer } from '../src/mcp/server.js';
import { errorInfo } from '../src/core/cortex-utils.js';
async function main() {
if(process.argv.includes('--help')) {
  process.stdout.write('Cortex MCP: node bin/cortex.mjs [--project <absolute-path>] [--profile base|visual|diagnostic|extended] [--allow-scripts] [--allow-debugger] [--allow-profiling]\nBrowser setup (separate): npm run browser:install\n');
} else {
  const args=process.argv.slice(2);
  const options={config:{},policy:{}};let valid=true;
  for(let index=0;index<args.length;index++){
    const flag=args[index];
    if(['--project','--profile'].includes(flag)){
      const value=args[++index];if(!value||value.startsWith('--')){valid=false;break;}
      if(flag==='--project')options.projectPath=value;else options.config.toolProfile=value;
    }else if(flag==='--allow-scripts')options.policy.allowScripts=true;
    else if(flag==='--allow-debugger')options.policy.allowDebugger=true;
    else if(flag==='--allow-profiling')options.policy.allowTrace=true;
    else {valid=false;break;}
  }
  if(!valid) {
    process.stderr.write('Argomenti CLI non validi. Usare --help.\n');process.exitCode=1;
  } else {
    const runtime=createCortexRuntime(options);
    const app=createCortexMcpServer({runtime});
    const transport=new StdioServerTransport();
    let closing;
    const shutdown=(code=0)=>{
      if(closing)return closing;
      const timeout=setTimeout(()=>process.exit(code||1),5000);timeout.unref();
      closing=app.close().then(()=>{clearTimeout(timeout);process.exit(code);},()=>{
        process.stderr.write('Chiusura Cortex non completata.\n');process.exit(1);
      });return closing;
    };
    for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>void shutdown());
    process.on('uncaughtException',()=>{process.stderr.write('Errore interno Cortex.\n');void shutdown(1);});
    process.on('unhandledRejection',()=>{process.stderr.write('Errore asincrono Cortex.\n');void shutdown(1);});
    process.stdin.once('end',()=>void shutdown());
    process.stdin.once('close',()=>void shutdown());
    transport.onclose=()=>void shutdown();
    await app.server.connect(transport);
  }
}
}
await main().catch(error=>{
  process.stderr.write('Avvio Cortex fallito: '+errorInfo(error).message+'\n');
  process.exitCode=1;
});
