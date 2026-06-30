import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const SESSION = path.join(process.cwd(), ".fb_session.json");
  if (fs.existsSync(SESSION)) {
    await context.addCookies(JSON.parse(fs.readFileSync(SESSION, "utf8")));
  }

  const page = await context.newPage();
  const url = "https://www.facebook.com/eshikhon/posts/1011731488113410";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  console.log("Saving page screenshot to full_page_fb.png");
  await page.screenshot({ path: "full_page_fb.png" });
  await browser.close();
}

run().catch(console.error);
