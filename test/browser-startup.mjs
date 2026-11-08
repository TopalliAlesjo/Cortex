// An explicit CI diagnostic, separate from MCP stdio and real application data.
// Preserve the browser's startup log so platform sandbox failures are actionable.
import { chromium } from 'playwright';

let browser;
try {
  browser=await chromium.launch({headless:true,chromiumSandbox:true});
  console.log(`[PASS] Chromium ${browser.version()} starts with sandbox on ${process.platform}/${process.arch}`);
} catch(error) {
  console.error('[FAIL] Chromium startup with sandbox: '+error.message);
  process.exitCode=1;
} finally {
  await browser?.close();
}
