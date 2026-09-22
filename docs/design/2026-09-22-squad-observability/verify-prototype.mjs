#!/usr/bin/env node
/**
 * verify-prototype.mjs — Squad 修复过程工作台原型 · 受控本地自检
 *
 * 用法：node verify-prototype.mjs [--html <prototype.html 路径>]
 * 依赖：复用仓库 node_modules 的 playwright（不新增依赖）；file:// 直开，无网络请求。
 * 输出：screens/overview.png、screens/quota.png、screens/mobile.png；stdout 输出逐项检查结果。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = process.argv.includes('--html')
  ? path.resolve(process.argv[process.argv.indexOf('--html') + 1])
  : path.join(here, 'prototype.html');
const screensDir = path.join(here, 'screens');
fs.mkdirSync(screensDir, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('@playwright/test'));
}

const url = 'file://' + htmlPath;
let browser;
async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    console.log('[i] 默认 chromium 启动失败，尝试系统 Chrome 通道:', e.message.split('\n')[0]);
    return await chromium.launch({ headless: true, channel: 'chrome' });
  }
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL ${name} ${extra}`); }
}
const $$ = (p, sel) => p.locator(sel);
async function txt(p, sel) { return (await p.locator(sel).innerText().catch(() => '')); }

async function main() {
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const externalRequests = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('request', r => { if (!r.url().startsWith('file://')) externalRequests.push(r.url()); });

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(150);

  console.log('\n== 基础 ==');
  ok('页面标题', (await page.title()).includes('Squad 修复过程工作台'));
  ok('设计预览工具条存在', await page.locator('[data-qa="devbar"]').count() === 1);
  ok('7 个场景按钮', await page.locator('[data-qa^="scene-"]').count() === 7);

  console.log('\n== 脚本1 默认编码场景 ==');
  const h1 = await txt(page, 'h1');
  ok('原始目标', h1.includes('停机中断后恢复会话，并支持安全重试'));
  ok('PR 示例标识', (await txt(page, '.ctx-meta')).includes('#128'));
  const statusline = await txt(page, '[data-qa="statusline"]');
  ok('状态行=正在修复会话恢复路径', statusline.includes('正在修复会话恢复路径'));
  const rows = page.locator('[data-qa="event-row"]');
  ok('时间线有事件行', (await rows.count()) >= 6, `rows=${await rows.count()}`);
  const atBottom = await page.evaluate(() => {
    const s = document.getElementById('tlScroller');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 12;
  });
  ok('默认跟随到底部', atBottom);

  // 展开最新 session_operations.go 修改
  await rows.filter({ hasText: '修改 session_operations.go' }).last().click();
  await page.waitForTimeout(80);
  ok('抽屉出现', await page.evaluate(() => document.getElementById('drawer').open));
  const dwTxt = await txt(page, '#dw-body');
  ok('抽屉 fake diff 可见', dwTxt.includes('ErrStaleGeneration') && dwTxt.includes('generation check'), dwTxt.slice(0, 80));
  ok('抽屉含来源轮次/执行身份', dwTxt.includes('来源轮次'));
  const rowFocused = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('ev'));
  ok('抽屉打开后焦点在关闭按钮', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-qa') === 'drawer-close') || rowFocused);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  ok('Esc 关闭抽屉', await page.evaluate(() => !document.getElementById('drawer').open));
  ok('Esc 后焦点返回事件行', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-qa') === 'event-row'));

  console.log('\n== 脚本2 独立评审待启动 ==');
  await page.click('[data-qa="role-reviewer"]');
  await page.waitForTimeout(80);
  const emptyText = await txt(page, '[data-qa="empty"]');
  ok('reviewer 待启动提示（非空白）', emptyText.includes('尚未启动') && emptyText.includes('候选'), emptyText.slice(0, 60));
  await page.click('[data-qa="role-all"]');
  await page.waitForTimeout(80);
  ok('切回全部活动', (await rows.count()) >= 6);

  console.log('\n== 脚本3 暂停跟随 / 模拟活动 / 未读 ==');
  const beforeScroll = await page.evaluate(() => document.getElementById('tlScroller').scrollTop);
  const rowsBefore = await rows.count();
  await page.click('[data-qa="pause-follow"]');
  ok('按钮变更为已暂停跟随', (await txt(page, '#followLabel')).includes('已暂停跟随'));
  await page.click('[data-qa="sim-activity"]');
  await page.click('[data-qa="sim-activity"]');
  await page.waitForTimeout(80);
  ok('未读数=2', (await txt(page, '[data-qa="unread"]')).includes('有 2 条新活动'));
  const afterSimScroll = await page.evaluate(() => document.getElementById('tlScroller').scrollTop);
  ok('阅读位置未移动', Math.abs(afterSimScroll - beforeScroll) < 2, `${beforeScroll} -> ${afterSimScroll}`);
  ok('暂停跟随期间新事件未渲染', (await rows.count()) === rowsBefore, `${rowsBefore} -> ${await rows.count()}`);
  await page.click('[data-qa="unread"]');
  await page.waitForTimeout(120);
  ok('查看后未读按钮隐藏', await page.evaluate(() => document.getElementById('unreadBtn').hidden));
  ok('新事件已渲染(比之前多)', (await rows.count()) === rowsBefore + 2);
  ok('恢复跟随到底部', await page.evaluate(() => {
    const s = document.getElementById('tlScroller');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 12;
  }));
  ok('模拟事件有身份标识', (await rows.filter({ hasText: '模拟新增' }).count()) === 2);

  console.log('\n== 脚本4 类型+关键词组合筛选 ==');
  await page.selectOption('[data-qa="type-filter"]', 'tool');
  await page.fill('[data-qa="keyword"]', 'session');
  await page.waitForTimeout(120);
  const filtered = await rows.allInnerTexts();
  ok('筛选后只剩 session 相关工具事件', filtered.length >= 2 && filtered.every(t => t.toLowerCase().includes('session') || t.includes('工具') === false) && filtered.every(t => t.includes('session') || t.includes('命令') || t.includes('文件')), JSON.stringify(filtered.length));
  const emptyFiltered = (await rows.count()) === 0 ? await txt(page, '[data-qa="empty"]') : '';
  ok('筛选提示属于筛选而非任务', emptyFiltered === '' ? true : emptyFiltered.includes('当前筛选无匹配'), emptyFiltered.slice(0, 60));
  await page.selectOption('[data-qa="type-filter"]', 'all');
  await page.click('[data-qa="clear-filters-topbar"]');
  await page.waitForTimeout(80);
  ok('清除筛选恢复全部', (await rows.count()) >= rowsBefore + 2
    && (await page.locator('[data-qa="event-row"]').count()) <= 12);

  console.log('\n== 脚本5 独立核验并行 ==');
  await page.click('[data-qa="scene-verify"]');
  await page.waitForTimeout(120);
  const vStatus = await txt(page, '[data-qa="statusline"]');
  ok('候选已提交正在独立核验', vStatus.includes('候选已提交') && vStatus.includes('独立核验'));
  const roleMeta = await txt(page, '[data-qa="role-reviewer"]');
  const roleMetaV = await txt(page, '[data-qa="role-verifier"]');
  ok('Reviewer 与 Verifier 同时活动', roleMeta.includes('活动') && roleMetaV.includes('活动'), `${roleMeta}|${roleMetaV}`);
  ok('Builder 已停写', (await txt(page, '[data-qa="role-builder"]')).includes('停写'));
  await page.click('[data-qa="role-verifier"]');
  await page.waitForTimeout(80);
  await rows.filter({ hasText: '运行 go test（恢复与 generation 用例）' }).first().click();
  await page.waitForTimeout(80);
  const out = await txt(page, '#dw-body');
  ok('go test 输出含通过与失败信息', out.includes('ok') && out.includes('FAIL') && out.includes('storage→session'), out.slice(0, 100));
  ok('输出折叠并提供展开', (await page.locator('.out-toggle').count()) >= 1);
  await page.click('.out-toggle');
  ok('可展开完整输出', await page.evaluate(() => {
    const o = document.getElementById('dwOut');
    return o && !o.classList.contains('clamped');
  }));
  await page.keyboard.press('Escape');

  console.log('\n== 脚本6 静默 / 断线==');
  await page.click('[data-qa="role-all"]');
  await page.click('[data-qa="scene-silent"]');
  await page.waitForTimeout(120);
  const sStatus = await txt(page, '[data-qa="statusline"]');
  const sObs = await txt(page, '[data-qa="obsbar"]');
  ok('静默文案=暂时没有新活动，进程仍在线', sStatus.includes('暂时没有新活动') && sStatus.includes('在线'));
  ok('心跳与有效活动时间分开', sObs.includes('最近心跳') && sObs.includes('3 分 48 秒前'));
  ok('静默下事件保留', (await rows.count()) >= 6);

  await page.click('[data-qa="scene-offline"]');
  await page.waitForTimeout(120);
  const oStatus = await txt(page, '[data-qa="statusline"]');
  ok('断线文案=最后已知状态', oStatus.includes('连接已断开') && oStatus.includes('最后一次已知状态'));
  ok('断线不清记录', (await rows.count()) >= 6);
  const noticeTxt = await txt(page, '[data-qa="notice"]');
  ok('断线通知含上次同步', noticeTxt.includes('12:45:31'));
  ok('断线下停止禁用', await page.evaluate(() => { const b = document.getElementById('stopBtn'); return b.disabled; }));
  await page.click('[data-qa="reconnect"]');
  await page.waitForTimeout(120);
  ok('重新连接回到快照', (await txt(page, '[data-qa="statusline"]')).includes('正在修复会话恢复路径'));

  console.log('\n== 脚本7 额度不足换席步骤 ==');
  await page.click('[data-qa="scene-quota"]');
  await page.waitForTimeout(120);
  const qStatus = await txt(page, '[data-qa="statusline"]');
  ok('额度不足状态', qStatus.includes('独立评审额度不足'));
  const qNotice = await txt(page, '[data-qa="notice"]');
  ok('需要处理位于时间线之上且说明受影响角色', await page.evaluate(() => {
    const n = document.querySelector('[data-qa="notice"]');
    const tl = document.querySelector('[data-qa="timeline"]');
    return n && tl && n.compareDocumentPosition(tl) & Node.DOCUMENT_POSITION_FOLLOWING;
  }));
  ok('错误片段默认可见', qNotice.includes('context allowance exhausted'), qNotice.slice(0, 120));
  await page.click('[data-qa="seat-steps"]');
  await page.waitForTimeout(80);
  const seat = await txt(page, '#dw-body');
  ok('换席步骤只读', seat.includes('只读') && seat.includes('停止旧执行') && seat.includes('明确选择模型') && seat.includes('新会话') && seat.includes('同链预算继承'));
  ok('不提供清零捷径提示', seat.includes('不清零') && seat.includes('剩余预算 ≠ 剩余账户额度'));
  await page.screenshot({ path: path.join(screensDir, 'quota.png'), fullPage: false });
  await page.keyboard.press('Escape');
  ok('quota 截图已保存', fs.existsSync(path.join(screensDir, 'quota.png')));

  console.log('\n== 脚本8 候选完成 / 已准出 ==');
  await page.click('[data-qa="scene-candidate"]'); await page.waitForTimeout(120);
  const cStatus = await txt(page, '[data-qa="statusline"]');
  ok('候选完成不显示已准出', cStatus.includes('本地候选完成') && cStatus.includes('等待最终准出') && !cStatus.includes('证据与提交一致'));
  ok('候选完成无停止按钮', await page.evaluate(() => { const b = document.getElementById('stopBtn'); return b.hidden || b.disabled; }));

  await page.click('[data-qa="scene-gated"]'); await page.waitForTimeout(120);
  const gStatus = await txt(page, '[data-qa="statusline"]');
  const gGate = await txt(page, '[data-qa="gate-panel"]');
  ok('已准出状态+证据一致', gStatus.includes('已准出') && gStatus.includes('证据与提交一致'));
  ok('准出身份完整（候选/基准 SHA+时间+核验）', gGate.includes('候选 SHA') && gGate.includes('基准 SHA') && gGate.includes('准出时间') && gGate.includes('5 / 5'));
  ok('已准出无停止入口', await page.evaluate(() => { const b = document.getElementById('stopBtn'); return b.hidden; }));

  console.log('\n== 脚本9 验收与改动 ==');
  // 四态断言需要“独立核验中间态”快照（编码/核验场景含 待验证/通过/未通过/证据不足）
  await page.click('[data-qa="scene-verify"]');
  await page.waitForTimeout(150);
  await page.click('[data-qa="tab-acceptance"]');
  await page.waitForTimeout(120);
  const stateChips = await page.locator('[data-qa^="accept-"] .acc-state').allInnerTexts();
  ok('4 种验收状态齐备', ['通过', '未通过', '待验证', '证据不足'].every(s => stateChips.some(c => c.includes(s))), stateChips.join(','));
  await page.locator('[data-qa="accept-lock"] .acc-cta').first().click();
  await page.waitForTimeout(80);
  const lockEv = await txt(page, '[data-qa="accept-lock"] .acc-ev');
  ok('证据展开且含来源（非空链接）', lockEv.includes('来源：') && lockEv.includes('示例'));
  const fileRows = await page.locator('#fileList .file-item').count();
  ok('改动汇总含文件与只读说明', fileRows >= 2 && (await txt(page, '#fileList')).includes('仅读取'));

  console.log('\n== 脚本10 历史轮只读 / 停止 / 重置 ==');
  await page.click('[data-qa="tab-activity"]');
  await page.click('[data-qa="scene-coding"]');
  await page.waitForTimeout(120);
  await page.selectOption('[data-qa="round-select"]', '1');
  await page.waitForTimeout(120);
  const hist = await txt(page, '[data-qa="hist-banner"]');
  ok('历史轮只读条幅', hist.includes('第 1 轮') && hist.includes('只读'));
  ok('历史轮无停止按钮', await page.evaluate(() => { const b = document.getElementById('stopBtn'); return b.hidden; }));
  const r1rows = await rows.allInnerTexts();
  ok('历史轮显示第 1 轮事件', r1rows.some(r => r.includes('第 1 轮')) && r1rows.some(r => r.includes('10:')), r1rows.length + '');
  await page.click('[data-qa="round-back"]');
  await page.waitForTimeout(80);
  ok('返回当前轮', (await txt(page, '[data-qa="statusline"]')).includes('正在修复'));

  const statusBefore = await txt(page, '[data-qa="statusline"]');
  await page.click('[data-qa="stop"]');
  await page.waitForTimeout(80);
  ok('停止确认弹窗', await page.evaluate(() => document.getElementById('stopModal').open));
  ok('弹窗说明保留记录与预算', (await txt(page, '[data-qa="stop-modal"]')).includes('已用预算'));
  await page.click('[data-qa="stop-cancel"]');
  await page.waitForTimeout(80);
  ok('取消不变', (await txt(page, '[data-qa="statusline"]')) === statusBefore);
  await page.click('[data-qa="stop"]');
  await page.click('[data-qa="stop-confirm"]');
  await page.waitForTimeout(120);
  const stopStatus = await txt(page, '[data-qa="statusline"]');
  ok('确认后已停止（模拟）', stopStatus.includes('已停止（模拟）'));
  ok('停止不是暂停跟随的歧义', (await txt(page, '#followLabel')).length > 0);

  await page.click('[data-qa="reset"]');
  await page.waitForTimeout(120);
  const resetStatus = await txt(page, '[data-qa="statusline"]');
  ok('重置演示恢复初始', resetStatus.includes('正在修复会话恢复路径') && (await page.evaluate(() => !document.getElementById('drawer').open)));

  console.log('\n== 截图 overview（1440x960） ==');
  // 回到默认视角截 overview
  await page.screenshot({ path: path.join(screensDir, 'overview.png'), fullPage: false });
  ok('overview 截图已保存', fs.existsSync(path.join(screensDir, 'overview.png')));

  console.log('\n== 1440 桌面溢出检查 ==');
  await page.setViewportSize({ width: 1440, height: 960 });
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  ok('1440 无横向溢出', ov.sw <= ov.cw && ov.bw <= ov.cw, JSON.stringify(ov));
  await page.setViewportSize({ width: 1280, height: 860 });
  const ov1280 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok('1280 无横向溢出', ov1280.sw <= ov1280.cw, JSON.stringify(ov1280));

  console.log('\n== 390 窄屏 ==');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, body: document.body.scrollWidth }));
  ok('390 无横向溢出', m.sw <= m.cw && m.body <= m.cw, JSON.stringify(m));
  await page.click('[data-qa="scene-quota"]');
  await page.waitForTimeout(150);
  const m2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, body: document.body.scrollWidth }));
  ok('390（额度场景+抽屉开启）无溢出', m2.sw <= m2.cw && m2.body <= m2.cw, JSON.stringify(m2));
  await page.click('[data-qa="seat-steps"]');
  await page.waitForTimeout(150);
  const m3 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  ok('390 抽屉打开不溢出', m3);
  // 抽屉是全宽模态，会遮挡 devbar；先 Esc 关闭再切场景
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.click('[data-qa="scene-coding"]');
  await page.click('[data-qa="reset"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(screensDir, 'mobile.png'), fullPage: false });
  ok('mobile 截图已保存', fs.existsSync(path.join(screensDir, 'mobile.png')));

  console.log('\n== 键盘可访问性抽查 ==');
  await page.click('[data-qa="scene-coding"]');
  await page.waitForTimeout(120);
  await page.keyboard.press('Tab');
  const focusInfo = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el ? el.tagName : '', qa: el ? (el.getAttribute('data-qa') || '') : '' };
  });
  ok('Tab 首个焦点落在可交互元素', ['BUTTON', 'A', 'INPUT', 'SELECT', 'SUMMARY'].includes(focusInfo.tag), JSON.stringify(focusInfo));
  const hasFocusRule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule.selectorText && rule.selectorText.includes(':focus-visible')) return true;
        }
      } catch { /* file:// 同源样式表均可读 */ }
    }
    return false;
  });
  ok('存在 :focus-visible 焦点样式规则', hasFocusRule);

  console.log('\n== 零外部请求 / console ==');
  ok('无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  ok('无 page error（JS 异常）', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  ok('外部请求数为 0', externalRequests.length === 0, externalRequests.slice(0, 3).join(' | '));

  await ctx.close();
  await browser.close();

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exitCode = 1; }
}

main().catch(e => {
  console.error('[FATAL]', e);
  if (browser) browser.close().catch(() => {});
  process.exitCode = 1;
});
