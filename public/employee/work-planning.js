const frequencies={once:"1回",weekdays:"平日",weekly:"毎週",monthly:"毎月末"};
const formatDate=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",dateStyle:"long",timeStyle:"short"});
const payload=input=>({method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});

function reservation(workspace,api,go) {
  const section=document.createElement("section");
  section.innerHTML='<article class="panel pad">' +
    '<h2 id="reservationHeading">実行を予約する</h2><form id="reservationPlanner" aria-labelledby="reservationHeading">' +
    '<div class="formlabel"><label for="reservationText">実行日時と依頼内容</label><textarea id="reservationText" class="field" name="text" required maxlength="500" ' +
    'aria-describedby="reservationExample" rows="2"></textarea><small id="reservationExample">例　毎週金曜17時に週報を作る</small></div>' +
    '<div class="formlabel"><label for="reservationTemplate">個人手順</label><select id="reservationTemplate" name="template">' +
    '<option value="">依頼内容から選ぶ</option></select></div>' +
    '<fieldset class="panel pad" id="reservationSources" hidden><legend>予約に使う資料置き場</legend></fieldset>' +
    '<div class="actions"><button class="secondary" type="submit">予約内容を確認する</button>' +
    '<button class="primary" type="button" id="confirmReservation" hidden>この内容で予約する</button></div>' +
    '<p id="reservationStatus" role="status"></p></form></article>' +
    '<section aria-labelledby="futureSchedulesTitle" class="planning-schedules"><div class="sectionhead"><h2 id="futureSchedulesTitle">定期実行</h2>'+
    '<button type="button" data-op="schedule-new" class="secondary">週報を設定</button></div><div id="futureSchedules" class="stack"></div></section>';
  const select=section.querySelector("#reservationTemplate"), libraries=section.querySelector("#reservationSources");
  for (const item of workspace.templates.filter(template=>!template.recipe))
    select.add(new Option(item.name,item.id));
  libraries.hidden=!workspace.libraries.length;
  for (const item of workspace.libraries) {
    const label=document.createElement("label");
    const check=document.createElement("input");
    check.type="checkbox";check.name="libraries";check.value=item.id;
    label.append(check," "+item.name+"（"+item.scope+"）");
    libraries.append(label,document.createElement("br"));
  }
  const form=section.querySelector("form"), confirm=section.querySelector("#confirmReservation");
  const status=section.querySelector("#reservationStatus"), schedules=section.querySelector("#futureSchedules");
  let next, generation=0;
  form.addEventListener("input",()=>{
    generation++;
    next=null;
    confirm.hidden=true;
    status.textContent="";
  });
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const run=++generation, button=event.submitter;
    button.disabled=true;
    confirm.hidden=true;
    next=null;
    const formData=new FormData(form);
    const input={text:formData.get("text"),templateId:formData.get("template")||null,libraries:formData.getAll("libraries")};
    try {
      const result=await api("/api/reservation-plan/preview",payload(input));
      if (run!==generation) return;
      const source=result.libraries.map(library=>library.name).join("、") ||
        (result.report ? "直近"+result.windowDays+"日間に完了した仕事" : "依頼内容");
      status.replaceChildren(document.createTextNode(frequencies[result.frequency]+" ／ "+result.display+"（日本時間）"),
        document.createElement("br"),document.createTextNode("依頼　"+result.ask+" ／ 手順　"+(result.template?.name || "標準")+" ／ 資料　"+source));
      next={...input,token:result.token};
      confirm.hidden=false;
    } catch (error) { if (run===generation) status.textContent=error.message; }
    finally { button.disabled=false; }
  });
  confirm.onclick=async()=>{
    if (!next || confirm.disabled) return;
    confirm.disabled=true;
    try {
      const saved=await api("/api/reservation-plan/confirm",payload(next));
      confirm.hidden=true;
      if (saved.job) go("job/"+saved.job);
      else {
        status.textContent=formatDate.format(saved.nextRun)+"（日本時間）の枠を登録しました。";
        await refreshSchedules();
      }
    } catch(error) { status.textContent=error.message; }
    finally { confirm.disabled=false; }
  };

  async function refreshSchedules() {
    const state=await api("/api/workspace");
    renderSchedules(state.schedules);
  }
  function renderSchedules(items) {
    schedules.replaceChildren();
    for (const item of items) {
      const row=document.createElement("article");
      row.className="panel pad planning-schedule-row";
      const heading=document.createElement("h3"), timing=document.createElement("p");
      heading.textContent=item.name;
      timing.textContent=item.enabled ? "次回 "+formatDate.format(item.next_run)+"（日本時間）" : "停止中";
      if (item.blocked_reason) timing.textContent+=" ・ "+item.blocked_reason;
      const actions=document.createElement("div");
      actions.className="actions";
      if (item.enabled) {
        const nextButton=document.createElement("button");
        nextButton.type="button";nextButton.className="secondary";
        nextButton.dataset.op="next-occurrence/"+item.id;
        nextButton.textContent="次回分を確認";
        actions.append(nextButton);
      }
      const toggle=document.createElement("button");
      toggle.type="button";toggle.className="secondary";
      toggle.dataset.op="schedule-toggle/"+item.id;
      toggle.textContent=item.enabled ? "一時停止" : "再開";
      actions.append(toggle);
      if (item.last_job) {
        const link=document.createElement("a");
        link.href="#job/"+item.last_job;
        link.textContent=item.recurring_draft ? "前回の定期下書きを開く" : "前回の仕事を開く";
        actions.append(link);
      }
      row.append(heading,timing,actions);
      schedules.append(row);
    }
    if (!items.length) {
      const empty=document.createElement("p");
      empty.className="empty";
      empty.textContent="定期実行は登録されていません。";
      schedules.append(empty);
    }
  }
  renderSchedules(workspace.schedules);
  section.refreshItems=renderSchedules;
  return section;
}

export function workPlanning(workspace,api,go) {
  const root=document.createElement("div");
  root.id="workPlanning";
  root.dataset.actor=workspace.employee.actor;
  root.dataset.ownerTeam=workspace.employee.team;
  const booking=reservation(workspace,api,go);
  root.append(booking,distributionForm(workspace,api,go));
  root.refreshItems=booking.refreshItems;
  return root;
}

function textNode(tag,text) {
  const element=document.createElement(tag);
  element.textContent=text;
  return element;
}

function distributionForm(workspace,api,go) {
  const article=document.createElement("article");
  article.className="panel pad";
  article.innerHTML='<h2 id="splitTitle">作業を分担する</h2><form aria-labelledby="splitTitle">' +
    '<div class="formlabel"><label for="splitOrigin">資料のある元の仕事</label><select name="origin" id="splitOrigin" required>' +
    '<option value="">完了した仕事を選ぶ</option></select></div><div class="formlabel"><label for="splitAsk">まとめる内容</label>' +
    '<textarea id="splitAsk" class="field" name="ask" maxlength="400" required rows="2"></textarea></div>' +
    '<fieldset class="panel pad"><legend>担当別の作業</legend><div id="splitInputs" class="stack"></div>' +
    '<button type="button" class="secondary" id="addPart">作業を追加する</button></fieldset>' +
    '<div class="log-filters"><div class="formlabel"><label for="splitParallel">同時実行の上限</label><input id="splitParallel" name="parallel" type="number" required min="1" max="3" value="2"></div>' +
    '<div class="formlabel"><label for="splitRuns">子作業の実行上限</label><input id="splitRuns" name="runs" type="number" required min="2" max="12" value="5"></div>' +
    '<div class="formlabel"><label for="splitCalls">モデル呼び出しの上限</label><input id="splitCalls" name="calls" type="number" required min="3" max="50" value="20"></div></div>' +
    '<button type="submit" class="primary">この分担で依頼する</button><p id="splitStatus" role="status"></p></form>';
  const form=article.querySelector("form"), parts=article.querySelector("#splitInputs"), add=article.querySelector("#addPart");
  let sources=[], generation=0;
  for (const work of workspace.jobs.filter(job=>job.status==="done")) form.elements.origin.add(new Option(work.ask,work.id));
  function fillSources(container,index) {
    container.replaceChildren(textNode("legend","作業"+index+"の資料"));
    for (const source of sources) {
      const label=document.createElement("label"), input=document.createElement("input");
      input.type="checkbox";input.name="source"+index;input.value=source.id;input.checked=true;
      label.append(input," "+source.title+"（"+source.version+"）");
      container.append(label,document.createElement("br"));
    }
    container.hidden=!sources.length;
  }
  form.elements.origin.onchange=async event=>{
    const run=++generation;
    const status=article.querySelector("#splitStatus");
    sources=[];
    const button=form.querySelector("button[type=submit]");
    button.disabled=true;
    try {
      if (event.target.value) {
        const job=await api("/api/jobs/"+encodeURIComponent(event.target.value));
        if (run!==generation) return;
        sources=job.sources.filter(source=>!source.unavailable && typeof source.text==="string").slice(0,8);
      }
      Array.from(parts.children).forEach((entry,index)=>fillSources(entry.querySelector("fieldset"),index+1));
      status.textContent=event.target.value && !sources.length ? "利用できる出典がありません。" : "";
    } catch(error) {if (run===generation) status.textContent=error.message;}
    finally {if (run===generation) button.disabled=Boolean(event.target.value && !sources.length);}
  };
  function addPart(name="",instructions="") {
    const index=parts.children.length+1, entry=document.createElement("div");
    entry.innerHTML='<div class="formlabel"><label for="partName'+index+'">作業'+index+'の名前</label>' +
      '<input id="partName'+index+'" name="partName" maxlength="48" required></div>' +
      '<div class="formlabel"><label for="partDirections'+index+'">作業'+index+'の指示</label>' +
      '<textarea id="partDirections'+index+'" class="field" name="directions" maxlength="300" rows="2" required></textarea></div><fieldset class="panel pad"></fieldset>';
    entry.querySelector("input").value=name;
    entry.querySelector("textarea").value=instructions;
    fillSources(entry.querySelector("fieldset"),index);
    parts.append(entry);
    add.disabled=parts.children.length===5;
  }
  addPart("調査","指定された資料の事実を原文の出典付きで整理する。");
  addPart("点検","元の資料から未確定の点と追加確認の項目を挙げる。");
  add.onclick=()=>{addPart();parts.lastElementChild.querySelector("input").focus();};
  let key=crypto.randomUUID();
  form.addEventListener("input",()=>{key=crypto.randomUUID();});
  form.onsubmit=async event=>{
    event.preventDefault();
    const button=event.submitter, data=new FormData(form), status=article.querySelector("#splitStatus");
    if (button.disabled) return;
    button.disabled=true;
    try {
      const request={origin:data.get("origin"),ask:data.get("ask"),maxParallel:Number(data.get("parallel")),
        maxRuns:Number(data.get("runs")),maxCalls:Number(data.get("calls")),parts:data.getAll("partName").map((name,index)=>
          ({name,instructions:data.getAll("directions")[index],sourceIds:data.getAll("source"+(index+1)).map(Number)}))};
      const params=payload(request);
      params.headers["Idempotency-Key"]=key;
      const result=await api("/api/work-split",params);
      go("job/"+result.id);
    } catch(error) {status.textContent=error.message;}
    finally {button.disabled=false;}
  };
  return article;
}

export function installDistribution(main,job,api,reload) {
  const view=document.createElement("section");
  view.className="panel pad distribution-panel";
  if (job.reservation) {
    const item=job.reservation;
    view.append(textNode("h2",item.recurring_draft ? "定期下書きの予約情報" : "予約から実行した仕事"),textNode("p",item.name+" ／ "+formatDate.format(item.due)+"（日本時間）"));
    if (item.period_from!==null) view.append(textNode("p","集計対象期間　"+formatDate.format(item.period_from)+" 〜 "+formatDate.format(item.period_to)));
  }
  if (job.distribution) {
    const plan=job.distribution;
    const statuses={queued:"未送信",dispatching:"受付確認中",running:"作業中",done:"完了",failed:"失敗",unknown:"受付不明",held:"停止中",
      held_dispatched:"送信中に停止",account_blocked:"利用資格の停止",membership_blocked:"資料範囲の変更",cancelled:"取り消し済み"};
    view.append(textNode("h2","作業分担"),textNode("p","最大同時 "+plan.maxParallel+"件 ／ 子作業 "+plan.runsUsed+" / "+plan.maxRuns+
      "件 ／ モデル呼び出し上限 "+plan.maxCalls+"件"));
    if (plan.aggregate==="partial") view.append(textNode("p","一部の結果で集約しています。各作業の結果は下に表示されます。"));
    const source=textNode("a","元の資料と仕事を開く");
    source.href="#job/"+plan.origin;
    view.append(source,textNode("p","資料　"+plan.sourceTitles.join("、")));
    const results=document.createElement("ol");
    for (const part of plan.parts) {
      const row=document.createElement("li");
      row.append(textNode("strong",part.name+"　"+(statuses[part.status] || "未送信")),textNode("p",part.instructions));
      row.append(textNode("p","資料　"+part.sourceTitles.join("、")));
      if (part.summary) row.append(textNode("p",part.summary));
      if (part.current_job) {
        const link=textNode("a","「"+part.name+"」の仕事と出典を開く");
        link.href="#job/"+part.current_job;
        row.append(link);
      }
      if (["failed","cancelled"].includes(part.status) && plan.runsUsed<plan.maxRuns) {
        const retry=textNode("button","この作業だけ再実行する");
        retry.type="button";retry.className="secondary";
        retry.onclick=()=>operate(retry,"retry",{position:part.position,generation:part.generation});
        row.append(retry);
      }
      results.append(row);
    }
    view.append(results);
    if (!plan.aggregate && plan.parts.some(part=>part.status==="done") && plan.parts.some(part=>part.status!=="done")) {
      const partial=textNode("button","完了済みの結果を集約する");
      partial.type="button";partial.className="secondary";
      partial.onclick=()=>operate(partial,"partial",{});
      view.append(partial);
    }
  }
  const status=textNode("p","");
  status.setAttribute("role","status");
  view.append(status);
  async function operate(button,action,input) {
    if (button.disabled) return;
    button.disabled=true;
    try { await api("/api/work-split/"+job.id+"/"+action,payload(input)); await reload(); }
    catch(error) {status.textContent=error.message;}
    finally {button.disabled=false;}
  }
  const title=main.querySelector(".heading");
  if (title) title.after(view);
  else main.prepend(view);
}
