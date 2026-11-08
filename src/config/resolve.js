import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'dotenv';
import { permitted, fail } from '../core/cortex-utils.js';

export async function canonicalPath(value) {
  const tail=[];
  let current=path.resolve(value);
  for (;;) {
    try { return path.join(await fs.realpath(current),...tail.reverse()); }
    catch(error) {
      if(error.code!=='ENOENT')throw fail('Percorso non accessibile.');
      const parent=path.dirname(current);
      if(parent===current)throw fail('Percorso non risolvibile.');
      tail.push(path.basename(current));current=parent;
    }
  }
}
export async function assertWithin(value,roots,label) {
  if(!roots)return;
  if(!Array.isArray(roots)||!roots.length)throw fail(label+' non autorizzato.');
  const target=await canonicalPath(value);
  for(const root of roots) {
    if(typeof root!=='string'||!path.isAbsolute(root))throw fail('Le root della policy devono essere assolute.');
    const relative=path.relative(await canonicalPath(root),target);
    if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))return;
  }
  throw fail(label+' non autorizzato.');
}
export function createConfigResolver({projectPath,config={},policy={},env=process.env}={}) {
  const host=structuredClone(config), ceiling=structuredClone(policy), bootstrap={...env};
  if(projectPath!==undefined&&!path.isAbsolute(projectPath))throw fail('projectPath deve essere assoluto.');
  return async function resolveConfig(requestedProject) {
    const project=requestedProject??projectPath;
    let values={...bootstrap};
    if(project!==undefined) {
      if(typeof project!=='string'||!path.isAbsolute(project))throw fail('project_path deve essere assoluto.');
      await assertWithin(project,ceiling.projectRoots,'Progetto');
      try {values={...values,...parse(await fs.readFile(path.join(project,'.env')))};}
      catch(error) {if(error.code!=='ENOENT')throw fail('Impossibile leggere il .env del progetto.');}
    } else if(ceiling.projectRoots)throw fail('project_path richiesto dalla policy.');
    const origins=host.origins??String(values.CORTEX_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
    if(!Array.isArray(origins)||!origins.length||origins.some(origin=>{
      try{return new URL(origin).origin!==origin||!permitted(origin,[origin]);}catch{return true;}
    }))throw fail('Configurare CORTEX_ALLOWED_ORIGINS con origin HTTP(S) esatti, inclusa porta.');
    if(ceiling.origins&&(!Array.isArray(ceiling.origins)||origins.some(origin=>!ceiling.origins.includes(origin))))throw fail('Origin oltre la policy dell’host.');
    const resolve=value=>{
      if(typeof value!=='string'||!value.trim())throw fail('Percorso non valido.');
      if(path.isAbsolute(value))return path.resolve(value);
      if(!project)throw fail('I percorsi relativi richiedono project_path.');
      return path.resolve(project,value);
    };
    const artifacts=resolve(host.artifacts??values.CORTEX_ARTIFACTS??path.join(os.homedir(),'.cortex','artifacts'));
    await assertWithin(artifacts,ceiling.artifactRoots,'Directory artifact');
    const executable=host.executablePath??values.CORTEX_CHROME_PATH??values.BROWSER_EXECUTABLE_PATH;
    const profile=host.profileDir??values.CORTEX_PROFILE_DIR;
    const launch={
      headless:host.headless??(values.CORTEX_HEADLESS===undefined?values.BROWSER_HEADLESS!=='false':values.CORTEX_HEADLESS!=='false'),
      executablePath:executable?resolve(executable):undefined,
      profileDir:profile?resolve(profile):undefined,
      serviceWorkers:'block'
    };
    if(profile)await assertWithin(launch.profileDir,ceiling.profileRoots,'Profilo browser');
    if(typeof launch.headless!=='boolean')throw fail('headless deve essere booleano.');
    return {origins:[...origins],artifacts,launch};
  };
}
export async function configFor(projectPath) {return createConfigResolver()(projectPath);}
