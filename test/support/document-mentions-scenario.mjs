import assert from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";

// Uses the isolated WP03 Hub, employee sessions and Hermes gateway.
export async function verifyDocumentMentions({browser, sato, tanaka, admin, auth, libraryRoot, db}) {
  const folder="指定資料の検証", name="精算検証票.md", secretName="精算検証票・田中専用.md";
  const shared="shared/"+folder, mine="users/sato/"+folder, peer="users/tanaka/"+folder;
  const selectedText="第7条 精算の取消には青色の確認票が必要。";
  for (const [id,doc,body] of [
    [shared,name,selectedText], [mine,name,"第4条 精算の取消には赤色の確認票が必要。"],
    [peer,secretName,"田中専用の精算資料。"],
  ]) {
    await mkdir(join(libraryRoot,id),{recursive:true});
    await writeFile(join(libraryRoot,id,doc),body);
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const other=await browser.newPage();
  const options=p=>p.locator("#requestDocumentOptions").getByRole("option");
  const typeMention=async(p,origin)=>{
    await p.goto(origin+"/#home");
    await p.getByLabel("依頼内容").fill("精算の取消に必要な資料は？ @精算検証票");
    await options(p).first().waitFor();
  };
  async function pinShared(p) {
    await typeMention(p,sato);
    const labels=await options(p).allInnerTexts();
    assert.equal(labels.length,2);
    assert.ok(labels.every(text=>text.includes(name) && text.includes(folder)));
    assert.ok(labels.some(text=>text.includes("全社員")) && labels.some(text=>text.includes("自分のみ")));
    assert.ok(labels.every(text=>!text.includes(secretName)));
    const field=p.getByLabel("依頼内容");
    await field.press("Escape");
    await options(p).first().waitFor({state:"hidden"});
    await field.fill("精算の取消に必要な資料は？ @精算検証");
    await options(p).first().waitFor();
    for(let i=0;i<=labels.length;i++) {
      await field.press("ArrowDown");
      const selected=await field.evaluate(el=>document.getElementById(el.getAttribute("aria-activedescendant"))?.textContent);
      if(selected?.includes("全社員")) break;
    }
    await field.press("Enter");
    await p.locator('[data-op="clear-document"]').waitFor();
    assert.match(await field.inputValue(),/精算の取消に必要な資料は？/);
    assert.match(await p.locator("[data-document-pin]").innerText(),/精算検証票/);
    assert.equal(await options(p).count(),0);
  }
  try {
    await typeMention(other,tanaka);
    assert.ok((await options(other).allInnerTexts()).some(label=>label.includes(secretName)));
    await pinShared(page);
    await page.getByRole("button",{name:"依頼の設定"}).click();
    const summary=page.locator(".source-preview [data-library-document-preview]");
    await summary.waitFor();
    assert.ok((await summary.innerText()).includes(name) && (await summary.innerText()).includes("全社員"));
    const preview=page.locator('[data-op="preview-request-document"]');
    await preview.click();
    await page.locator("#dialog[open]").getByText(selectedText,{exact:false}).waitFor();
    await page.keyboard.press("Escape");
    await page.locator('[data-op="clear-document"]').click();
    await page.locator('[data-op="clear-document"]').waitFor({state:"hidden"});
    await pinShared(page);
    const postJob=p=>p.waitForResponse(r=>r.request().method()==="POST" && new URL(r.url()).pathname==="/api/jobs");
    const created=postJob(page);
    await page.getByRole("button",{name:"送信",exact:true}).click();
    const response=await created;
    assert.equal(response.status(),201,await response.text());
    const input=response.request().postDataJSON();
    assert.deepEqual(input.library_ids,[shared]);
    assert.equal(input.library_document,name);
    const {id}=await response.json();
    const memo=page.locator("#memoText");
    await memo.waitFor();
    assert.match(await memo.innerText(),/青色の確認票/);
    assert.doesNotMatch(await memo.innerText(),/赤色|田中専用/);
    await memo.getByRole("button",{name:/出典\d+を開く/}).first().click();
    await page.locator("#dialog mark").waitFor();
    assert.match(await page.locator("#dialog").innerText(),/検索時の版/);
    assert.match(await page.locator("#dialog mark").innerText(),/青色の確認票/);
    const detail=await (await page.request.get(sato+"/api/jobs/"+id)).json();
    assert.deepEqual(detail.sources.filter(s=>s.library).map(s=>[s.library,s.title,s.text]),[[shared,name,selectedText]]);
    await page.keyboard.press("Escape");
    console.log("TOM-132 同名資料の識別、キーボード選択・解除、非公開候補の分離、送信前本文、回答と使用版の引用を確認");

    // One request is already scheduled when the administrator pauses this test library.
    await pinShared(page);
    const timing=page.getByLabel("実行のタイミング");
    if(!await timing.isVisible()) await page.getByRole("button",{name:"依頼の設定"}).click();
    await timing.selectOption("once");
    await page.getByLabel(/実行予定日時/).fill(new Date(Date.now()+86400000+9*3600000).toISOString().slice(0,16));
    const scheduled=postJob(page);
    await page.locator('#request [type="submit"]').click();
    const receipt=await scheduled;
    assert.equal(receipt.status(),201,await receipt.text());
    const queuedId=(await receipt.json()).id;
    await page.waitForURL("**/#job/"+queuedId);
    const draft=await browser.newPage();
    try {
      await pinShared(draft);
      const paused=await fetch(admin+"/api/admin/library-connections",{method:"POST",
        headers:{Authorization:auth,Origin:admin,"Content-Type":"application/json"},
        body:JSON.stringify({id:shared,action:"pause",base:0,reason:"指定後の閲覧権限失効を検証"})});
      assert.equal(paused.status,200,await paused.text());
      const rejected=postJob(draft);
      await draft.getByRole("button",{name:"送信",exact:true}).click();
      assert.equal((await rejected).status(),403);
      await draft.locator("#request .form-error").getByText(/参照できません/).waitFor();
      // Advance only this isolated job's due time; normal worker dispatch performs the access check.
      assert.equal(db.prepare("UPDATE jobs SET scheduled_at=? WHERE id=? AND status='scheduled'").run(Date.now()-1,queuedId).changes,1);
      await page.waitForFunction(async id=>(await (await fetch("/api/jobs/"+id)).json()).status==="source_blocked",queuedId);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts WHERE job_id=?").get(queuedId).n,0);
      assert.equal(db.prepare("SELECT memo FROM jobs WHERE id=?").get(queuedId).memo,null);
      await page.reload();
      await page.getByRole("heading",{name:"資料を参照できないため停止しました"}).waitFor();
      assert.equal(await page.locator("#memoText").count(),0);
      console.log("TOM-132 指定後の公開停止で送信を403拒否、受付済み予約も実行時に停止、Hermes送信0回");
    } finally { await draft.close(); }

    // Grant a new folder while the other employee still has the original composer open.
    const member=await (await fetch(admin+"/api/admin/memberships/tanaka",{headers:{Authorization:auth}})).json();
    const departmentLibrary="teams/"+member.team+"/異動前の確認票";
    await mkdir(join(libraryRoot,departmentLibrary),{recursive:true});
    await writeFile(join(libraryRoot,departmentLibrary,"異動前の限定票.md"),"精算の取消は旧部門の担当者が確認する。");
    const ask=other.getByLabel("依頼内容");
    await ask.fill("精算の取消について @異動前の限定票");
    await options(other).filter({hasText:"異動前の限定票.md"}).click();
    await other.getByRole("button",{name:"依頼の設定"}).click();
    await other.getByLabel("実行のタイミング").selectOption("once");
    await other.getByLabel(/実行予定日時/).fill(new Date(Date.now()+86400000+9*3600000).toISOString().slice(0,16));
    const planned=postJob(other);
    await other.locator('#request [type="submit"]').click();
    const original=await planned;
    assert.equal(original.status(),201,await original.text());
    assert.deepEqual(original.request().postDataJSON().library_ids,[departmentLibrary]);
    const pending=(await original.json()).id;
    await other.waitForURL("**/#job/"+pending);
    const moved=await fetch(admin+"/api/admin/memberships/tanaka",{method:"POST",
      headers:{Authorization:auth,Origin:admin,"Content-Type":"application/json"},
      body:JSON.stringify({base:member.revision,team:"資料指定検証の異動先",reason:"予約後の部門資料の閲覧権限失効を検証"})});
    assert.equal(moved.status,200,await moved.text());
    assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(pending).status,"membership_blocked");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts WHERE job_id=?").get(pending).n,0);
    assert.equal((await other.request.get(tanaka+"/api/jobs/"+pending)).status(),404);
    console.log("TOM-132 開いたままの画面で新しい部門資料を指定、予約後の異動で実行拒否、旧依頼の詳細は404");
  } finally { await page.close(); await other.close(); }
}
