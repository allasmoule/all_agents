// src/screenshot.ts
import { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

async function waitForImages(page: Page, timeout = 5000): Promise<void> {
  try {
    await page.evaluate((t) => {
      return new Promise<void>((resolve) => {
        const imgs = Array.from(document.querySelectorAll("img"));
        const pending = imgs.filter(img => !img.complete);
        if (pending.length === 0) return resolve();
        let done = 0;
        const check = () => { done++; if (done >= pending.length) resolve(); };
        pending.forEach(img => { img.addEventListener("load", check); img.addEventListener("error", check); });
        setTimeout(resolve, t);
      });
    }, timeout);
  } catch { /* ignore */ }
}

export async function takeScreenshot(page: Page, outputPath: string): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await waitForImages(page);

    // Try the tweet article element
    try {
      const article = page.locator('article[data-testid="tweet"]').first();
      if (await article.isVisible({ timeout: 5000 })) {
        await article.screenshot({ path: outputPath });
        return true;
      }
    } catch { /* ignore */ }

    // Fallback: first article
    try {
      const article = page.locator('article').first();
      if (await article.isVisible({ timeout: 3000 })) {
        await article.screenshot({ path: outputPath });
        return true;
      }
    } catch { /* ignore */ }

    // Scroll down to load replies, then full page
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } catch (err) {
    console.error("❌ Screenshot error:", err);
    return false;
  }
}
