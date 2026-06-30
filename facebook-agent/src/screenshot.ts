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

export async function takeScreenshot(page: Page, outputPath: string, isDirectPost = false): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Cookie banners dismiss
    for (const sel of [
      '[data-cookiebanner="accept_button"]',
      "#onetrust-accept-btn-handler",
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) { await btn.click(); await page.waitForTimeout(500); break; }
      } catch { /* ignore */ }
    }

    await waitForImages(page);

    if (isDirectPost) {
      // For direct post pages: scroll down to load comments area, then take full page
      await page.evaluate(() => window.scrollBy(0, 3000));
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      // Remove sticky headers
      try {
        await page.addStyleTag({
          content: `header, nav, [style*="position: fixed"], [style*="position: sticky"] { position: absolute !important; }`
        });
      } catch { /* ignore */ }

      await page.screenshot({ path: outputPath, fullPage: true });
      return true;
    }

    // Non-direct: try dialog first, then article, then viewport
    try {
      const dialog = page.locator('div[role="dialog"]').first();
      if (await dialog.isVisible({ timeout: 2000 })) {
        // Expand "See more" inside dialog
        for (const sel of ['div[role="button"]:has-text("See more")', 'span:has-text("See more")']) {
          try {
            const btn = dialog.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 })) { await btn.click(); await page.waitForTimeout(500); break; }
          } catch { /* ignore */ }
        }
        await dialog.screenshot({ path: outputPath });
        return true;
      }
    } catch { /* ignore */ }

    try {
      const article = page.locator('div[role="article"]').first();
      if (await article.isVisible({ timeout: 3000 })) {
        await article.screenshot({ path: outputPath });
        return true;
      }
    } catch { /* ignore */ }

    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } catch (err) {
    console.error("❌ Screenshot error:", err);
    return false;
  }
}
