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

    // Cookie banners dismiss
    for (const sel of ['button:has-text("Accept all")', 'button:has-text("Allow all cookies")']) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) { await btn.click(); await page.waitForTimeout(500); break; }
      } catch { /* ignore */ }
    }

    await waitForImages(page);

    // Try article element screenshot (Instagram post container)
    for (const sel of ['article', 'main article', 'div[role="dialog"] article']) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.screenshot({ path: outputPath });
          return true;
        }
      } catch { /* ignore */ }
    }

    // Try the main content area
    try {
      const main = page.locator('main').first();
      if (await main.isVisible({ timeout: 2000 })) {
        await main.screenshot({ path: outputPath });
        return true;
      }
    } catch { /* ignore */ }

    // Fallback: full page screenshot
    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } catch (err) {
    console.error("❌ Screenshot error:", err);
    return false;
  }
}
