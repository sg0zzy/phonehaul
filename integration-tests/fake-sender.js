#!/usr/bin/env node
import https from 'node:https';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isPrivateIPv4 } from '../receiver/src/security/pairing.js';

export function parsePairing(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'phonehaul:' || u.hostname !== 'pair' || u.searchParams.get('v') !== '1') throw Error('Invalid PhoneHaul QR');
  const host = u.searchParams.get('h'), port = Number(u.searchParams.get('p')), token = u.searchParams.get('s'), fingerprint = u.searchParams.get('f');
  if (!isPrivateIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '') || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw Error('Invalid PhoneHaul QR');
  return { host, port, token, fingerprint };
}

function send(pair, method, pathname, data, headers={}) {
  return new Promise((resolve,reject)=>{
    const request=https.request({hostname:pair.host,port:pair.port,path:pathname,method,rejectUnauthorized:false,headers:{Authorization:`Bearer ${pair.token}`,...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{let result;try{result=JSON.parse(Buffer.concat(chunks).toString())}catch{return reject(Error('Invalid receiver response'))}if(response.statusCode>=400)return reject(Error(result.error));resolve(result)});
    });
    request.on('socket',socket=>socket.on('secureConnect',()=>{const raw=socket.getPeerCertificate(true).raw;const actual=createHash('sha256').update(raw).digest('hex');if(actual!==pair.fingerprint)request.destroy(Error('Receiver certificate fingerprint mismatch'))}));
    request.on('error',reject);
    if(data && typeof data.pipe==='function')data.pipe(request);else request.end(data);
  });
}

async function collect(input) {
  const items=[];
  async function visit(file,relative){const info=await stat(file);if(info.isDirectory()){items.push({id:randomUUID(),type:'directory',relativePath:relative});for(const name of await readdir(file))await visit(path.join(file,name),`${relative}/${name}`)}else if(info.isFile())items.push({id:randomUUID(),type:'file',relativePath:relative,size:info.size,modified:info.mtimeMs,source:file});}
  for(const file of input)await visit(path.resolve(file),path.basename(file));
  return items;
}

async function sha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex')}

export async function run(uri,files,operation='copy'){
  const pair=parsePairing(uri),items=await collect(files);
  if(!items.length)throw Error('No files selected');
  for(const item of items.filter(i=>i.type==='file'))item.sha256=await sha256(item.source);
  await send(pair,'POST','/api/session/connect');
  const transfer=await send(pair,'POST','/api/transfers',JSON.stringify({protocol:1,operation,items:items.map(({source,...item})=>item)}),{'Content-Type':'application/json'});
  for(const item of items.filter(i=>i.type==='file')){
    const disposition=transfer.items.find(value=>value.id===item.id)?.status;
    if(disposition==='already_present'||disposition==='skipped'){console.log(`${disposition}: ${item.relativePath}`);continue}
    if(disposition!=='queued')throw Error(`Unexpected disposition for ${item.relativePath}`);
    const result=await send(pair,'PUT',`/api/transfers/${transfer.transferId}/files/${item.id}`,createReadStream(item.source),{'Content-Length':item.size,'X-PhoneHaul-SHA256':item.sha256});
    console.log(`${result.status}: ${item.relativePath}`);
    // This test client deliberately never deletes a source. Android owns MOVE deletion.
  }
  return send(pair,'POST',`/api/transfers/${transfer.transferId}/finish`);
}

if(import.meta.url===`file://${process.argv[1]}`){
  const [uri,...files]=process.argv.slice(2);
  if(!uri||!files.length){console.error('Usage: node fake-sender.js <phonehaul://pair?...> <file-or-folder> [...]');process.exit(2)}
  run(uri,files).then(result=>console.log(`Completed ${result.completedItems}/${result.totalItems} files`)).catch(error=>{console.error(error.message);process.exitCode=1});
}
