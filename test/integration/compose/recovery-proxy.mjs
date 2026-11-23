// Private test stack. Let Hermes accept real runs, then interrupt status reads for the first one.
import http from "node:http";
import { existsSync } from "node:fs";
let firstRunPath, unavailableReads = 2;
const lostAcceptance = process.env.RECOVERY_FAULT === "lost-acceptance";
const unmatched = process.env.RECOVERY_FAULT === "unmatched-meeting";
const closure = process.env.RECOVERY_FAULT === "close-unconfirmed";
const delayed = process.env.RECOVERY_FAULT === "delayed-receipt" || closure;
let submissions = 0;
http.createServer((req, res) => {
  const path = req.url;
  const receipt = /^\/receipt\/([a-f0-9-]+-compose)$/.exec(path);
  if (delayed && receipt && existsSync("/tmp/hide-"+receipt[1])) {
    res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({result:"missing"}));
    return;
  }
  const number = req.method === "POST" && path === "/v1/runs" ? ++submissions : 0;
  if (lostAcceptance && number === 3) {
    req.resume();
    res.writeHead(503).end();
    console.log("unsubmitted", req.headers["idempotency-key"]);
    return;
  }
  if (req.method === "GET" && path.startsWith("/v1/runs/")) {
    firstRunPath ??= path;
  }
  // Preserve a real admission but make its booking unfindable by the Hub's original key.
  const headers = unmatched && number === 1 ? {...req.headers, "idempotency-key":"test-alternate-"+req.headers["idempotency-key"]} : req.headers;
  const readingReceipt = path.startsWith("/receipt/");
  const upstream = http.request({hostname:readingReceipt?"sato-receipts":"sato", port:readingReceipt?8643:8642, path, method:req.method, headers}, response => {
    if (((lostAcceptance || unmatched || delayed) && number === 1 || delayed && !closure && number === 3) && response.statusCode === 202) {
      console.log(req.method, path, req.headers["idempotency-key"], response.statusCode);
      console.log("dropped acceptance", req.headers["idempotency-key"]);
      response.resume();
      res.destroy();
      return;
    }
    if ((unmatched || (closure && submissions === 3)) && req.method === "GET" && path.startsWith("/v1/runs/") && response.statusCode === 200 &&
        !existsSync("/tmp/release-weekly-result")) {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const run = JSON.parse(Buffer.concat(chunks));
        if (run.status === "completed") console.log("holding completed",run.run_id);
        res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({run_id:run.run_id,session_id:run.session_id,status:"running"}));
      });
      return;
    }
    if (!lostAcceptance && !unmatched && !delayed && req.method === "GET" && path === firstRunPath && unavailableReads && response.statusCode === 200) {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if (JSON.parse(body).status === "completed") {
          unavailableReads--;
          res.writeHead(404).end();
          console.log("interrupted",path);
        } else res.writeHead(200,response.headers).end(body);
      });
      return;
    }
    console.log(req.method, path, req.headers["idempotency-key"] || "", response.statusCode);
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => res.writeHead(502).end());
  req.pipe(upstream);
}).listen(8642);
