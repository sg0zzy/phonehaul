import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startReceiver } from '../src/server/app.js';

function request(receiver, method, route, data, headers={}) {
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',port:receiver.port,path:route,method,rejectUnauthorized:false,headers:{Authorization:`Bearer ${receiver.session.token}`,...headers}},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });req.on('error',reject);req.end(data);
  });
}

function uiRequest(uiUrl, route) {
  return new Promise((resolve,reject)=>{
    http.get(new URL(route,uiUrl),response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).on('error',reject);
  });
}

function pageRequest(uiUrl) {
  return new Promise((resolve,reject)=>http.get(uiUrl,response=>{
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,type:response.headers['content-type'],body:Buffer.concat(chunks).toString()}));
  }).on('error',reject));
}

function emptyRequest(uiUrl, route, method='POST') {
  return new Promise((resolve,reject)=>{
    const req=http.request(new URL(route,uiUrl),{method},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    req.on('error',reject);req.end();
  });
}

test('management UI is local, self-contained, and closes cleanly',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'phonehaul-ui-'));
  const settingsFile=path.join(root,'settings.json');
  const destination=path.join(root,'dest');
  await writeFile(settingsFile,JSON.stringify({destination,conflict:'rename'}));
  const receiver=await startReceiver({host:'127.0.0.1',transferPort:0,uiPort:0,settingsFile});
  try {
    assert.equal(new URL(receiver.uiUrl).hostname,'127.0.0.1');
    const response=await pageRequest(receiver.uiUrl);
    assert.equal(response.status,200);
    assert.match(response.type,/text\/html/);
    assert.match(response.body,/<title>PhoneHaul Receiver<\/title>/);
    assert.match(response.body,/new EventSource\('\/api\/events'\)/);
    assert.doesNotMatch(response.body,/<script[^>]+src=/);
    const ui=await uiRequest(receiver.uiUrl,'/api/ui');
    assert.equal(ui.settings.destination,destination);
    assert.match(ui.qr,/^data:image\/png;base64,/);
    assert.equal(await emptyRequest(receiver.uiUrl,'/api/heartbeat'),204);
  } finally {
    await receiver.close();
    await receiver.close();
  }
});

test('HTTPS API accepts a verified file and rejects bad session',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'phonehaul-api-'));
  const settingsFile=path.join(root,'settings.json');
  const destination=path.join(root,'dest');
  await writeFile(settingsFile,JSON.stringify({destination,conflict:'rename'}));
  const receiver=await startReceiver({host:'127.0.0.1',transferPort:0,settingsFile});
  try {
    const bad=await new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',port:receiver.port,path:'/api/session/connect',method:'POST',rejectUnauthorized:false,headers:{Authorization:'Bearer bad'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end()});
    assert.equal(bad,401);
    assert.equal((await request(receiver,'POST','/api/session/connect')).status,200);
    const manifest={protocol:1,operation:'copy',items:[{id:'file1',type:'file',relativePath:'DCIM/test.txt',size:5,sha256:createHash('sha256').update('hello').digest('hex')}]};
    const created=await request(receiver,'POST','/api/transfers',JSON.stringify(manifest),{'Content-Type':'application/json'});
    assert.equal(created.status,201);
    const id=created.body.transferId;
    const upload=await request(receiver,'PUT',`/api/transfers/${id}/files/file1`,'hello',{'Content-Length':5,'X-PhoneHaul-SHA256':createHash('sha256').update('hello').digest('hex')});
    assert.equal(upload.status,200);assert.equal(upload.body.status,'committed');
    assert.equal(await readFile(path.join(destination,'DCIM','test.txt'),'utf8'),'hello');
    assert.equal((await request(receiver,'POST',`/api/transfers/${id}/finish`)).body.completedItems,1);
  } finally {await receiver.close();}
});

test('expired QR is replaced in the local UI and old token is rejected',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'phonehaul-qr-'));
  const settingsFile=path.join(root,'settings.json');
  await writeFile(settingsFile,JSON.stringify({destination:path.join(root,'dest'),conflict:'rename'}));
  const receiver=await startReceiver({host:'127.0.0.1',transferPort:0,settingsFile});
  try {
    const original=receiver.session.token;
    const before=await uiRequest(receiver.uiUrl,'/api/ui');
    receiver.session.expiresAt=Date.now()-1;
    const after=await uiRequest(receiver.uiUrl,'/api/ui');
    assert.notEqual(receiver.session.token,original);
    assert.notEqual(after.qr,before.qr);
    assert.equal(after.pairingVersion,before.pairingVersion+1);
    const rejected=await request(receiver,'POST','/api/session/connect',undefined,{Authorization:`Bearer ${original}`});
    assert.equal(rejected.status,401);
    assert.equal((await request(receiver,'POST','/api/session/connect')).status,200);
  } finally {await receiver.close();}
});
