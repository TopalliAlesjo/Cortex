import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { errorInfo } from '../src/core/cortex-utils.js';

const cli=fileURLToPath(new URL('../bin/cortex.mjs',import.meta.url));
test('CLI: invalid bootstrap reports a concise error on stderr without corrupting stdio',()=>{
  for(const [args,message] of [
    [['--profile','unknown'],'toolProfile non valido'],
    [['--project','relative-project'],'projectPath deve essere assoluto'],
    [['--unknown'],'Argomenti CLI non validi']
  ]) {
    const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:5000,windowsHide:true});
    assert.equal(result.error,undefined);
    assert.equal(result.status,1);
    assert.equal(result.stdout,'');
    assert.ok(result.stderr.includes(message),result.stderr);
    assert.doesNotMatch(result.stderr,/\bat (?:file:|main|createCortex)/);
  }
});

test('first launch: missing Chromium explains installation and hides local paths',()=>{
  const info=errorInfo(new Error("browserType.launch: Executable doesn't exist at C:/private-user/chromium/chrome.exe"));
  assert.match(info.message,/npm run browser:install/);
  assert.doesNotMatch(info.message,/private-user|chrome\.exe/);
});
