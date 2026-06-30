import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

async function run() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const SESSION = path.join(process.cwd(), ".fb_session.json");
  if (fs.existsSync(SESSION)) {
    await context.addCookies(JSON.parse(fs.readFileSync(SESSION, "utf8")));
    console.log("Session loaded successfully");
  } else {
    console.log("No session found");
    await browser.close();
    return;
  }

  const page = await context.newPage();
  console.log("Navigating to https://www.facebook.com/ostadapp...");
  try {
    await page.goto("https://www.facebook.com/ostadapp", { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log("Waiting 5 seconds for page content...");
    await page.waitForTimeout(5000);
    console.log("Taking screenshot...");
    await page.screenshot({ path: "ostadapp_view.png" });
    console.log("Screenshot saved to ostadapp_view.png. Current URL is:", page.url());
  } catch (err) {
    console.error("Error during navigation:", err);
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
