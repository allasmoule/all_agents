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

    // Cookie popup
    try {
      const btn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
      if (await btn.isVisible({ timeout: 1000 })) await btn.click();
    } catch { /* ignore */ }

    await waitForImages(page);

    // Scroll down to load comments section, then scroll back
    await page.evaluate(() => window.scrollBy(0, 3000));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Remove sticky header
    try {
      await page.addStyleTag({
        content: `header, #masthead-container, [style*="position: fixed"], [style*="position: sticky"] { position: absolute !important; }`
      });
    } catch { /* ignore */ }

    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } catch (err) {
    console.error("❌ Screenshot error:", err);
    return false;
  }
}
