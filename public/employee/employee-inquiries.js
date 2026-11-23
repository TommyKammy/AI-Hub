export function versionReceipts(j,version) {
  const receipts=[];
  let row=j.versions.find(v=>v.version===version);
  while (row) {
    const ticket=row.answer_inquiry && j.inquiries.find(i=>i.id===row.answer_inquiry && i.answer);
    if (ticket && !receipts.some(r=>r.source_id===row.answer_source))
      receipts.push({id:ticket.id,subject:ticket.subject,source_id:row.answer_source,round:row.answer_round,version:row.version});
    row=j.versions.find(v=>v.version===row.base);
  }
  return receipts;
}

export function employeeInquiries({
  esc, button, section, plannedTime, displayedVersion, acceptsJobFollowup,
  api, modal, go, route, reload, notice, showDisabled,
}) {
  function receiptLinks(j,version) {
    const receipts=versionReceipts(j,version);
    const tickets=new Set(receipts.map(t=>t.id));
    return receipts.map(t=>'<p>'+receiptCitation(t,"secondary",version)+'</p>').join("")+
      Array.from(tickets,id=>{
        const t=j.inquiries.find(t=>t.id===id);
        return '<p><a href="#job/'+esc(j.id)+'/reply/'+id+'">受付票 #'+id+(t.resolution ? " のやり取りを確認" : " のやり取り・追加質問")+'</a></p>'+
          resolutionPanel(t,version===j.adopted_version);
      }).join("");
  }
  function resolutionPanel(t,allowResolve) {
    if (t.resolution) {
      const r=t.resolution;
      return '<p><strong>解決済み</strong> ・ '+esc(r.name)+' ・ '+esc(plannedTime(r.created))+
        '<br>第'+r.version+'版を採用（再回答'+r.round+'回目）</p>';
    }
    const candidate=t.resolution_candidate;
    if (!allowResolve || !candidate) return "";
    const last=t.followups.at(-1);
    return (last && !last.answer ? '<p>追加質問（'+last.number+'回目）は未回答のまま履歴に残ります。</p>' : "")+
      button("受付票 #"+t.id+" を解決済みにする","resolve-inquiry/"+t.id+"/"+candidate.version,"secondary");
  }
  function receiptCitation(t,cls,from) {
    const label="["+t.source_id+"] 受付票 #"+t.id+(t.round ? " 再回答（"+t.round+"回目）" : "");
    return '<a class="'+cls+'" href="#inquiry/'+t.id+(t.round ? "/round/"+t.round+"?from="+from : "")+'">'+esc(label)+'</a>';
  }
  function citationText(text, j, version) {
    const receipts=versionReceipts(j,version);
    return esc(text).replace(/\[(\d+)\]/g, (mark, number) => {
      const ticket=receipts.find(t=>t.source_id===Number(number));
      if (ticket) return receiptCitation(ticket,"citation",displayedVersion(j));
      return j.sources.some(s => s.id === Number(number))
        ? '<button type="button" class="citation" data-source-version="'+version+'" data-op="source/' + number + '" aria-label="出典' + number + 'を開く">' + mark + '</button>' : mark;
    });
  }
  function ticketLink(id,label) {
    return '<a class="secondary" href="#inquiry/'+Number(id)+'">'+esc(label)+'</a>';
  }
  function ticketFiles(files) {
    return files.length ? files.map(s=>'<details><summary>'+esc(s.title)+'</summary><small>'+esc(s.version)+'</small><p class="note">'+esc(s.text)+'</p></details>').join("") : '<p>添付なし</p>';
  }
  function inquiryButton(j,version,desks) {
    if (j.team_denied || j.procedure_revoked) return "";
    const item=j.inquiries.find(i=>i.version===version);
    if (item?.id) return ticketLink(item.id,"受付票 #"+item.id+" を開く");
    if (!desks.length || !["done","failed"].includes(j.status)) return "";
    return button(item ? "起票案を確認" : "問い合わせの起票案を作る","inquiry-draft/"+version,"secondary");
  }
  function threadEntry(title,name,time,body,anchor) {
    return '<h4'+(anchor ? ' tabindex="-1" id="'+anchor+'"' : '')+'>'+esc(title)+'</h4><p class="meta">'+esc(name)+' ・ '+esc(plannedTime(time))+'</p><p class="note">'+esc(body)+'</p>';
  }
  function answerSection(ticket,owner,job,employeeName) {
    const {id,desk,answer,followups}=ticket, last=followups.at(-1);
    const adopted=job && (job.adopted_version ?? job.versions.at(-1)?.version);
    const reflected=job ? versionReceipts(job,adopted) : [];
    const turns=followups.map(t=>{
      const anchor="inquiry-question-"+id+"-"+t.number;
      let action="";
      if (t.answer && owner) {
        if (job) {
          const candidate=reflected.find(r=>r.id===id && r.round===t.number) ||
            job.versions.find(v=>v.answer_inquiry===id && v.answer_round===t.number && v.base===adopted);
          if (candidate) action='<a class="secondary" href="#job/'+esc(job.id)+'/version/'+candidate.version+'">再回答を反映した第'+candidate.version+'版を確認</a>';
          else if (acceptsJobFollowup(job))
            action=button("この再回答を第"+adopted+"版に反映するようHermesに依頼","reflect-answer/"+id+"/"+t.number,"secondary");
        } else action='<a href="#job/'+esc(ticket.job)+'/reply/'+id+'/round/'+t.number+'">元の仕事でこの再回答を確認</a>';
      }
      return '<section aria-labelledby="'+anchor+'">'+threadEntry("追加質問（"+t.number+"回目）",t.asker,t.asked,t.question,anchor)+
        (t.answer ? threadEntry("窓口の再回答（"+t.number+"回目）",t.responder,t.answered,t.answer,"inquiry-answer-"+id+"-"+t.number) :
          '<p class="meta">'+(ticket.resolution ? "未回答のまま解決" : "窓口の再回答待ち")+'</p>')+action+'</section>';
    }).join("");
    return '<section class="memo-questions" aria-labelledby="inquiry-answer-'+id+'"><h3 tabindex="-1" id="inquiry-answer-'+id+'">受付票 #'+id+' への回答</h3>'+
      resolutionPanel(ticket,job && owner)+(job ? '<p>'+esc(ticket.subject)+'</p>'+threadEntry("最初の問い合わせ",employeeName,ticket.opened,ticket.initial_question) : "")+
      threadEntry("窓口の初回回答",desk+" ・ "+answer.name,answer.created,answer.body)+turns+
      (owner && !ticket.resolution && (!last || last.answer) ? button("同じ受付票に追加質問","followup-question/"+id+"/"+((last?.number ?? 0)+1),"secondary") : "")+
      (ticket.can_reanswer ? button("追加質問に回答","followup-answer/"+id+"/"+last.number,"primary") : "")+'</section>';
  }
  function ticketDetail(t,hash) {
    const pending=t.followups.length && !t.followups.at(-1).answer;
    const from=Number(hash.match(/\/round\/\d+\?from=(\d+)$/)?.[1]);
    const back=t.job && from ? '<a class="link back" href="#job/'+esc(t.job)+'/version/'+from+'">修正版（第'+from+'版）に戻る</a>' : button("依頼一覧へ","jobs","link back","back");
    return back+'<div class="heading"><h1>受付票 #'+t.id+'</h1><span class="status">'+(t.resolution ? "解決済み" : pending ? "追加質問あり" : t.answer ? "回答済み" : "受付済み")+'</span></div>'+
      '<article class="panel pad"><h2>'+esc(t.subject)+'</h2><p>'+esc(t.desk)+' ・ '+esc(plannedTime(t.created))+' 受付<br>依頼者　'+esc(t.requester)+'</p><p class="note">'+esc(t.body)+'</p>'+
      '<h3>添付した資料の本文</h3>'+ticketFiles(t.attachments)+(t.answer ? answerSection(t,Boolean(t.job)) :
        t.can_answer ? button("受付票に回答","answer-ticket/"+t.id,"primary") : "")+
      (t.job ? button("元の仕事（第"+t.version+"版）","origin/"+t.job+"/"+t.version,"link") : "")+'</article>';
  }
  function inquiryEditor(j,version,draft,reviewSeq,desks) {
    const files=j.sources.map(s=>'<label><input type="checkbox" name="attachment" value="'+s.id+'" '+(s.unavailable ? 'disabled' : '')+'> '+esc(s.title)+
      (draft.attachments.includes(s.id) ? '（Hermesの添付候補）' : '')+'</label>').join("<br>");
    modal("問い合わせの起票案",'<form id="inquiryReview" data-job="'+esc(j.id)+'" data-version="'+version+'" data-review-seq="'+reviewSeq+'" aria-labelledby="dlgtitle">'+
      '<fieldset data-ticket-fields><legend>第'+version+'版から作成</legend><label for="desk">担当窓口</label><select name="desk" id="desk" required><option value="">選択してください</option>'+
      desks.map(d=>'<option value="'+esc(d.id)+'" data-recipient="'+esc(d.actor)+'">'+esc(d.name+"（"+d.contact+"）")+'</option>').join("")+'</select>'+
      '<label for="ticketSubject">件名</label><input id="ticketSubject" name="subject" class="field" maxlength="160" required value="'+esc(draft.subject)+'">'+
      '<label for="ticketBody">本文</label><textarea id="ticketBody" name="body" class="field" rows="7" maxlength="4000" required>'+esc(draft.body)+'</textarea>'+
      '<fieldset><legend>窓口に渡す資料の本文</legend>'+(files || "添付候補なし")+'</fieldset></fieldset>'+
      '<section data-ticket-preview hidden></section><div class="actions"><button type="button" class="secondary" data-op="edit-inquiry" hidden>編集に戻る</button>'+
      '<button class="primary" type="submit">登録内容を確認</button></div><p class="form-error" role="alert"></p></form>');
  }

  function receivedInquiryList(tickets) {
    return tickets.length ? section("窓口で受け付けた問い合わせ")+
      '<div class="panel pad">'+tickets.map(t=>'<p>'+
        ticketLink(t.id,"#"+t.id+" "+t.subject)+' '+esc(t.desk_name)+' ・ '+
        (t.resolved_at ? "解決済み" : t.pending_followup ? "追加質問あり" : t.answered ? "回答済み" : "未回答")+'</p>').join("")+'</div>' : "";
  }

  function jobAnswer(j,version,employeeName) {
    const ticket=j.inquiries.find(i=>i.version===version && i.answer);
    const revision=ticket && j.versions.find(v=>v.answer_inquiry===ticket.id && !v.answer_round);
    const reflect=revision ? '<a class="secondary" href="#job/'+esc(j.id)+'/version/'+revision.version+'">回答を反映した第'+revision.version+'版を確認</a>' :
      ticket && acceptsJobFollowup(j) ? button(ticket.followups.length ? "初回回答を反映するようHermesに依頼" : "この回答を反映するようHermesに依頼","reflect-answer/"+ticket.id,"secondary") : "";
    return ticket ? answerSection(ticket,true,j,employeeName)+reflect : "";
  }

  async function resolveInquiry(b,job) {
    const op=b.dataset.op;
    if (b.disabled) return;
    const [,id,version]=op.split("/"),t=job.inquiries.find(t=>t.id===Number(id)),last=t?.followups.at(-1);
    const current=location.hash;
    b.disabled=true;
    try {
      await api("/api/inquiries/"+id+"/resolve",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({version:Number(version),last_round:last.number,last_answered:last.answered})});
      if (current===location.hash) {await reload();notice("受付票 #"+id+" を解決済みにしました。");}
    } catch(error) {
      if (!showDisabled(error) && current===location.hash) {await reload();notice(error.message);}
    } finally {b.disabled=false;}
  }

  async function reflectAnswer(b,job) {
    const op=b.dataset.op;
    const [,ticketId,roundId]=op.split("/"), id=Number(ticketId),round=Number(roundId),ticket=job.inquiries.find(i=>i.id===id && i.answer);
    if (!ticket || b.disabled) return;
    const jobId=job.id;
    b.disabled=true;
    try {
      const result=await api("/api/jobs/"+jobId+"/revise",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},
        body:JSON.stringify({base:round ? (job.adopted_version ?? job.versions.at(-1).version) : ticket.version,
          latest:job.versions.at(-1).version,answer_inquiry:id,...(round && {answer_round:round})})});
      if (route()==="job/"+jobId) go("job/"+jobId+"/version/"+result.version);
    } catch(error) {if (!showDisabled(error)) notice(error.message);}
    finally {b.disabled=false;}
  }

  function openAnswerForm(b) {
    const op=b.dataset.op;
    const [action,id,round]=op.split("/"), asking=action==="followup-question";
    const endpoint="/api/inquiries/"+Number(id)+(round ? "/followups/"+Number(round) : "")+(asking ? "" : "/answer");
    const title=asking ? "に追加質問" : round ? "の追加質問に回答" : "に回答";
    modal("受付票 #"+Number(id)+title,'<form id="inquiryAnswer" data-endpoint="'+endpoint+'" aria-labelledby="dlgtitle">'+
      '<label for="inquiryReply">'+(asking ? "窓口への追加質問" : "依頼者への回答")+'</label><textarea id="inquiryReply" name="body" class="field" rows="5" maxlength="4000" required></textarea>'+
      '<div class="actions"><button class="primary" type="submit">'+(asking ? "追加質問を送信" : "回答を送信")+'</button></div><p class="form-error" role="alert"></p></form>');
  }

  async function prepareDraft(b,job,desks) {
    const op=b.dataset.op;
    const version=Number(op.split("/")[1]), item=job.inquiries.find(i=>i.version===version);
    if (item) {inquiryEditor(job,version,item.draft,item.review_seq,desks); return;}
    b.disabled=true;
    try {
      await api("/api/jobs/"+job.id+"/inquiry/prepare",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({version})});
      await reload();
    } catch(error) {if (!showDisabled(error)) notice(error.message);}
    finally {b.disabled=false;}
  }

  async function editDraft(b) {
    const f=b.form, fields=f.querySelector("[data-ticket-fields]");
    b.disabled=true;
    try {
      const result=await api("/api/jobs/"+f.dataset.job+"/inquiry/review",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"return",version:Number(f.dataset.version),expected:Number(f.dataset.reviewSeq)}),
      });
      f.dataset.reviewSeq=result.seq;
    } catch(error) {if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message; return;}
    finally {b.disabled=false;}
    delete f.confirmedTicket;
    fields.disabled=false; fields.hidden=false; f.querySelector("[data-ticket-preview]").hidden=true;
    b.hidden=true; f.querySelector("[type=submit]").textContent="登録内容を確認"; f.elements.desk.focus();
  }

  const clickActions = new Map([
    ["resolve-inquiry", resolveInquiry],
    ["reflect-answer", reflectAnswer],
    ["answer-ticket", openAnswerForm],
    ["followup-question", openAnswerForm],
    ["followup-answer", openAnswerForm],
    ["inquiry-draft", prepareDraft],
  ]);
  function actionFor(op) {
    if (op === "edit-inquiry") return editDraft;
    const slash = op.indexOf("/");
    if (slash !== -1) return clickActions.get(op.slice(0,slash));
  }

  async function submitAnswer(f) {
    const btn=f.querySelector("[type=submit]"), body=f.elements.body.value.trim();
    if (btn.disabled) return;
    if (!body) {f.querySelector(".form-error").textContent="本文を入力してください。"; f.elements.body.focus(); return;}
    btn.disabled=true;
    try {
      await api(f.dataset.endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({body})});
      const dialog=f.closest("dialog");
      if (f.isConnected && dialog?.open) dialog.close();
      await reload();
    } catch(error) {if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message;}
    finally {btn.disabled=false;}
  }

  async function submitDraft(f,currentJob) {
    const dialog=f.closest("dialog");
    const btn=f.querySelector("[type=submit]"), fields=f.querySelector("[data-ticket-fields]"), preview=f.querySelector("[data-ticket-preview]");
    if (btn.disabled) return;
    if (!f.confirmedTicket) {
      const data=new FormData(f), attachments=data.getAll("attachment").map(Number);
      const payload={version:Number(f.dataset.version),desk:data.get("desk"),recipient:f.elements.desk.selectedOptions[0].dataset.recipient,
        subject:data.get("subject").trim(),body:data.get("body").trim(),attachments};
      if (!payload.subject || !payload.body) {f.querySelector(".form-error").textContent="件名と本文を入力してください。"; return;}
      f.querySelector(".form-error").textContent="";
      btn.disabled=true;
      try {
        const result=await api("/api/jobs/"+f.dataset.job+"/inquiry/review",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({...payload,action:"preview",expected:Number(f.dataset.reviewSeq)}),
        });
        f.dataset.reviewSeq=result.seq;
      } catch(error) {if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message; return;}
      finally {btn.disabled=false;}
      const job=currentJob();
      if (!dialog.open || !f.isConnected || job?.id!==f.dataset.job) return;
      preview.innerHTML='<h3>登録内容の確認</h3><p>宛先　'+esc(f.elements.desk.selectedOptions[0].text)+'</p><h3>'+esc(payload.subject)+'</h3><p class="note">'+esc(payload.body)+'</p>'+
        '<h3>添付する資料の本文</h3>'+ticketFiles(job.sources.filter(s=>attachments.includes(s.id)));
      f.confirmedTicket={...payload,review_seq:Number(f.dataset.reviewSeq)}; fields.disabled=true; fields.hidden=true; preview.hidden=false;
      f.querySelector("[data-op=edit-inquiry]").hidden=false; btn.textContent="この内容で起票"; btn.focus(); return;
    }
    btn.disabled=true;
    try {
      const ticket=await api("/api/jobs/"+f.dataset.job+"/inquiry/register",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(f.confirmedTicket),signal:AbortSignal.timeout(12000)});
      dialog.close(); go("inquiry/"+ticket.id);
    } catch(error) {
      if (showDisabled(error)) return;
      if (!error.httpStatus || error.httpStatus>=500) {
        const updated=await api("/api/jobs/"+f.dataset.job).catch(()=>null);
        const saved=updated?.inquiries.find(item=>item.version===f.confirmedTicket.version && item.id);
        if (saved) { dialog.close(); go("inquiry/"+saved.id); return; }
        f.querySelector(".form-error").textContent="受付を確認できません。元の仕事から同じ起票案を確認してください。";
      } else f.querySelector(".form-error").textContent=error.message;
    }
    finally {btn.disabled=false;}
  }

  const submissions = new Map([
    ["inquiryAnswer", submitAnswer],
    ["inquiryReview", submitDraft],
  ]);
  function submissionFor(id) {
    return submissions.get(id);
  }

  return { receivedInquiryList, citationText, inquiryButton, jobAnswer, receiptLinks, ticketDetail, actionFor, submissionFor };
}
