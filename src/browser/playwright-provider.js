import { fail } from '../core/cortex-utils.js';

export function createPlaywrightProvider({loadChromium=async()=> (await import('playwright')).chromium,launchTimeoutMs=30000}={}) {
  let browser=null,context=null,page=null,loading=null,launchedConfig=null;
  const children=new Set();
  const fingerprint=options=>JSON.stringify({headless:options.headless??true,executablePath:options.executablePath??null,profileDir:options.profileDir??null});
  function assertLaunch(options) {
    if(browser?.isConnected()&&launchedConfig!==fingerprint(options))throw fail('Configurazione browser diversa dal primo avvio; creare un nuovo runtime.');
  }
  async function getSession(options) {
    assertLaunch(options);
    if(!browser?.isConnected()) {
      browser=null;context=null;page=null;
      const chromium=await (loading??=loadChromium().catch(error=>{loading=null;throw error;}));
      const launch={headless:options.headless??true,timeout:launchTimeoutMs,proxy:options.proxy,
        ...(options.executablePath?{executablePath:options.executablePath}:{})};
      // Keep Chromium's default sandbox; do not inherit Sophia's --no-sandbox.
      launch.chromiumSandbox=true;
      if(options.profileDir) {
        context=await chromium.launchPersistentContext(options.profileDir,{...launch,serviceWorkers:'block'});
        browser=context.browser();
        if(!browser) {await context.close();context=null;throw fail('Browser persistente non disponibile.');}
      } else {
        browser=await chromium.launch(launch);
        try {context=await browser.newContext({serviceWorkers:'block'});}
        catch(error){await browser.close().catch(()=>{});browser=null;throw error;}
      }
      launchedConfig=fingerprint(options);
      const owner=context;
      owner.on('page',newPage=>{
        children.add(newPage);newPage.once('close',()=>children.delete(newPage));
        const pages=owner.pages().filter(item=>!item.isClosed());
        if(pages.length>3)void pages[0].close().catch(()=>{});
      });
      for(const item of owner.pages()) {children.add(item);item.once('close',()=>children.delete(item));}
      page=owner.pages()[0]??await owner.newPage();
    }
    if(!page||page.isClosed())page=context.pages().find(item=>!item.isClosed())??await context.newPage();
    return {browser,context,page,target:'root',cortexProxy:true};
  }
  return {
    getSession,assertLaunch,
    selectPage(target,newPage) {if(target==='root'&&newPage.context()===context&&!newPage.isClosed())page=newPage;},
    async close() {
      const ownedBrowser=browser;
      if(ownedBrowser)await ownedBrowser.close();
      browser=null;context=null;page=null;launchedConfig=null;children.clear();
    }
  };
}
