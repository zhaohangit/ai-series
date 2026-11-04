import {request} from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.SMOKE_BASE_URL||'http://127.0.0.1:5175';
const ffmpeg=process.env.FFMPEG_BIN||'/Users/zhaohan25/.cache/uv/archive-v0/jaXy6RpqXya1AqhW/lib/python3.14/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v9.0';
const output=path.resolve('artifacts/verification/frame-timing');await fs.mkdir(output,{recursive:true});
const context=await request.newContext({baseURL:base});
const checks=[];
async function api(method,p,data){const r=await context.fetch('/api'+p,{method,data});assert(r.ok(),`${r.status()} ${await r.text()}`);return r.json();}
async function decode(file,index){return execFileSync('docker',['compose','exec','-T','worker','ffmpeg','-v','error','-i','pipe:0',...(index===undefined?[]:['-vf',`select=eq(n\\,${index})`,'-fps_mode','passthrough']),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:await fs.readFile(file),timeout:30000});}
try{
 await api('GET','/session');const before=await api('GET','/credits');
 const source=path.join(output,'vfr.mp4');
 execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc=s=64x48:r=10:d=2','-vf',"select='eq(n,0)+eq(n,1)+eq(n,12)+eq(n,19)'",'-fps_mode','vfr','-c:v','libx264','-bf','0','-pix_fmt','yuv420p',source],{timeout:30000});
 const uploaded=await context.post('/api/uploads',{multipart:{file:{name:'vfr.mp4',mimeType:'video/mp4',buffer:await fs.readFile(source)}}});assert.equal(uploaded.status(),201);
 const url=(await uploaded.json()).url;
 for(const [at,index,frameAt] of [[.05,0,0],[.5,1,.1],[1.95,3,1.9]]){
  const task=await api('POST','/tasks',{kind:'image',parameters:{operation:'extract_frame',source_url:url,at},idempotency_key:crypto.randomUUID()});
  let result;
  for(let i=0;i<100;i++){result=await api('GET','/tasks/'+task.id);if(['succeeded','failed'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,250));}
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.equal(result.result.frame_index,index);assert.equal(result.result.requested_at,at);assert.equal(result.result.at,frameAt);
  const response=await context.get(result.result.url);assert(response.ok());const target=path.join(output,`frame-${index}.png`);await fs.writeFile(target,await response.body());
  const pixels=await decode(target);assert.equal(pixels.length,64*48*3);assert(pixels.equals(await decode(source,index)),'Output must match selected frame using the deployed decoder');
  checks.push({requested_at:at,actual_at:frameAt,frame_index:index,decoded_pixels_match:true});
 }
 assert.deepEqual(await api('GET','/credits'),before);
 const report={passed:true,checks,credits_unchanged:true};await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await context.dispose();}
