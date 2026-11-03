import { chromium } from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
process.umask(0o077);
const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root,'artifacts/reference/captures');
await fs.mkdir(dir,{recursive:true});
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const context = browser.contexts()[0];
let page;
const statePath=path.join(dir,'observer.json');
try {
  const {targetId}=JSON.parse(await fs.readFile(statePath,'utf8'));
  for(const candidate of context.pages()) {
    if(!candidate.url().startsWith('https://aicomic.yuewen.com/')) continue;
    const session=await context.newCDPSession(candidate);
    const info=await session.send('Target.getTargetInfo'); await session.detach();
    if(info.targetInfo.targetId===targetId) {page=candidate; break;}
  }
} catch {}
if(!page) {
  page=await context.newPage();
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('https://aicomic.yuewen.com/home',{waitUntil:'domcontentloaded'});
  const s=await context.newCDPSession(page); const {targetInfo}=await s.send('Target.getTargetInfo'); await s.detach();
  await fs.writeFile(statePath,JSON.stringify({targetId:targetInfo.targetId}));
}
const [action='state',value='',label='latest'] = process.argv.slice(2);
await page.setViewportSize({width:1440,height:1000});
const network=[];
const pending=[];
const catalogPaths = ['/api/style/getDefaultStyleList','/api/style/mainImagePromptTemplate/list','/api/model_config/models','/api/aidrama/homeBanner/getBannerList','/api/versionList','/api/shotProject/projectTypeCategories'];
page.on('response',res=>{const u=new URL(res.url());if(u.hostname.endsWith('yuewen.com')&&/api|common/.test(u.pathname)) network.push({method:res.request().method(),path:u.pathname,status:res.status(),type:res.headers()['content-type']});if(catalogPaths.includes(u.pathname)) pending.push(res.json().then(body=>fs.writeFile(path.join(dir,'catalog-'+u.pathname.replaceAll('/','_')+'-'+Buffer.from(u.search).toString('hex').slice(0,64)+'.json'),JSON.stringify({path:u.pathname,query:u.search,body},null,2))).catch(()=>{}));});
if(action==='goto') {
  const url=new URL(value,'https://aicomic.yuewen.com');
  if(url.origin!=='https://aicomic.yuewen.com') throw new Error('Scope violation');
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
} else if(action==='reload') await page.reload({waitUntil:'domcontentloaded'});
else if(action==='button') await page.getByRole('button',{name:value,exact:true}).click({timeout:6000});
else if(action==='text') await page.getByText(value,{exact:true}).click({timeout:6000});
else if(action==='role') {const [role,name]=value.split('|');await page.getByRole(role,{name,exact:true}).click({timeout:6000});}
else if(action==='css') await page.locator(value).click({timeout:6000});
else if(action==='fill') {const [placeholder,...rest]=value.split('|');await page.getByPlaceholder(placeholder,{exact:true}).fill(rest.join('|'));}
else if(action==='prompt') await page.locator('div[contenteditable="true"]:visible').fill(value,{timeout:6000});
else if(action==='escape') await page.keyboard.press('Escape');
await page.locator('body').waitFor();
await page.waitForTimeout(700);
const data=await page.evaluate(()=>({url:location.href,title:document.title,text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(x=>({text:x.innerText,aria:x.getAttribute('aria-label'),disabled:x.disabled})),inputs:[...document.querySelectorAll('input,textarea')].map(x=>({tag:x.tagName,placeholder:x.getAttribute('placeholder'),type:x.getAttribute('type')})),links:[...document.querySelectorAll('a[href]')].map(x=>({text:x.innerText,url:x.href})),styles:{body:{background:getComputedStyle(document.body).backgroundColor,font:getComputedStyle(document.body).fontFamily,fontSize:getComputedStyle(document.body).fontSize}},assets:[...document.querySelectorAll('img,video,source')].map(x=>({src:x.getAttribute('src'),poster:x.getAttribute('poster'),alt:x.getAttribute('alt')}))}));
data.network=network; data.capturedAt=new Date().toISOString();
await fs.writeFile(path.join(dir,label+'.json'),JSON.stringify(data,null,2));
await page.screenshot({path:path.join(dir,label+'.png'),fullPage:false});
await Promise.allSettled(pending);
console.log(JSON.stringify({url:data.url,text:data.text.slice(0,16000),buttons:data.buttons,inputs:data.inputs,network,proof:path.join(dir,label+'.png')}));
await browser.close();
