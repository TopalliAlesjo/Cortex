import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
for(const args of [['--test','test/cli.test.mjs','test/core.test.mjs','test/runtime.test.mjs','test/extended.test.mjs'],['test/integration.mjs'],['test/lifecycle.mjs'],['test/extended-integration.mjs'],['test/evolution-edgecases.mjs'],['test/standalone.mjs']]) {
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',code=>resolve(code??1));
  });
  if(code){process.exitCode=code;break;}
}
