const flags = {daily:"毎日", weekdays:"平日", weekly:"毎週", monthly:"毎月"};
const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

function cadence(schedule) {
  const {frequency, weekday, month_day, time} = schedule;
  const label = frequency === "weekly" ? "毎週" + weekdays[weekday] + "曜" :
    frequency === "monthly" ? (month_day ? "毎月" + month_day + "日" : "毎月末日") : flags[frequency];
  return `${label} ${time}（日本時間）`;
}

export function memberWorkSections(person, escape, timestamp) {
  const {runtime, schedules} = person;
  const configured = runtime?.runtime ? escape(runtime.runtime) + (runtime.configured ? "" : "（接続設定が未登録）") : "未設定";
  const editRuntime = runtime?.aliases.length && (runtime.aliases.length > 1 || !runtime.configured);
  return '<section class="admin-member-work" aria-labelledby="member-runtime-title"><h4 id="member-runtime-title">本人用コンテナ</h4><p>' + configured + '</p>' +
    (editRuntime ? '<button type="button" class="secondary" data-member-work="runtime">コンテナIDを編集</button>' : "") + '</section>' +
    '<section class="admin-member-work" aria-labelledby="member-schedule-title"><div class="sectionhead"><h4 id="member-schedule-title">定期実行（cron jobs）</h4>' +
    (person.active ? '<button type="button" class="secondary" data-member-work="schedule">予約を追加</button>' : "") + '</div>' +
    (schedules?.map(schedule => '<article class="model-profile-row logrow"><div><strong>' + escape(schedule.name) + '</strong><p>' + escape(cadence(schedule)) +
      ' ／ ' + (schedule.enabled ? "次回 " + escape(timestamp(schedule.next_run)) + " JST" : "一時停止") + '</p></div>' +
      (person.active ? '<button type="button" class="secondary" data-member-work="schedule" data-schedule="' + escape(schedule.id) + '">予約を編集</button>' : "") +
      '</article>').join("") || '<p class="meta">登録された予約はありません。</p>') + '</section>';
}

export function installMemberWork({open, request, escape, selected, reload}) {
  const root = document.querySelector("#memberships");
  const dialog = document.querySelector("#dialog");
  const reason = '<label class="formlabel">変更理由（必須）<input name="reason" required maxlength="240"></label>';
  const options = (items, chosen) => items.map(([key,label]) => '<option value="'+escape(key)+'"'+(String(key)===String(chosen) ? ' selected' : '')+'>'+escape(label)+'</option>').join("");

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-member-work]");
    const person = button && selected();
    if (!person) return;
    const actor = person.actor;
    const endpoint = "/api/admin/memberships/"+encodeURIComponent(actor);
    const runtime = button.dataset.memberWork === "runtime";
    const schedule = person.schedules.find(row=>row.id===button.dataset.schedule);
    let fields;
    if (runtime) {
      const {aliases, runtime: assigned} = person.runtime;
      fields = '<label class="formlabel">コンテナID<select name="runtime">'+options(aliases.map(id=>[id,id]),assigned)+'</select></label>' +
        '<p class="meta">変更は次の送信から適用されます。受付済みの実行は受付時のコンテナで追跡します。</p>';
    } else {
      const askMax = Math.max(500, schedule?.ask.length || 0);
      fields = '<label class="formlabel">予約名<input name="name" value="'+escape(schedule?.name)+'" maxlength="80" required></label>' +
        '<label class="formlabel">依頼内容<textarea name="ask" class="field" rows="3" maxlength="'+askMax+'" required'+(schedule?.template?' readonly':'')+'>'+escape(schedule?.ask)+'</textarea></label>' +
        '<label class="formlabel">実行日<select name="frequency">'+options(Object.entries(flags),schedule?.frequency || "weekly")+'</select></label>' +
        '<label class="formlabel">曜日<select name="weekday">'+options(weekdays.map((day,i)=>[i,day+"曜"]),schedule?.weekday ?? 1)+'</select></label>' +
        '<label class="formlabel">日<select name="month_day">'+options([[0,"月末"],...Array.from({length:31},(_,i)=>[i+1,(i+1)+"日"])],schedule?.month_day ?? 0)+'</select></label>' +
        '<label class="formlabel">時刻（日本時間）<input type="time" name="time" value="'+escape(schedule?.time || "09:00")+'" required></label>' +
        '<label class="formlabel">状態<select name="enabled">'+options([["true","有効"],["false","一時停止"]],String(schedule?.enabled ?? false))+'</select></label>';
    }
    open(person.name + (runtime ? "のコンテナ設定" : schedule ? "の予約を編集" : "の予約を追加"),
      '<form id="memberWorkForm" aria-labelledby="dlgtitle">'+fields+reason+'<div class="actions"><button type="submit" class="primary">'+
      (runtime ? "コンテナ設定を保存" : "予約を保存")+'</button></div><p class="form-error" role="alert"></p></form>');
    const form = dialog.querySelector("#memberWorkForm");
    if (!runtime) {
      const draw = () => {
        const frequency = form.elements.frequency.value;
        for (const [field,show] of [[form.elements.weekday,frequency==="weekly"],[form.elements.month_day,frequency==="monthly"]]) {
          field.disabled = !show;
          field.closest("label").hidden = !show;
        }
      };
      form.elements.frequency.addEventListener("change",draw);
      draw();
    }
    form.querySelector("input,select").focus();
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      if (submit.disabled || selected()?.actor!==actor) return;
      submit.disabled = true;
      const data = Object.fromEntries(new FormData(form));
      if (runtime) data.revision = person.runtime.revision;
      else Object.assign(data,{weekday:Number(data.weekday ?? 0),month_day:Number(data.month_day ?? 0),enabled:data.enabled==="true",
        ...(schedule && {id:schedule.id,base:schedule.base})});
      try {
        const result = await request(runtime ? "/runtime" : "/schedules", data, endpoint);
        if (form.isConnected) dialog.close();
        if (selected()?.actor!==actor) return;
        await reload(actor,false);
        const target = runtime ? '[data-member-work="runtime"]' : '[data-schedule="'+result.id+'"]';
        root.querySelector(target)?.focus();
        document.querySelector("#notice").textContent = runtime ? "コンテナ設定を保存しました。" : "定期実行を保存しました。";
      } catch (error) { form.querySelector(".form-error").textContent = error.message; }
      finally { submit.disabled = false; }
    });
  });
}
