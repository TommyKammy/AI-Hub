import net from "node:net";
import "./server.mjs";
for(const [port,host] of [[19441,"hub-sato"],[19442,"hub-tanaka"]]){
  net.createServer(client=>{
    if(host==="hub-sato" && fs.existsSync("/data/lab-hold-sato")){
      client.on("error",()=>client.destroy());
      client.setTimeout(90000,()=>client.destroy());
      return;
    }
    const out=net.connect(18800,host); client.pipe(out).pipe(client);
    client.on("error",()=>out.destroy());out.on("error",()=>client.destroy());
  }).listen(port,"hub-entry");
}

import http from "node:http";
import fs from "node:fs";
http.createServer((req,res)=>{
  const key=req.headers["idempotency-key"];
  const dispatch=req.method==="POST" && req.url==="/v1/runs";
  const record=type=>fs.appendFileSync("/data/test-wire.ndjson",JSON.stringify({key,type,when:new Date().toISOString()})+"\n");
  if(dispatch)record("outbound-post");
  const upstream=http.request({hostname:"host.lima.internal",port:19474,path:req.url,method:req.method,headers:req.headers},reply=>{
    if(dispatch && reply.statusCode===202 && fs.existsSync("/data/lab-drop-next")){
      fs.unlinkSync("/data/lab-drop-next");record("drop-202");reply.resume();res.destroy();return;
    }
    res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
  });
  upstream.on("error",()=>res.destroy());req.pipe(upstream);
}).listen(19444,"127.0.0.1");
