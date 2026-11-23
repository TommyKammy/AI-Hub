(() => {
  const $ = id => document.getElementById(id);
  const modes = {
    inherit: "全社設定を継承",
    fixed: "標準モデルのみ",
    approved: "指定した承認済みモデルを選択可能",
  };
  const companyModes={
    fixed:"標準モデルに固定",
    approved:"全社員が承認済みモデルから選択可",
    groups:"グループ別に設定",
  };
  const escape = value => String(value ?? "").replace(/[&<>"']/g,c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;",
  })[c]);
  const endpoint = "/api/admin/groups";

  async function api(path="", input) {
    const response=await fetch(endpoint+path,input===undefined ? {} : {
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),
    });
    const result=await response.json();
    if (!response.ok) throw new Error(result.message || "グループ情報を取得できませんでした。");
    return result;
  }

  function accessFields(prefix,employees,actor) {
    return '<div class="log-filters"><div class="formlabel"><label for="'+prefix+'Employee">社員</label><select id="'+prefix+'Employee" name="employee">'+
      employees.map(row=>'<option value="'+escape(row.actor)+'"'+(row.actor===actor?' selected':'')+'>'+
        escape(row.name+" · "+row.team)+'</option>').join("")+'</select></div>'+
      '<div class="formlabel"><label for="'+prefix+'DataClass">資料区分</label><select id="'+prefix+'DataClass" name="dataClass"><option value="general">合成資料</option>'+
      '<option value="restricted">限定合成資料</option></select></div></div>';
  }

  function accessSummary(result,dataClass) {
    const names = result[dataClass].map((model,index)=>escape(model.name)+"（v"+model.release+(index===0?"・標準":"")+"）");
    return '<p><strong>'+(names.join(" ／ ") || "利用できるモデルなし")+'</strong></p>'+
      '<p class="meta">'+(result.eligible ? "所属グループ　"+escape(result.groups.join("、") || "なし") : "社員の利用が停止されています。")+'</p>';
  }

  function editGroup(group,{employees,candidates}) {
    const dialog=$("dialog");
    const selected=group?.models.map(model=>model.id) || [];
    const checks=(name,items,checked)=>items.map(item=>
      '<label class="library-choice"><input type="checkbox" name="'+name+'" value="'+escape(item.id)+'"'+
      (checked.includes(item.id)?" checked":"")+'> '+escape(item.name)+'</label>').join("");
    $("dlgtitle").textContent=group ? "グループを編集" : "グループを作成";
    $("dialogError").textContent="";
    $("dialogContent").innerHTML='<form id="localGroupEditor" class="stack">'+
      '<label class="formlabel">グループ名<input name="name" required maxlength="80" value="'+escape(group?.name)+'"></label>'+
      '<fieldset><legend>メンバー'+(group?.directorySource?'（手動で追加）':'')+'</legend>'+
      (group?.directorySource ? '<p class="meta">同期によるメンバーはEntra ID 同期で確認できます。</p>' : '')+
      checks("member",employees.map(row=>({id:row.actor,name:row.name+" · "+row.team})),group?.members || [])+'</fieldset>'+
      '<label class="formlabel">モデル選択方針<select name="mode">'+Object.entries(modes).map(([key,label])=>
        '<option value="'+key+'"'+(key===group?.mode?" selected":"")+'>'+label+'</option>').join("")+'</select></label>'+
      '<fieldset data-model-candidates><legend>選択を許可する公開済みモデル</legend>'+checks("model",
        candidates.map(model=>({...model,name:model.name+(model.stopped?"（停止中）":"")})),selected)+'</fieldset>'+
      '<section><h3>保存前プレビュー</h3>'+accessFields("previewGroup",employees,group?.members[0])+
      '<button type="button" class="secondary" data-preview>適用結果を確認</button><div data-access-result role="status"></div></section>'+
      '<label class="formlabel">変更理由<textarea name="reason" rows="2" required maxlength="240"></textarea></label>'+
      '<button class="primary" type="submit" disabled>グループを保存</button></form>';
    const form=$("localGroupEditor"), candidateList=form.querySelector("[data-model-candidates]");
    const previewButton=form.querySelector("[data-preview]"), saveButton=form.querySelector('[type="submit"]');
    const result=form.querySelector("[data-access-result]");
    const groupId=group?.id || crypto.randomUUID();
    let preview, request=0;
    function setMode() { candidateList.disabled=candidateList.hidden=form.elements.mode.value!=="approved"; }
    function proposal() {
      const fields=new FormData(form);
      return {id:groupId,name:fields.get("name"),mode:fields.get("mode"),members:fields.getAll("member"),
        models:fields.getAll("model"),revision:group?.revision || 0,employee:fields.get("employee")};
    }
    function drawPreview() {
      if (!preview) return;
      const cls=form.elements.dataClass.value;
      result.innerHTML='<div class="version-comparison"><section><h4>現在</h4>'+accessSummary(preview.before,cls)+
        '</section><section><h4>保存後</h4>'+accessSummary(preview.after,cls)+'</section></div>'+
        '<p class="meta">確認対象 '+preview.affected+' 人</p>';
    }
    form.addEventListener("input",event=>{
      if (event.target.name==="dataClass") { drawPreview(); return; }
      if (event.target.name==="reason") return;
      request++;
      preview=undefined;
      saveButton.disabled=true;
      previewButton.disabled=false;
      result.replaceChildren();
      $("dialogError").textContent="";
      setMode();
    });
    previewButton.addEventListener("click",async()=>{
      if (!form.elements.name.reportValidity()) return;
      const seq=++request;
      previewButton.disabled=true;
      saveButton.disabled=true;
      $("dialogError").textContent="";
      try {
        const current=await api("/preview",proposal());
        if (seq!==request || !form.isConnected || !dialog.open) return;
        preview=current;
        drawPreview();
        saveButton.disabled=false;
      } catch (error) {
        if (seq===request && form.isConnected) $("dialogError").textContent=error.message;
      } finally { if (seq===request) previewButton.disabled=false; }
    });
    form.addEventListener("submit",async event=>{
      event.preventDefault();
      if (!preview || saveButton.disabled) return;
      saveButton.disabled=true;
      previewButton.disabled=true;
      try {
        await api("/save",{...proposal(),preview:preview.preview,reason:form.elements.reason.value});
        dialog.close();
        window.dispatchEvent(new Event("local-model-groups-changed"));
        await window.loadAdminGroups();
        $("notice").textContent="グループを保存しました。";
        document.querySelector('[data-group-edit="'+groupId+'"]')?.focus();
      } catch (error) {
        $("dialogError").textContent=error.message;
        previewButton.disabled=false;
        preview=undefined;
      }
    });
    setMode();
    if (!dialog.open) dialog.showModal();
    form.elements.name.focus();
  }

  function editCompany(config) {
    const {selection,candidates}=config;
    const dialog=$("dialog");
    $("dlgtitle").textContent="全社のモデル選択方針";
    $("dialogError").textContent="";
    $("dialogContent").innerHTML='<form id="companyModelSelection" class="stack"><div class="formlabel">'+
      '<label for="companySelectionMode">新しい依頼に使うモデル</label><select id="companySelectionMode" name="mode">'+
      Object.entries(companyModes).map(([mode,label])=>'<option value="'+mode+'"'+
        (mode===(selection.revision ? selection.mode : "fixed")?' selected':'')+'>'+label+'</option>').join("")+'</select></div>'+
      '<fieldset><legend>標準モデルに加えて公開する候補</legend>'+
      (candidates.map((item,index)=>'<label class="library-choice"><input type="checkbox" name="model" value="'+escape(item.id)+'"'+
        (selection.models.includes(item.id)?" checked":"")+(item.stopped && !selection.models.includes(item.id)?" disabled":"")+
        '> '+escape(item.name)+(item.stopped?"（停止中）":index===0?"（最新の標準）":"")+'</label>').join("") ||
        '<p>公開済みのモデルはありません。</p>')+'</fieldset>'+
      '<p class="meta">公開後も、社員のEntraグループと資料区分で許可されたモデルが候補になります。</p>'+
      '<label class="formlabel">変更理由<textarea name="reason" rows="2" required maxlength="240"></textarea></label>'+
      '<button class="primary" type="submit">公開方針を保存</button></form>';
    const form=$("companyModelSelection");
    const fieldset=form.querySelector("fieldset");
    const toggle=()=>{fieldset.hidden=fieldset.disabled=form.elements.mode.value==="fixed";};
    form.elements.mode.onchange=toggle;
    form.onsubmit=async event=>{
      event.preventDefault();
      if (event.submitter.disabled) return;
      event.submitter.disabled=true;
      try {
        await api("/company",{mode:form.elements.mode.value,models:new FormData(form).getAll("model"),
          reason:form.elements.reason.value,revision:selection.revision});
        dialog.close();
        await window.loadAdminGroups();
        $("notice").textContent="全社のモデル選択方針を保存しました。";
        document.querySelector("[data-company-selection]")?.focus();
      } catch (error) { $("dialogError").textContent=error.message; }
      finally {event.submitter.disabled=false;}
    };
    toggle();
    if (!dialog.open) dialog.showModal();
    form.elements.mode.focus();
  }

  window.loadAdminGroups=async () => {
    const host=$("adminGroupSummary");
    try {
      const config=await api();
      const {configured,groups,manager,employees,selection}=config;
      host.innerHTML='<section class="panel pad"><h2>全社のモデル選択方針</h2><p>'+
        (selection?.revision ? escape(companyModes[selection.mode]) : configured ? "従来の全社既定とグループ設定を適用" : "標準モデルを使用")+'</p>'+
        '<p class="meta">停止中のモデルと資料区分で許可されていないモデルは利用候補から外れます。</p>'+
        (manager?'<div class="actions"><button type="button" class="secondary" data-company-selection>全社方針を設定</button>'+
          '<a class="link" href="#models">モデル設定</a></div>':"")+'</section>'+
        '<div class="sectionhead"><h2>グループ一覧</h2>'+
        (manager?'<button type="button" class="primary" data-group-create>グループを作成</button>':"")+'</div>'+
        (groups.map(group=>{
          const models=group.models.map(model=>model.name || model.connection+" / "+model.modelId);
          const source=group.directorySource ? "Entra ID 同期 ／ "+modes[group.mode] : modes[group.mode] || "Entra ID 同期";
          const names=manager && group.members ? group.members.map(actor=>employees.find(row=>row.actor===actor)?.name).filter(Boolean) : [];
          return '<article class="panel pad"><div class="sectionhead"><h3>'+escape(group.name)+'</h3>'+
            (manager && group.mode ? '<button type="button" class="secondary" data-group-edit="'+escape(group.id)+'">編集</button>':"")+
            '</div><p>'+escape(source)+' ／ メンバー '+group.memberCount+' 人'+(names.length?'（'+escape(names.join("、"))+'）':"")+'</p>'+
            (models.length?'<p class="meta">'+escape(models.join("、"))+'</p>':"")+'</article>';
        }).join("") || '<p>登録されたグループはありません。</p>')+
        (manager ? '<section class="panel pad"><h2>社員の適用結果</h2><form id="savedGroupAccess">'+accessFields("savedGroup",employees)+
          '<div data-access-result role="status"></div></form></section>':"");
      if (!manager) return;
      host.querySelector("[data-company-selection]").onclick=()=>editCompany(config);
      host.querySelector("[data-group-create]").onclick=()=>editGroup(null,config);
      for (const button of host.querySelectorAll("[data-group-edit]"))
        button.onclick=()=>editGroup(groups.find(group=>group.id===button.dataset.groupEdit),config);
      const lookup=$("savedGroupAccess"), result=lookup.querySelector("[data-access-result]");
      let request=0;
      async function lookUp() {
        const seq=++request;
        try {
          const access=await api("/access?actor="+encodeURIComponent(lookup.elements.employee.value));
          if (seq===request && lookup.isConnected) result.innerHTML=accessSummary(access,lookup.elements.dataClass.value);
        } catch (error) {
          if (seq===request && lookup.isConnected) result.textContent=error.message;
        }
      }
      lookup.addEventListener("change",lookUp);
      await lookUp();
    } catch (error) {
      host.textContent=error.message;
    }
  };
})();
