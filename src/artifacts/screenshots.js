import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/cortex-utils.js';
export const screenshotPath=()=>path.join(os.homedir(),'.cortex','artifacts','cortex-'+randomUUID()+'.png');
export async function captureScreenshot(page,filename) {
  // Exclusive reservation avoids replacing a pre-existing file or following its symlink.
  const handle=await fs.open(filename,'wx',0o600);
  try {
    const bytes=await page.screenshot({type:'png',fullPage:false,animations:'allow',caret:'initial',timeout:10000});
    await handle.writeFile(bytes);
  } catch {await fs.unlink(filename).catch(()=>{});throw fail('Screenshot non disponibile.');}
  finally {await handle.close();}
}
