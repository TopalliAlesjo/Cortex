import http from 'node:http';
import net from 'node:net';
import { permitted } from './cortex-utils.js';

// A local, in-process forward proxy closes the first-popup/redirect gap in
// Playwright routing. HTTPS remains an opaque CONNECT tunnel: no TLS bypass,
// certificate replacement, header/body logging or additional process.
export async function createCortexProxy(onBlocked=()=>{}) {
  let active=false, origins=[];
  const sockets=new Set(), tunnels=new Set(), transfers=new Set();
  const stopTransfer=transfer=>{transfers.delete(transfer);transfer.response.destroy();transfer.upstream.destroy();};
  const allowed=url=>!active || permitted(url,origins);
  const track=socket=>{sockets.add(socket);socket.unref();socket.once('close',()=>sockets.delete(socket));return socket;};
  const server=http.createServer((request,response)=>{
    let url;
    try {url=new URL(request.url);} catch {response.writeHead(400).end();return;}
    if(url.protocol!=='http:' || !allowed(url.href)) {onBlocked();response.writeHead(403).end();return;}
    const headers={...request.headers};delete headers['proxy-authorization'];delete headers['proxy-connection'];
    const upstream=http.request(url,{method:request.method,headers},incoming=>{
      response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);
    });
    const transfer={url:url.href,response,upstream};transfers.add(transfer);
    const release=()=>transfers.delete(transfer);
    response.once('finish',release);
    upstream.on('socket',track);upstream.setTimeout(30000,()=>upstream.destroy());
    upstream.on('error',()=>{release();if(response.destroyed)return;if(!response.headersSent) response.writeHead(502);response.end();});
    request.once('aborted',()=>stopTransfer(transfer));response.once('close',()=>{release();upstream.destroy();});
    request.pipe(upstream);
  });
  server.on('connection',socket=>{
    if(sockets.size>=128) {socket.destroy();return;}
    track(socket);socket.setTimeout(60000,()=>socket.destroy());socket.on('error',()=>{});
  });
  server.on('connect',(request,client,head)=>{
    let url;
    try {url=new URL(`https://${request.url}`);} catch {client.end('HTTP/1.1 400 Bad Request\r\n\r\n');return;}
    if(!allowed(url.href)) {onBlocked();client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const upstream=track(net.connect({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port || 443)}));
    const tunnel={url:url.href,client,upstream};tunnels.add(tunnel);
    upstream.setTimeout(60000,()=>upstream.destroy());
    upstream.once('connect',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length) upstream.write(head);
      client.pipe(upstream);upstream.pipe(client);
    });
    upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
    client.once('close',()=>{upstream.destroy();tunnels.delete(tunnel);});
    upstream.once('close',()=>{client.destroy();tunnels.delete(tunnel);});
  });
  // ws:// is also HTTP; keep the same exact-origin policy for upgrades.
  server.on('upgrade',(request,client,head)=>{
    let url;try {url=new URL(request.url.replace(/^ws:/,'http:'));} catch {client.destroy();return;}
    if(url.protocol!=='http:' || !allowed(url.href)) {onBlocked();client.destroy();return;}
    const headers={...request.headers};delete headers['proxy-authorization'];delete headers['proxy-connection'];
    const upstream=http.request(url,{method:request.method,headers});
    const tunnel={url:url.href,client,upstream};tunnels.add(tunnel);
    const cleanup=()=>{tunnels.delete(tunnel);client.destroy();tunnel.upstream.destroy();};
    client.once('close',cleanup);client.on('error',cleanup);
    upstream.on('socket',track);upstream.setTimeout(30000,()=>upstream.destroy());
    upstream.once('upgrade',(response,socket,upstreamHead)=>{
      tunnel.upstream=socket;
      if(client.destroyed || !allowed(tunnel.url)) {cleanup();return;}
      socket.once('close',cleanup);socket.on('error',cleanup);
      client.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
      if(head.length) socket.write(head);if(upstreamHead.length) client.write(upstreamHead);
      client.pipe(socket);socket.pipe(client);
    });
    upstream.once('response',response=>{response.resume();client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');});
    upstream.on('error',cleanup);upstream.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  server.unref();
  const proxy={server:`http://127.0.0.1:${server.address().port}`,bypass:'<-loopback>'};
  return {proxy,
    setPolicy(enabled,allowedOrigins=[]) {
      active=enabled;origins=allowedOrigins;
      for(const transfer of transfers)if(!allowed(transfer.url))stopTransfer(transfer);
      for(const tunnel of tunnels) if(!allowed(tunnel.url)) {tunnel.client.destroy();tunnel.upstream.destroy();}
    },
    async close() {
      for(const transfer of transfers)stopTransfer(transfer);
      for(const tunnel of tunnels) {tunnel.client.destroy();tunnel.upstream.destroy();}
      for(const socket of sockets) socket.destroy();
      await new Promise(resolve=>server.close(resolve));
    }
  };
}
