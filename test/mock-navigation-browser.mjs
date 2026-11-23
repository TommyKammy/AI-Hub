// Read-only comparison of the development server and the approved employee UI.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { adminCredentials } from "./admin-credentials.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const origin = process.env.EMPLOYEE_ORIGIN || "http://127.0.0.1:18731";
const admin = process.env.ADMIN_ORIGIN || "http://127.0.0.1:18733";
const output = process.env.PARITY_SCREENSHOTS;
const mock = new URL("../ai-hub-home-mockup.html", import.meta.url).href;
const browser = await chromium.launch({channel:"chrome"});
const labels = async locator => (await locator.allTextContents()).map(name => name.trim());
// The links and buttons implement different operations, but share the mock's pill design.
const tabStyles = controls => controls.evaluateAll(nodes => nodes.map(node => {
  const style = getComputedStyle(node);
  const {width,height} = node.getBoundingClientRect();
  return {
    label:node.textContent.trim(), radius:style.borderRadius, border:style.borderTop,
    background:style.backgroundColor, color:style.color, padding:style.padding,
    width, height,
  };
}));
async function catalogSearchLayout(input, firstTab) {
  const field = await input.boundingBox();
  const tab = await firstTab.boundingBox();
  const main = await input.page().locator("main").boundingBox();
  return {x:Math.round(field.x-main.x),y:Math.round(field.y-main.y),width:field.width,height:field.height,
    leftOffset:tab.x-field.x,gap:tab.y-field.y-field.height};
}
if (output) await mkdir(output, {recursive:true});
try {
  const reference = await browser.newPage({reducedMotion:"reduce"});
  await reference.goto(mock);
  const expected = await labels(reference.locator("#workspaceNav button"));
  const sections = ["home","jobs","catalog","work"];
  assert.equal(expected.length, sections.length);
  for (const width of [1440,390]) {
    const page = await browser.newPage({viewport:{width,height:900},reducedMotion:"reduce"});
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    for (const [index,section] of sections.entries()) {
      if (width === 390) await page.locator("#workspaceMenu").click();
      const nav = page.locator("#workspaceNav");
      assert.deepEqual(await labels(nav.locator("a")),expected);
      await nav.getByRole("link",{name:expected[index],exact:true}).click();
      const main = page.locator("#main");
      const firstControl = {home:"#request textarea",jobs:"#jobSearch",catalog:"#catalogSearch",work:"#workDocSearch"}[section];
      await main.locator(firstControl).first().waitFor();
      assert.equal(await nav.locator('[aria-current="page"]').innerText(),expected[index]);
      assert.equal(await main.getByRole("heading",{name:expected[index],exact:true}).count(),0);
      if (section === "work") assert.deepEqual(await labels(main.locator("nav a")),["社内資料","案件・引き継ぎ","Hermesの記憶","承認・登録"]);
      if (section !== "home") {
        // Select the reference page from its desktop menu, then measure both at the test width.
        await reference.setViewportSize({width:1440,height:900});
        await reference.locator('#workspaceNav [data-nav="'+section+'"]').click();
        await reference.setViewportSize({width,height:900});
        const mockTabs = reference.locator("#secondary .subtabs button");
        const realTabs = main.locator(".request-filters, .workspace-subnav").locator(":scope > :is(button,a)");
        await mockTabs.first().waitFor();
        await realTabs.first().waitFor();
        await reference.mouse.move(0,0);
        await page.mouse.move(0,0);
        assert.deepEqual(await tabStyles(realTabs),await tabStyles(mockTabs),section+" "+width+"px");
        if (section === "catalog") {
          assert.deepEqual(await catalogSearchLayout(page.locator("#catalogSearch"),realTabs.first()),
            await catalogSearchLayout(reference.locator("#templateQuery"),mockTabs.first()),"検索欄と提供元タブ "+width+"px");
        }
        const switched = realTabs.nth(1);
        await switched.click();
        await mockTabs.nth(1).click();
        await main.locator(".request-filters, .workspace-subnav").locator(":scope > :nth-child(2):is([aria-current],[aria-pressed=true])").waitFor();
        await page.mouse.move(0,0);
        await reference.mouse.move(0,0);
        assert.deepEqual(await tabStyles(realTabs),await tabStyles(mockTabs),section+" switch "+width+"px");
        await realTabs.first().click();
        await mockTabs.first().click();
        await main.locator(firstControl).first().waitFor();
        await page.mouse.move(0,0);
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
      if (output) await page.screenshot({path:join(output,width+"-"+section+".png")});
    }
    await page.goto(origin+"/#skills");
    await page.locator("#catalogSearch").waitFor();
    assert.equal(await page.locator("#workspaceNav [aria-current]").innerText(),"手順を探す");
    await page.goto(origin+"/#planning");
    await page.locator("#reservationPlanner").waitFor();
    assert.equal(await page.locator("#workspaceNav [aria-current]").innerText(),"依頼一覧");
    assert.deepEqual(errors,[]);
    await page.close();
  }
  for (const [user,count] of [["aoki",13],["mori",5]]) {
    const page = await browser.newPage({httpCredentials:adminCredentials(admin,user)});
    await page.goto(admin+"/admin.html");
    await page.locator("#dashboardRows .ua-month").waitFor();
    assert.deepEqual(await labels(page.locator("#adminWorkspaceNav a")),expected);
    assert.equal(await page.locator("#adminAreas a:visible").count(),count);
    assert.equal(await page.locator("#dashboard").getByRole("heading",{name:"ダッシュボード"}).count(),0);
    const links=page.locator("#adminAreas a:visible");
    const areas=await links.evaluateAll(nodes=>nodes.map(node=>({id:node.hash.substring(1),label:node.textContent.trim()})));
    const common=["ダッシュボード","アナリティクス","グループと権限","監査ログ","モデル利用記録"];
    const all=["ダッシュボード","アナリティクス","モデル設定","グループと権限","手順の公開","ユーザアカウント","Hermes 実行照合","監査ログ","モデル利用記録","手順の品質","資料接続","利用ポリシー","案件管理"];
    assert.deepEqual(areas.map(area=>area.label),count===13 ? all : common);
    for (const {id,label} of areas) {
      await page.locator("#adminAreas").getByRole("link",{name:label,exact:true}).click();
      await page.locator("section#"+id+":visible").waitFor();
      assert.equal(await page.locator("#adminCrumb").innerText(),label);
      assert.equal(await page.locator("[data-area]:visible").count(),1);
      if (output && ["dashboard","models-heading","groups","memberships"].includes(id))
        await page.screenshot({path:join(output,user+"-"+id+".png")});
    }
    await page.close();
  }
  console.log("1440px / 390px · 社員4画面・旧URL2種・管理者13項目・閲覧専用5項目");
} finally {
  await browser.close();
}
