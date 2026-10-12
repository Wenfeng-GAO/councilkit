import { chromium } from "playwright-core";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pw = require("@playwright/test");
const executablePath = pw.chromium.executablePath();

const root = dirname(fileURLToPath(import.meta.url));
const html = join(root, "report.html");
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle" });
await page.screenshot({ path: join(root, "report.png"), fullPage: true });
await page.locator(".cards").screenshot({ path: join(root, "before-after-counts.png") });
await browser.close();
console.log("wrote screenshots in", root);
