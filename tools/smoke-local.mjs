import {chromium} from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.SMOKE_BASE_URL||'http://127.0.0.1:5175';
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[];const checks=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('dialog',async d=>{if(d.type()==='confirm')await d.accept();else if(d.type()==='prompt')await d.accept('第一集 浏览器验证');else await d.dismiss();});
async function record(name){await page.screenshot({path:`artifacts/verification/${name}.png`});checks.push(name);}
async function req(method,path,data){const r=await context.request.fetch(base+'/api'+path,{method,data});assert(r.ok(),`${method} ${path} ${r.status()} ${await r.text()}`);return r.status()===204?null:r.json();}
try {
  await page.goto(base+'/home');
  await page.getByRole('heading',{name:/一键生成/}).waitFor();
  await record('smoke-home');
  await page.getByRole('link',{name:'我的作品',exact:true}).click();
  await page.getByRole('button',{name:'新建剧集',exact:true}).first().click();
  const name='本地端到端验证 '+Date.now();
  await page.getByPlaceholder('请输入剧集名称',{exact:true}).fill(name);
  await page.getByRole('button',{name:'立即创建',exact:true}).click();
  await page.getByRole('textbox',{name:'剧本内容',exact:true}).waitFor();
  const script='第一集 花园\n场景一：日 外景 花园\n小猫在花园里浇花。\n第二集 工作室\n场景一：日 内景 工作室\n小猫回到温暖的工作室。';
  await page.getByRole('textbox',{name:'剧本内容',exact:true}).fill(script);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('作品已保存',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('textbox',{name:'剧本内容',exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'剧本内容',exact:true}).inputValue(),script);
  await page.getByRole('button',{name:'解析为分镜',exact:true}).click();
  await page.getByText(/已按本地规则创建/).waitFor();
  const projects=await req('GET','/projects');
  const project=projects.items.find(p=>p.name===name);assert(project);
  const shots=await req('GET',`/projects/${project.id}/shots`);assert(shots.total>0);
  const episodes=await req('GET',`/projects/${project.id}/episodes`);assert.equal(episodes.total,2);
  await record('smoke-project-persisted');
  await page.goto(base+`/style/${project.id}`);
  await page.getByText('绘图风格',{exact:true}).waitFor();
  await record('smoke-style');
  await page.goto(base+`/edit/${project.id}/scene/${shots.items[0].id}`);
  await page.getByPlaceholder('描述你想要的画面、角色、动作、氛围…',{exact:true}).waitFor();
  await record('smoke-shot-editor');
  const upload=await context.request.post(base+'/api/uploads',{multipart:{file:{name:'frame.png',mimeType:'image/png',buffer:await fs.readFile('artifacts/verification/smoke-home.png')}}});
  assert.equal(upload.status(),201);
  const uploaded=await upload.json();
  for(const shot of shots.items) await req('PATCH',`/shots/${shot.id}`,{image_url:uploaded.url,duration:1});
  const media=await context.request.get(base+uploaded.url);assert(media.ok());
  assert((await media.body()).length>10000);
  const before=await req('GET','/credits');
  const unavailable=await context.request.post(base+'/api/tasks',{data:{kind:'video',project_id:project.id,prompt:'本地测试',idempotency_key:crypto.randomUUID()}});
  assert.equal(unavailable.status(),503);
  assert.equal((await req('GET','/credits')).balance,before.balance);
  checks.push('missing-provider-no-charge');
  for(const format of ['json','zip','mp4']) {
    const task=await req('POST','/tasks',{kind:'export',project_id:project.id,parameters:{format,shot_ids:[shots.items[0].id]},idempotency_key:crypto.randomUUID()});
    let result;
    for(let i=0;i<40;i++){result=await req('GET',`/tasks/${task.id}`);if(['succeeded','failed'].includes(result.status))break;await page.waitForTimeout(500);}
    assert.equal(result.status,'succeeded',JSON.stringify(result));
    const file=await context.request.get(base+result.result.url);assert(file.ok());
    await fs.writeFile(`artifacts/verification/export.${format}`,await file.body());
    checks.push(`export-${format}`);
  }
  const canvas=await req('POST','/projects',{name:'浏览器画布验证',kind:'canvas'});
  await page.goto(base+`/canvas/${canvas.id}`);
  await page.getByRole('button',{name:'添加第一个节点',exact:true}).click();
  await page.locator('.react-flow__node').waitFor();
  await page.waitForTimeout(1300);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.reload();
  await page.locator('.react-flow__node').waitFor();
  assert.equal((await req('GET',`/projects/${canvas.id}/canvas`)).nodes.length,1);
  await record('smoke-canvas-persisted');
  for(const route of ['/material','/task-center','/notify','/mcp-guide']){await page.goto(base+route);await page.waitForTimeout(250);assert(!await page.getByText('Internal Server Error',{exact:true}).count());await record('smoke-'+route.slice(1));}
  for(const route of ['/marketplace/script-market','/marketplace/biz-square','/marketplace/sample-cooperation','/marketplace/mine/orders','/team','/team-stats']) {await page.goto(base+route);assert.equal(new URL(page.url()).pathname,route);await page.locator('main').waitFor();await record('smoke-'+route.slice(1).replaceAll('/','-'));}
  const localKey=await req('POST','/mcp/keys',{name:'isolated browser smoke key'});
  assert(localKey.secret);
  const rpc=await context.request.post(base+'/api/mcp',{headers:{Authorization:'Bearer '+localKey.secret},data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_projects',arguments:{}}}});
  assert(rpc.ok()); assert.equal((await rpc.json()).result.isError,false);
  await req('DELETE','/mcp/keys/'+localKey.id);
  const revoked=await context.request.post(base+'/api/mcp',{headers:{Authorization:'Bearer '+localKey.secret},data:{jsonrpc:'2.0',id:2,method:'ping'}});
  assert.equal(revoked.status(),401);
  checks.push('mcp-key-tools-revocation');
  assert.deepEqual(errors,[]);
  await fs.writeFile('artifacts/verification/browser-smoke.json',JSON.stringify({passed:true,checks,errors,projectId:project.id,canvasId:canvas.id},null,2));
  console.log(JSON.stringify({passed:true,checks,errors}));
} catch(error) {
  await page.screenshot({path:'artifacts/verification/smoke-failure.png'});
  await fs.writeFile('artifacts/verification/browser-smoke.json',JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));
  console.error(error);process.exitCode=1;
} finally {await browser.close();}
