import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Local integration fixture. The Hub owns jobs, original sources and authorization.
const employees = ["sato", "tanaka"];
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const jobPhase = new RegExp("^" + uuid + "-(?:review|draft|compose|question-\\d+|revise-\\d+|(?:actions|inquiry)-[a-zA-Z0-9-]{12,100}|learn-quote-\\d+-[0-9a-f]{8})$");
const routeHeader = new RegExp("^AI_HUB_ROUTE (" + uuid + ")\\n");
const runId = /^run_[0-9a-f]{32}$/;
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "incomplete"]);
const idleTimeout = 10 * 60 * 1000;
const active = new Set(["queued", "pending", "running", "in_progress"]);
const retention = 24 * 60 * 60 * 1000;
const json = Response.json.bind(Response);
const receipt = (result, row) => result === "matched"
  ? json({result, run_id:row.run, session_id:"hub-" + row.job_phase})
  : json({result});

export class Employee extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container?.running) ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(idleTimeout));
  }

  get actor() { return this.ctx.id.name; }
  get auth() { return {Authorization:"Bearer " + this.env[this.actor.toUpperCase() + "_KEY"]}; }
  get db() { return this.env.DB; }

  async start() {
    this.starting ??= this.startContainer().finally(()=>{this.starting=null;});
    return this.starting;
  }

  async startContainer() {
    const c = this.ctx.container;
    if (!c.running) {
      const pending = await this.db.prepare("SELECT 1 FROM archive WHERE actor=? AND result IS NOT NULL AND state_saved IS NULL LIMIT 1")
        .bind(this.actor).first();
      if (pending) throw Error("Personal state capture is unconfirmed");
      const state = await this.db.prepare("SELECT snapshot FROM personal_state WHERE actor=?").bind(this.actor).first();
      const profile = !state && await this.db.prepare("SELECT body FROM profiles WHERE actor=?").bind(this.actor).first();
      const snapshot = state?.snapshot ?? JSON.stringify({memory:{"USER.md":profile?.body ?? null,"MEMORY.md":null},skills:{}});
      await c.interceptOutboundHttp("hub.lab", this.ctx.exports.Callback({props:{actor:this.actor}}));
      c.start({enableInternet:false, env:{
        API_SERVER_ENABLED:"true", API_SERVER_HOST:"0.0.0.0", API_SERVER_KEY:this.env[this.actor.toUpperCase() + "_KEY"],
        LAB_ACTOR:this.actor, LAB_PERSONAL_STATE:snapshot, OPENAI_BASE_URL:"http://hub.lab/v1", OPENAI_API_KEY:"synthetic-only"
      }});
    }
    await c.setInactivityTimeout(idleTimeout);
    for (let i=0; i<100; i++) {
      try { if ((await this.live(8642, "/health")).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve,150));
    }
    throw Error("Hermes startup timed out");
  }

  live(port, path, init={}) {
    return this.ctx.container.getTcpPort(port).fetch("http://runtime"+path, {
      ...init, headers:{...this.auth, ...init.headers}
    });
  }

  async schedule() {
    // An earlier wakeup can inspect all open sends for this employee.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now()+1000);
  }

  async send(request) {
    const key = request.headers.get("Idempotency-Key");
    const body = await request.text();
    let payload;
    try { payload = JSON.parse(body); } catch { return new Response(null,{status:400}); }
    const attempt = typeof payload?.input === "string" && routeHeader.exec(payload.input)?.[1];
    if (!jobPhase.test(key) || !attempt || payload.session_id !== "hub-"+key) return new Response(null,{status:400});

    const reserved = await this.db.prepare(
      "INSERT INTO archive(actor,job_phase,attempt,created) VALUES(?,?,?,?) ON CONFLICT(actor,job_phase) DO NOTHING"
    ).bind(this.actor,key,attempt,Date.now()).run();
    if (!reserved.meta.changes) return new Response(null,{status:409});
    await this.start();
    await this.schedule();
    // This is the only outbound POST. An indeterminate attempt is never replayed.
    return this.live(8642,"/v1/runs",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},body});
  }

  async liveReceipt(row) {
    const reply = await this.live(8643,"/receipt/"+row.job_phase,{headers:{"X-Hub-Attempt":row.attempt}});
    if (!reply.ok) return {result:"unavailable"};
    const item = await reply.json();
    if (item.result === "matched" && (!runId.test(item.run_id) || item.session_id !== "hub-"+row.job_phase))
      return {result:"mismatch"};
    if (item.result === "matched") {
      // Commit the verified admission even while inference is still running.
      const update = await this.db.prepare(
        "UPDATE archive SET run=?,confirmed=coalesce(confirmed,?) WHERE actor=? AND job_phase=? AND attempt=? AND (run IS NULL OR run=?)"
      ).bind(item.run_id,Date.now(),this.actor,row.job_phase,row.attempt,item.run_id).run();
      if (!update.meta.changes) return {result:"mismatch"};
    }
    return item;
  }

  async capture(row) {
    if (row.result) return this.captureState(row);
    const item = row.run
      ? {result:"matched", run_id:row.run, session_id:"hub-"+row.job_phase}
      : await this.liveReceipt(row);
    if (item.result !== "matched") return;
    const reply = await this.live(8642,"/v1/runs/"+item.run_id);
    if (!reply.ok) return;
    const run = await reply.json();
    if (run.run_id !== item.run_id || run.session_id !== item.session_id) return;
    if (active.has(run.status)) {
      // Renew the idle period only for a live run with a verified owner and session.
      await this.ctx.container.setInactivityTimeout(idleTimeout);
      return;
    }
    if (!terminal.has(run.status)) return;
    if (run.status === "completed" && typeof run.output !== "string") return;
    const result = JSON.stringify({run_id:run.run_id, session_id:run.session_id, status:run.status, output:run.output ?? ""});
    await this.db.prepare(
      "UPDATE archive SET result=?,captured=? WHERE actor=? AND job_phase=? AND attempt=? AND run=? AND result IS NULL"
    ).bind(result,Date.now(),this.actor,row.job_phase,row.attempt,run.run_id).run();
    return this.captureState(row);
  }

  async captureState(row) {
    const reply = await this.live(8644,"/state");
    if (!reply.ok) return;
    const snapshot = await reply.text();
    const value = JSON.parse(snapshot);
    if (!value.memory || !value.skills) throw Error("Personal state is incomplete");
    await this.db.batch([
      this.db.prepare(`INSERT INTO personal_state(actor,version,snapshot) VALUES(?,1,?)
        ON CONFLICT(actor) DO UPDATE SET version=version+1,snapshot=excluded.snapshot
        WHERE snapshot<>excluded.snapshot`).bind(this.actor,snapshot),
      this.db.prepare("UPDATE archive SET state_saved=? WHERE actor=? AND job_phase=? AND attempt=? AND result IS NOT NULL")
        .bind(Date.now(),this.actor,row.job_phase,row.attempt),
    ]);
  }

  async alarm() {
    // A missing receipt gets a short search window. An admitted run can finish later.
    if (!this.ctx.container.running) return;
    const open = () => this.db.prepare(
      `SELECT job_phase,attempt,run,result FROM archive WHERE actor=? AND state_saved IS NULL
       AND ((run IS NULL AND created>?) OR (run IS NOT NULL AND confirmed>?)) ORDER BY created`
    ).bind(this.actor,Date.now()-idleTimeout,Date.now()-retention).all();
    const {results} = await open();
    for (const row of results) {
      try { await this.capture(row); }
      catch { console.warn("Read-only archive observation deferred"); }
    }
    const remaining = (await open()).results;
    if (remaining.length) {
      const checkingAdmission = remaining.some(row => !row.run);
      await this.ctx.storage.setAlarm(Date.now() + (checkingAdmission ? 2000 : 5000));
    }
  }

  async lookup(request, key) {
    const row = await this.db.prepare("SELECT job_phase,attempt,run,confirmed,captured FROM archive WHERE actor=? AND job_phase=?")
      .bind(this.actor,key).first();
    if (!row) return receipt("missing");
    if (request.headers.get("X-Hub-Attempt") !== row.attempt) return receipt("mismatch");
    if (row.run) return (row.captured ?? row.confirmed) <= Date.now()-retention ? receipt("expired") : receipt("matched",row);
    if (!this.ctx.container.running) return receipt("unavailable");
    return json(await this.liveReceipt(row));
  }

  async readRun(id) {
    const row = await this.db.prepare("SELECT result,captured FROM archive WHERE actor=? AND run=?").bind(this.actor,id).first();
    if (row?.result) return row.captured <= Date.now()-retention ? new Response(null,{status:410}) :
      new Response(row.result,{headers:{"Content-Type":"application/json"}});
    if (!this.ctx.container.running) return new Response(null,{status:404});
    return this.live(8642,"/v1/runs/"+id);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/runs" && request.method === "POST") return this.send(request);
    if (request.method !== "GET") return new Response(null,{status:405});
    if (path.startsWith("/receipt/") && jobPhase.test(path.slice(9))) return this.lookup(request,path.slice(9));
    if (path.startsWith("/v1/runs/") && runId.test(path.slice(9))) return this.readRun(path.slice(9));
    if (path === "/health") { await this.start(); return this.live(8642,path); }
    return new Response(null,{status:404});
  }
}

export default {async fetch(req,env) {
  const actor = employees.find(a => env[a.toUpperCase()+"_KEY"] && req.headers.get("Authorization") === "Bearer "+env[a.toUpperCase()+"_KEY"]);
  if (!actor) return new Response(null,{status:403});
  return env.EMP.getByName(actor).fetch(req);
}};

export class Callback extends WorkerEntrypoint {
  fetch(req) {
    const url = new URL(req.url);
    if (url.hostname !== "hub.lab" || !["/v1/models","/v1/chat/completions","/work-tool"].includes(url.pathname))
      return new Response(null,{status:403});
    const port = this.ctx.props.actor === "sato" ? 19441 : 19442;
    return fetch(new Request("http://127.0.0.1:"+port+url.pathname,req));
  }
}
