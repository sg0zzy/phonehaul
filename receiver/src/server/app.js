import http from 'node:http';
import https from 'node:https';
import { unlink, mkdir } from 'node:fs/promises';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import { PairingSession, fingerprint, localAddress } from '../security/pairing.js';
import { loadSettings, saveSettings, defaultSettingsPath } from '../settings/store.js';
import { TransferReceiver, findPartials } from '../transfer/receiver.js';
import { page } from '../web/page.js';
import { openDefaultBrowser } from './browser.js';

const MAX_JSON = 10 * 1024 * 1024;
function json(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); }
async function body(request) { let chunks=[], size=0; for await (const chunk of request) { size+=chunk.length; if(size>MAX_JSON)throw new Error('Request too large');chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
function log(event, details='') { console.log(`[${new Date().toISOString()}] ${event}${details?' '+details:''}`); }

export async function startReceiver({ host = localAddress(), uiHost = '127.0.0.1', transferPort = 0, uiPort = 0, settingsFile = defaultSettingsPath, openBrowser = false, exitOnUiClose = false } = {}) {
  let settings = await loadSettings(settingsFile);
  await mkdir(settings.destination, { recursive: true });
  const certificate = await selfsigned.generate([{ name: 'commonName', value: 'PhoneHaul Receiver' }], { days: 1, keySize: 2048, algorithm: 'sha256' });
  const cert = certificate.cert, key = certificate.private;
  const certFingerprint = fingerprint(cert);
  let session = new PairingSession();
  let pairingVersion = 0;
  const clients = new Set();
  let lastUiHeartbeat = null;
  let closeReceiver = async () => {};
  const uiState = () => ({ transfer: transfer.summary(), connected: session.connected, pairingVersion });
  const broadcast = () => { const data=`data: ${JSON.stringify(uiState())}\n\n`; for(const client of clients)client.write(data); };
  const transfer = new TransferReceiver(settings, summary => { broadcast(); if(summary?.finished)log(summary.cancelled?'transfer cancelled':'transfer completed',summary.transferId); });
  const refreshPairing = () => { session = new PairingSession(); pairingVersion++; log('session created','expires in 5 minutes if unused'); broadcast(); };
  const refreshExpiredPairing = () => { if(session.expired()) refreshPairing(); };
  const pairingTimer = setInterval(refreshExpiredPairing, 1000);
  pairingTimer.unref();
  function fail(response,error) { json(response,error.status||400,{error:error.message,...(error.available?{available:error.available}:{})}); }
  const lan = https.createServer({ key, cert }, async (request,response) => {
    try {
      const url = new URL(request.url,'https://phonehaul.local');
      const token = /^Bearer (.+)$/i.exec(request.headers.authorization||'')?.[1];
      if(url.pathname==='/api/session/connect' && request.method==='POST') {
        refreshExpiredPairing();
        if(!session.connect(token)){log('pairing rejected','invalid or expired session');return json(response,401,{error:'Invalid or expired session'});}
        log('device connected');broadcast();return json(response,200,{status:'connected',protocol:1});
      }
      if(!session.connected || !session.valid(token))return json(response,401,{error:'Invalid session'});
      if(url.pathname==='/api/transfers' && request.method==='POST') {const result=await transfer.create(await body(request));log('transfer started',result.transferId);return json(response,201,result);}
      const match=/^\/api\/transfers\/([^/]+)(?:\/files\/([^/]+)|\/(finish|cancel))?$/.exec(url.pathname);
      if(!match)return json(response,404,{error:'Not found'});
      const [,id,fileId,action]=match;
      if(request.method==='GET'&&!fileId&&!action) {if(transfer.transfer?.transferId!==id)throw Error('Invalid transfer');return json(response,200,transfer.summary());}
      if(request.method==='PUT'&&fileId){const result=await transfer.upload(id,fileId,request,request.headers['x-phonehaul-sha256']);log(result.status==='committed'?'file committed':'file skipped',fileId);return json(response,200,result);}
      if(request.method==='POST'&&action==='finish')return json(response,200,transfer.finish(id));
      if(request.method==='POST'&&action==='cancel')return json(response,200,transfer.cancel(id));
      return json(response,404,{error:'Not found'});
    }catch(error){log('request failed',error.message);if(!response.headersSent)fail(response,error);else response.destroy();}
  });
  await new Promise((resolve,reject)=>lan.once('error',reject).listen(transferPort,host,resolve));
  const port=lan.address().port;
  const ui = http.createServer(async(request,response)=>{
    try {
      const url=new URL(request.url,'http://localhost');
      if(url.pathname==='/'&&request.method==='GET'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return response.end(page());}
      if(url.pathname==='/api/heartbeat'&&request.method==='POST'){
        lastUiHeartbeat=Date.now();
        response.writeHead(204,{'Cache-Control':'no-store'});
        return response.end();
      }
      if(url.pathname==='/api/events'&&request.method==='GET'){
        response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
        clients.add(response);
        response.write(`data: ${JSON.stringify(uiState())}\n\n`);
        response.on('close',()=>clients.delete(response));
        return;
      }
      if(url.pathname==='/api/ui'&&request.method==='GET'){refreshExpiredPairing();const qr=await QRCode.toDataURL(session.uri(host,port,certFingerprint),{margin:2,width:320});return json(response,200,{settings,qr,host,port,pairingVersion,connected:session.connected,transfer:transfer.summary(),partials:await findPartials(settings.destination)});}
      if(url.pathname==='/api/qr/refresh'&&request.method==='POST'){if(session.connected)throw Error('Session already connected');refreshPairing();return json(response,200,{status:'ready'});}
      if(url.pathname==='/api/settings'&&request.method==='POST'){if(transfer.transfer&&!transfer.transfer.finished)throw Error('Cannot change destination during transfer');settings=await saveSettings(await body(request),settingsFile);transfer.settings=settings;return json(response,200,settings);}
      if(url.pathname==='/api/partials/remove'&&request.method==='POST'){if(transfer.transfer&&!transfer.transfer.finished)throw Error('Cannot remove partial files during transfer');const partials=await findPartials(settings.destination);for(const file of partials)await unlink(file);return json(response,200,{removed:partials.length});}
      return json(response,404,{error:'Not found'});
    }catch(error){fail(response,error);}
  });
  await new Promise((resolve,reject)=>ui.once('error',reject).listen(uiPort,uiHost,resolve));
  const uiUrl=`http://${uiHost}:${ui.address().port}/`;
  log('server started',`LAN ${host}:${port}, UI ${uiUrl}`);log('session created','expires in 5 minutes if unused');
  if(openBrowser) openDefaultBrowser(uiUrl,{onError:()=>console.log(`PhoneHaul receiver is running.\n\nOpen:\n${uiUrl}`)});
  let closed = false;
  const heartbeatMonitor=exitOnUiClose?setInterval(()=>{
    if(lastUiHeartbeat!==null&&Date.now()-lastUiHeartbeat>=15_000){
      log('browser heartbeat timed out','stopping AppImage receiver');
      closeReceiver().catch(error=>log('shutdown failed',error.message));
    }
  },1000):null;
  heartbeatMonitor?.unref();
  const close = async()=>{
    if(closed)return;
    closed=true;
    if(heartbeatMonitor)clearInterval(heartbeatMonitor);
    clearInterval(pairingTimer);
    if(transfer.transfer&&!transfer.transfer.finished)transfer.cancel(transfer.transfer.transferId);
    session=new PairingSession();
    for(const client of clients)client.end();
    await Promise.all([new Promise(r=>ui.close(r)),new Promise(r=>lan.close(r))]);
  };
  closeReceiver=close;
  return {uiUrl,host,port,get settings(){return settings},get session(){return session},certFingerprint,transfer,close};
}
