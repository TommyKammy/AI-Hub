import { createHash } from "node:crypto";
import { activeMember } from "./memberships.mjs";
import { HubError } from "./operations.mjs";
import { librarySelection, listLibraries } from "./libraries.mjs";

const day=86400000, japan=9*3600000;
const names="日月火水木金土";
const clock=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",dateStyle:"long",timeStyle:"short"});
function wall(now) {
  return new Date(now+japan);
}
function scheduledTime(date,time) {
  const [hour,minute]=time.split(":").map(Number);
  return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),hour,minute)-japan;
}
export function nextWeekday(now,time) {
  for (let i=0;i<8;i++) {
    const date=wall(now+i*day), weekday=date.getUTCDay(), timeAt=scheduledTime(date,time);
    if (weekday>=1 && weekday<=5 && timeAt>now) return timeAt;
  }
}
export function recentWeekday(now,time) {
  for (let i=0;i<8;i++) {
    const date=wall(now-i*day), weekday=date.getUTCDay(), timeAt=scheduledTime(date,time);
    if (weekday>=1 && weekday<=5 && timeAt<=now) return timeAt;
  }
}
function endOfMonth(now,time) {
  const date=wall(now);
  let target=scheduledTime(new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)),time);
  if (target<=now) target=scheduledTime(new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+2,0)),time);
  return target;
}
function explicitDate(source,now) {
  if (source==="今日") return wall(now);
  if (source==="明日") return wall(now+day);
  if (source==="明後日") return wall(now+2*day);
  const iso=source.replace(/\//g,"-");
  const parsed=new Date(iso+"T00:00:00Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10)!==iso)
    throw new HubError(400,"カレンダーにある日付を指定してください。");
  return parsed;
}
export function parseReservation(raw,now=Date.now()) {
  const text=typeof raw==="string" ? raw.trim().normalize("NFKC") : "";
  if (!text || text.length>500) throw new HubError(400,"日時と依頼を500文字以内で入力してください。");
  const input=text.match(/^(毎週[日月火水木金土]曜(?:日)?|[日月火水木金土]曜(?:日)?|毎?平日|毎月末|毎月月末|月末|今日|明日|明後日|\d{4}[-/]\d{2}[-/]\d{2})\s*(?:の\s*)?(午前|午後)?\s*(\d{1,2})(?:\s*:\s*(\d{2})|時\s*(?:(\d{1,2})分|(半))?)(?:\s*(?:JST|日本時間))?\s*(?:から|に|[、,])?\s*(.+)$/u);
  if (!input) throw new HubError(400,"何日の何時に実行しますか。例は「毎週金曜17時に週報を作る」です。","schedule_time_required");
  const [,pattern,meridiem,hours,minutes1,minutes2,half,ask]=input;
  let hour=Number(hours);
  if ((meridiem && (hour<1 || hour>12)) || hour>23) throw new HubError(400,"実行する時刻を確認してください。");
  if (meridiem) hour=hour%12+(meridiem==="午後" ? 12 : 0);
  const minute=Number(minutes1 ?? minutes2 ?? (half ? 30 : 0));
  if (minute>59 || /^(夕方|午前中|午後|ごろ|頃)/u.test(ask)) throw new HubError(400,"開始時刻を分まで指定してください。","schedule_time_required");
  const time=String(hour).padStart(2,"0")+":"+String(minute).padStart(2,"0");
  const prefix=pattern.replace(/^毎週/,"");
  const weekday=names.indexOf(prefix[0]);
  let frequency="once", next;
  if (prefix.endsWith("曜") || prefix.endsWith("曜日")) {
    frequency=pattern.startsWith("毎週") ? "weekly" : "once";
    const current=wall(now), delta=(weekday-current.getUTCDay()+7)%7;
    next=scheduledTime(wall(now+delta*day),time);
    if (next<=now) next+=7*day;
  } else if (pattern.endsWith("平日")) {
    frequency="weekdays";
    next=nextWeekday(now,time);
  } else if (pattern.endsWith("月末")) {
    frequency="monthly";
    next=endOfMonth(now,time);
  } else next=scheduledTime(explicitDate(pattern,now),time);
  if (next<=now) throw new HubError(400,"これから先の日時を指定してください。");
  const prompt=ask.replace(/^\s*(?:に|、)\s*/,"").trim();
  if (prompt.length<2) throw new HubError(400,"予約する依頼の内容を入力してください。");
  return {ask:prompt,frequency,weekday:weekday<0 ? 1 : weekday,time,nextRun:next,timezone:"Asia/Tokyo",display:clock.format(next)};
}

export function reservationPlans(hub,personal) {
  const {db}=hub;
  function preview(actor,input,now=Date.now()) {
    const person=activeMember(db,actor), plan=parseReservation(input.text,now);
    const requestedTemplate=plan.ask.match(/「([^」]{1,80})」(?:の個人手順|の手順|という手順)(?:で|を使って)/u)?.[1];
    const requestedLibrary=plan.ask.match(/(?:資料置き場(?:の)?|フォルダー(?:の)?)「([^」]{1,100})」(?:の資料)?(?:を使って|を使い|から)/u)?.[1];
    const templates=db.prepare("SELECT * FROM personal_templates WHERE actor=? AND (team IS NULL OR team=?)").all(actor,person.team);
    const template=templates.find(item=>input.templateId ? item.id===input.templateId : item.name.normalize("NFKC")===requestedTemplate);
    if ((input.templateId || requestedTemplate) && (!template || requestedTemplate && template.name.normalize("NFKC")!==requestedTemplate))
      throw new HubError(404,"この所属で利用できる個人手順を選び直してください。");
    if (template?.recipe) throw new HubError(400,"CSVの個人手順では定期実行の画面から次回の資料を登録してください。");
    if (input.libraries!==undefined && !Array.isArray(input.libraries)) throw new HubError(400,"資料置き場を確認してください。");
    let libraryIds=input.libraries ?? [];
    if (requestedLibrary) {
      const named=listLibraries(person,{db}).filter(folder=>folder.name.normalize("NFKC")===requestedLibrary && (!libraryIds.length || libraryIds.includes(folder.id)));
      if (named.length!==1) throw new HubError(409,"予約に使う資料置き場を一つ指定してください。");
      libraryIds=libraryIds.length ? libraryIds : [named[0].id];
    }
    const libraries=libraryIds.length ? librarySelection(person,libraryIds,db) : [];
    const report=/週報|月報|月次報告/u.test(plan.ask);
    if (template && libraries.length) throw new HubError(400,"個人手順または資料置き場のどちらかを選んでください。");
    const kind=template?.kind ?? (libraries.length ? "assistant" : report ? "weekly" : "general");
    const ask=template?.ask ?? (requestedLibrary ? plan.ask.replace(/(?:資料置き場(?:の)?|フォルダー(?:の)?)「[^」]+」(?:の資料)?(?:を使って|を使い|から)\s*/u,"").trim() : plan.ask);
    if (!ask) throw new HubError(400,"資料を使って行う依頼内容を入力してください。");
    const windowDays=/月報|月次報告/u.test(plan.ask) || (report && plan.frequency==="monthly") ? 30 : 7;
    const details={ ...plan, ask, kind, template:template && {id:template.id,name:template.name}, outputFormat:template?.output_format,
      libraries, report:report && kind==="weekly", windowDays };
    const token=createHash("sha256").update(JSON.stringify([actor,person.revision,details])).digest("hex");
    return {...details,token};
  }
  return { preview, confirm(actor,input,now=Date.now()) {
    const plan=preview(actor,input,now);
    if (plan.token!==input.token) throw new HubError(409,"予約時刻、手順、または資料が変わりました。プレビューを更新してください。");
    const libraries=plan.libraries.map(item=>item.id), key="plan-"+plan.token;
    if (plan.frequency==="once") {
      const id=hub.create(actor,{company:activeMember(db,actor).company,kind:plan.kind,ask:plan.ask,
        scheduled_at:plan.nextRun,...(libraries.length && {library_ids:libraries}),
        ...(plan.outputFormat && {output_format:plan.outputFormat})},key);
      return {job:id,nextRun:plan.nextRun};
    }
    const repetition=plan.frequency==="weekdays" ? "平日" : plan.frequency==="monthly" ? "月末" : "毎週"+names[plan.weekday]+"曜";
    const id=personal.schedule(actor,{name:plan.ask.slice(0,62)+"（"+repetition+" "+plan.time+"）",
      ask:plan.ask,kind:plan.kind,frequency:plan.frequency,weekday:plan.weekday,time:plan.time,window_days:plan.windowDays,
      ...(plan.template && {template_id:plan.template.id}), expected_at:plan.nextRun, planned_libraries:libraries,
      source_kind:plan.report ? "all" : "plan"},now,true).id;
    return {schedule:id,nextRun:plan.nextRun};
  }};
}
