function mentionAtCaret(field) {
  const end = field.selectionStart;
  if (end !== field.selectionEnd) return null;
  const before = field.value.slice(0, end);
  const match = /(?<![A-Za-z0-9_.+-])@([^@＠「」\r\n。！？]{0,200})$|＠([^@＠「」\r\n。！？]{0,200})$/u.exec(before);
  if (!match) return null;
  return {start:match.index, end, query:(match[1] ?? match[2]).trim()};
}

export function installRequestDocumentPicker(form, api, choose, showDisabled) {
  const field = form.elements.ask;
  const panel = form.querySelector("[data-document-picker]");
  const options = panel.querySelector('[role="listbox"]');
  const status = panel.querySelector('[role="status"]');
  let timer, generation=0, documents=[], index=-1, mention;

  function close() {
    clearTimeout(timer);
    generation++;
    mention = null;
    index = -1;
    documents = [];
    panel.hidden = true;
    options.hidden = true;
    options.replaceChildren();
    status.textContent = "";
    field.removeAttribute("aria-activedescendant");
  }

  function search() {
    close();
    mention = mentionAtCaret(field);
    if (!mention || document.activeElement!==field) return;
    const value=field.value, {query}=mention, request=generation;
    const current=()=>request===generation && field.isConnected && document.activeElement===field &&
      field.value===value && field.selectionStart===mention.end && field.selectionEnd===mention.end;
    timer = setTimeout(async () => {
      if (!current()) return;
      try {
        const params = new URLSearchParams({q:query,name_only:"1"});
        const result = await api("/api/workspace/documents?"+params);
        if (!current()) return;
        documents = result.documents;
        panel.hidden = false;
        options.hidden = !documents.length;
        options.replaceChildren(...documents.map((doc, i) => {
          const item=document.createElement("li"), name=document.createElement("strong"), folder=document.createElement("small");
          item.id=options.id+"-"+i;
          item.dataset.index=i;
          item.setAttribute("role","option");
          item.setAttribute("aria-selected","false");
          name.textContent=doc.name;
          folder.textContent=doc.folder+" ・ "+doc.scope;
          item.append(name,folder);
          return item;
        }));
        status.textContent=documents.length ? (documents.length===20 ? "先頭20件を表示しています。資料名を入力して絞り込めます。" :
          documents.length+"件の資料候補があります。") : "条件に合う資料はありません。";
      } catch (error) {
        if (current() && !showDisabled(error)) {
          panel.hidden = false;
          status.textContent=error.message;
        }
      }
    }, 120);
  }

  function select(i) {
    const doc = documents[i], token=mentionAtCaret(field);
    if (!doc || !mention || token?.start!==mention.start || token.end!==mention.end || token.query!==mention.query) {
      close();
      return;
    }
    const prefix=field.value.slice(0, token.start), suffix=field.value.slice(token.end);
    const reference="「"+doc.name+"」";
    const replacement=prefix.trim() || suffix.trim() ? reference : reference+"について教えてください。";
    const ask=prefix+replacement+suffix;
    if (ask.length>field.maxLength) {
      status.textContent="資料名を入れるには依頼内容を短くしてください。";
      return;
    }
    close();
    choose(doc,ask,prefix.length+replacement.length);
  }

  field.addEventListener("input", event => { if (!event.isComposing) search(); });
  field.addEventListener("compositionstart", close);
  field.addEventListener("compositionend", search);
  field.addEventListener("blur", close);
  field.addEventListener("click", close);
  field.addEventListener("keydown", event => {
    if (!mention || event.isComposing || event.keyCode===229) return;
    const {key}=event;
    if (key==="Escape") {
      event.preventDefault();
      close();
    } else if (documents.length && (key==="ArrowDown" || key==="ArrowUp") &&
               !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      options.children[index]?.setAttribute("aria-selected","false");
      index=index<0 ? (key==="ArrowDown" ? 0 : documents.length-1) :
        (index+documents.length+(key==="ArrowDown" ? 1 : -1))%documents.length;
      const item=options.children[index];
      item.setAttribute("aria-selected","true");
      field.setAttribute("aria-activedescendant",item.id);
      item.scrollIntoView({block:"nearest"});
    } else if (documents.length && key==="Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      select(Math.max(index,0));
    } else if (["ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(key)) close();
  });
  panel.addEventListener("mousedown", event => {
    if (event.target.closest('[role="option"]')) event.preventDefault();
  });
  panel.addEventListener("click", event => {
    const item=event.target.closest('[role="option"]');
    if (item) select(Number(item.dataset.index));
  });
}
