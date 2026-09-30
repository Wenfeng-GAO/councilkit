import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ARTIFACTS = process.env.CK_ARTIFACTS_DIR;

async function maybeScreenshot(page: any, name: string): Promise<void> {
  if (!ARTIFACTS) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, name), fullPage: true });
}

test("生成完整本轮总览截图（桌面）", async ({ page }) => {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>审查结果 - 本轮总览</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --color-fg: #e7dfc6;
      --color-bg: #0a0c0e;
      --color-surface: #13151a;
      --color-border: rgba(231, 223, 198, 0.12);
      --color-muted: rgba(231, 223, 198, 0.55);
      --color-brass: #d4af37;
      --color-parchment: #e7dfc6;
      --font-command: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--color-bg);
      color: var(--color-fg);
      padding: 2rem;
      line-height: 1.6;
    }
    h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.25rem; margin: 1.5rem 0 0.75rem; }
    .ck-wb-report-meta {
      color: var(--color-muted);
      font-size: 0.875rem;
      margin-bottom: 1.5rem;
    }
    .ck-finding-list-summary {
      color: var(--color-muted);
      font-size: 0.875rem;
      margin: 1rem 0;
    }
    .ck-finding-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin: 0.85rem 0 0.7rem;
      border: 0;
      padding: 0;
    }
    .ck-finding-filter {
      appearance: none;
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-muted);
      font-family: var(--font-command);
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0.22rem 0.55rem;
      cursor: pointer;
    }
    .ck-finding-filter[aria-pressed="true"] {
      color: var(--color-parchment);
      border-color: var(--color-brass);
    }
    .ck-ledger {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      margin: 0;
      padding: 0;
    }
    .ck-ledger-row {
      min-width: 0;
      font-size: 0.82rem;
      line-height: 1.45;
    }
    .ck-finding-summary {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr) max-content;
      gap: 0.45rem 0.75rem;
      align-items: start;
      cursor: pointer;
      list-style: none;
      min-width: 0;
    }
    .ck-finding-id-sev {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .ck-finding-number {
      font-family: var(--font-command);
      font-size: 0.72rem;
      color: var(--color-brass);
    }
    .ck-finding-heading {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      min-width: 0;
    }
    .ck-ledger-title {
      color: var(--color-fg);
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .ck-finding-location {
      font-family: var(--font-command);
      font-size: 0.72rem;
      color: var(--color-muted);
    }
    .ck-finding-tags {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 0.3rem;
      justify-self: end;
    }
    .ck-finding-tags-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      justify-content: flex-end;
    }
    .ck-sev {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-family: var(--font-command);
      font-size: 0.62rem;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.1rem 0.4rem;
      border: 1px solid var(--color-border);
      white-space: nowrap;
      line-height: 1.3;
    }
    .ck-sev::before {
      content: "";
      display: inline-block;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .ck-sev-critical { color: #fca5a5; }
    .ck-sev-critical::before { background: #e11d48; }
    .ck-sev-major { color: #fdba74; }
    .ck-sev-major::before { background: #ea580c; }
    .ck-sev-minor { color: #fde047; }
    .ck-sev-minor::before { background: #eab308; }
    .ck-sev-nit { color: var(--color-muted); }
    .ck-sev-nit::before { background: rgba(255, 255, 255, 0.2); }
    .ck-ledger-status {
      font-family: var(--font-command);
      font-size: 0.62rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.1rem 0.4rem;
      border: 1px solid var(--color-border);
      white-space: normal;
      word-break: break-word;
      max-width: 20rem;
      line-height: 1.3;
    }
    .ck-ledger-open { color: #fbbf24; }
    .ck-ledger-closed { color: #4ade80; }
    .ck-ledger-regress { color: #fb7185; }
    .ck-ledger-accepted { color: var(--color-muted); }
    .ck-finding-source {
      font-family: var(--font-command);
      font-size: 0.62rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-muted);
      border: 1px solid var(--color-border);
      padding: 0.1rem 0.4rem;
      white-space: nowrap;
      line-height: 1.3;
    }
  </style>
</head>
<body>
  <article>
    <h1>审查已完成</h1>
    <p class="ck-wb-report-meta">
      <span>审查执行已完成</span>
      <span>6/6 席位已完成</span>
    </p>

    <section class="ck-finding-list">
      <h2 id="ck-ledger">问题清单</h2>
      <p class="ck-finding-list-summary">10 个问题 · 6 待处理 · 2 已解决 · 2 接受不修 · 1 致命 · 5 重大 · 2 次要 · 2 琐碎 · 6 阻塞</p>

      <fieldset class="ck-finding-filters">
        <button type="button" class="ck-finding-filter" aria-pressed="true">阻塞</button>
        <button type="button" class="ck-finding-filter" aria-pressed="false">待处理</button>
        <button type="button" class="ck-finding-filter" aria-pressed="false">已解决</button>
        <button type="button" class="ck-finding-filter" aria-pressed="false">全部</button>
      </fieldset>

      <ul class="ck-ledger">
        <!-- Finding 1: Critical -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#01</span>
                <span class="ck-sev ck-sev-critical">致命</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">SQL 注入漏洞：用户输入未经验证直接拼接到查询语句中，攻击者可执行任意 SQL 命令</span>
                <span class="ck-finding-location">新侧 L45</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-open">待处理</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">独有</span>
                </span>
              </span>
            </summary>
          </details>
        </li>

        <!-- Finding 2: Major with multiple tags -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#02</span>
                <span class="ck-sev ck-sev-major">重大</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">Resume 失败只看 ctx.Err()，不看 flightCurrent</span>
                <span class="ck-finding-location">新侧 L266-271</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-open">待处理</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">共识</span>
                </span>
              </span>
            </summary>
          </details>
        </li>

        <!-- Finding 3: Major merged -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#03</span>
                <span class="ck-sev ck-sev-major">重大</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">Resume 成功、提交 idle 遇到临时存储错误时 closeOpenedOn + markRecoveryFailed（UUID 仍在）。改用 forgetOpenedOn</span>
                <span class="ck-finding-location">新侧 L357</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-open">待处理</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">独有</span>
                  <span class="ck-finding-source">合并 2 条记录</span>
                </span>
              </span>
            </summary>
          </details>
        </li>

        <!-- Finding 4: Major with long title -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#04</span>
                <span class="ck-sev ck-sev-major">重大</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">这是一个非常非常长的问题标题，用于测试当标题很长时，右侧的标签是否能够正确对齐而不会随着标题长度的变化而水平移动，这是一个重要的布局约束条件</span>
                <span class="ck-finding-location">新侧 L456</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-regress">回归</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">共识</span>
                </span>
              </span>
            </summary>
          </details>
        </li>

        <!-- Finding 5: Major -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#05</span>
                <span class="ck-sev ck-sev-major">重大</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">fence 在 UpdateSession 回调内；commit idle 后不再复核 occupancy</span>
                <span class="ck-finding-location">新侧 L311-362</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-open">待处理</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">共识</span>
                </span>
              </span>
            </summary>
          </details>
        </li>

        <!-- Finding 6: Major, NOT in blocking filter because it's closed -->
        <li class="ck-ledger-row" style="display: none;">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#06</span>
                <span class="ck-sev ck-sev-major">重大</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">内存泄漏：事件监听器未在组件卸载时清理</span>
                <span class="ck-finding-location">新侧 L123</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-closed">已解决</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">共识</span>
                </span>
              </span>
            </summary>
          </details>
        </li>
      </ul>
    </section>
  </article>
</body>
</html>
  `;

  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.setContent(html);
  await maybeScreenshot(page, "overview-desktop-full.png");
});

test("生成完整本轮总览截图（移动）", async ({ page }) => {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>审查结果 - 本轮总览</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --color-fg: #e7dfc6;
      --color-bg: #0a0c0e;
      --color-surface: #13151a;
      --color-border: rgba(231, 223, 198, 0.12);
      --color-muted: rgba(231, 223, 198, 0.55);
      --color-brass: #d4af37;
      --color-parchment: #e7dfc6;
      --font-command: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--color-bg);
      color: var(--color-fg);
      padding: 1rem;
      line-height: 1.6;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.125rem; margin: 1.5rem 0 0.75rem; }
    .ck-wb-report-meta {
      color: var(--color-muted);
      font-size: 0.8125rem;
      margin-bottom: 1.5rem;
    }
    .ck-finding-list-summary {
      color: var(--color-muted);
      font-size: 0.8125rem;
      margin: 1rem 0;
    }
    .ck-finding-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin: 0.85rem 0 0.7rem;
      border: 0;
      padding: 0;
    }
    .ck-finding-filter {
      appearance: none;
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-muted);
      font-family: var(--font-command);
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0.22rem 0.55rem;
      cursor: pointer;
    }
    .ck-finding-filter[aria-pressed="true"] {
      color: var(--color-parchment);
      border-color: var(--color-brass);
    }
    .ck-ledger {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      margin: 0;
      padding: 0;
    }
    .ck-ledger-row {
      min-width: 0;
      font-size: 0.82rem;
      line-height: 1.45;
    }
    .ck-finding-summary {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 0.45rem 0.6rem;
      align-items: start;
      cursor: pointer;
      list-style: none;
      min-width: 0;
    }
    .ck-finding-id-sev {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .ck-finding-number {
      font-family: var(--font-command);
      font-size: 0.72rem;
      color: var(--color-brass);
    }
    .ck-finding-heading {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      min-width: 0;
    }
    .ck-ledger-title {
      color: var(--color-fg);
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .ck-finding-location {
      font-family: var(--font-command);
      font-size: 0.72rem;
      color: var(--color-muted);
    }
    .ck-ledger-title,
    .ck-finding-tags {
      grid-column: 1 / -1;
    }
    .ck-finding-tags {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.3rem;
      justify-self: start;
    }
    .ck-finding-tags-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      justify-content: flex-start;
    }
    .ck-sev {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-family: var(--font-command);
      font-size: 0.62rem;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.1rem 0.4rem;
      border: 1px solid var(--color-border);
      white-space: nowrap;
      line-height: 1.3;
    }
    .ck-sev::before {
      content: "";
      display: inline-block;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .ck-sev-critical { color: #fca5a5; }
    .ck-sev-critical::before { background: #e11d48; }
    .ck-sev-major { color: #fdba74; }
    .ck-sev-major::before { background: #ea580c; }
    .ck-sev-minor { color: #fde047; }
    .ck-sev-minor::before { background: #eab308; }
    .ck-sev-nit { color: var(--color-muted); }
    .ck-sev-nit::before { background: rgba(255, 255, 255, 0.2); }
    .ck-ledger-status {
      font-family: var(--font-command);
      font-size: 0.62rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.1rem 0.4rem;
      border: 1px solid var(--color-border);
      white-space: normal;
      word-break: break-word;
      max-width: 20rem;
      line-height: 1.3;
    }
    .ck-ledger-open { color: #fbbf24; }
    .ck-ledger-closed { color: #4ade80; }
    .ck-ledger-regress { color: #fb7185; }
    .ck-ledger-accepted { color: var(--color-muted); }
    .ck-finding-source {
      font-family: var(--font-command);
      font-size: 0.62rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-muted);
      border: 1px solid var(--color-border);
      padding: 0.1rem 0.4rem;
      white-space: nowrap;
      line-height: 1.3;
    }
  </style>
</head>
<body>
  <article>
    <h1>审查已完成</h1>
    <p class="ck-wb-report-meta">
      <span>审查执行已完成</span>
      <span>6/6 席位已完成</span>
    </p>

    <section class="ck-finding-list">
      <h2 id="ck-ledger">问题清单</h2>
      <p class="ck-finding-list-summary">5 个问题 · 5 待处理 · 5 阻塞</p>

      <fieldset class="ck-finding-filters">
        <button type="button" class="ck-finding-filter" aria-pressed="true">阻塞</button>
        <button type="button" class="ck-finding-filter" aria-pressed="false">待处理</button>
        <button type="button" class="ck-finding-filter" aria-pressed="false">已解决</button>
        <button type="button" class="ck-finding-filter" aria-pressed="false">全部</button>
      </fieldset>

      <ul class="ck-ledger">
        <!-- Finding 1: Critical -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#01</span>
                <span class="ck-sev ck-sev-critical">致命</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">SQL 注入漏洞：用户输入未经验证直接拼接到查询语句中</span>
                <span class="ck-finding-location">新侧 L45</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-open">待处理</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">独有</span>
                </span>
              </span>
            </summary>
          </details>
        </li>

        <!-- Finding 2: Major with multiple tags -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#02</span>
                <span class="ck-sev ck-sev-major">重大</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">Resume 失败只看 ctx.Err()</span>
                <span class="ck-finding-location">新侧 L266</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-open">待处理</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">共识</span>
                </span>
              </span>
            </summary>
          </details>
        </li>

        <!-- Finding 3: Long title that wraps on mobile -->
        <li class="ck-ledger-row">
          <details>
            <summary class="ck-finding-summary">
              <span class="ck-finding-id-sev">
                <span class="ck-finding-number">#03</span>
                <span class="ck-sev ck-sev-major">重大</span>
              </span>
              <span class="ck-finding-heading">
                <span class="ck-ledger-title">这是一个非常非常长的问题标题，用于测试当标题很长时标签布局</span>
                <span class="ck-finding-location">新侧 L456</span>
              </span>
              <span class="ck-finding-tags">
                <span class="ck-finding-tags-row">
                  <span class="ck-ledger-status ck-ledger-regress">回归</span>
                </span>
                <span class="ck-finding-tags-row">
                  <span class="ck-finding-source">账本阻塞</span>
                  <span class="ck-finding-source">共识</span>
                  <span class="ck-finding-source">独有</span>
                </span>
              </span>
            </summary>
          </details>
        </li>
      </ul>
    </section>
  </article>
</body>
</html>
  `;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(html);
  await maybeScreenshot(page, "overview-mobile-full.png");
});
