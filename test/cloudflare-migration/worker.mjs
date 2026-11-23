// Read-only synthetic cutover probe. The local harness supplies the verified principal.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/jobs\/([a-z0-9-]+)(?:\/(versions|sources)\/(\d+))?$/);
    const actor = Object.entries(env.testActors).find(([,token])=>request.headers.get("Authorization") === "Bearer "+token)?.[0];
    if (!actor) return new Response(null,{status:401});
    if (!match || request.method!=="GET") return new Response(null,{status:404});

    const [,id,type,number] = match;
    const allowed = await env.BUSINESS.prepare("SELECT active FROM members WHERE actor=?").bind(actor).first();
    if (!allowed?.active) return new Response(null,{status:403});
    const job = await env.BUSINESS.prepare(`SELECT j.id,j.adopted_version,j.skill_hash,j.status
      FROM jobs j JOIN members m ON m.actor=j.actor AND m.active=1 AND m.team=j.team
      WHERE j.id=? AND j.actor=?`).bind(id,actor).first();
    if (!job) return new Response(null,{status:404});
    if (!type) {
      const versions = await env.BUSINESS.prepare("SELECT version,digest FROM objects WHERE kind='versions' AND job=? ORDER BY version").bind(id).all();
      const sources = await env.BUSINESS.prepare("SELECT version,digest,title,edition FROM objects WHERE kind='sources' AND job=? ORDER BY version").bind(id).all();
      return Response.json({...job,versions:versions.results,sources:sources.results});
    }
    const item = await env.BUSINESS.prepare("SELECT key,digest FROM objects WHERE job=? AND kind=? AND version=?").bind(id,type,Number(number)).first();
    if (!item) return new Response(null,{status:404});
    const object = await env.BODIES.get(item.key);
    if (!object) return new Response(null,{status:503});
    // Recheck authorization after the object read before returning its body.
    const current = await env.BUSINESS.prepare(`SELECT 1 FROM jobs j JOIN members m ON m.actor=j.actor
      WHERE j.id=? AND j.actor=? AND m.active=1 AND m.team=j.team`).bind(id,actor).first();
    if (!current) return new Response(null,{status:404});
    return new Response(object.body,{headers:{"Content-Type":"text/plain; charset=utf-8","X-Content-SHA256":item.digest}});
  },
};
