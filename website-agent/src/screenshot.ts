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
    for (const sel of [
      '[data-cookiebanner="accept_button"]',
      "#onetrust-accept-btn-handler",
      'button:has-text("Accept all")',
      'button:has-text("Reject all")',
      'button:has-text("Accept")',
      'button:has-text("Agree")',
      ".fc-cta-consent",
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) { await btn.click(); await page.waitForTimeout(500); break; }
      } catch { /* ignore */ }
    }

    // Scroll to load lazy images then back to top
    await page.evaluate(async () => {
      let totalHeight = 0;
      const distance = 400;
      while (totalHeight < document.body.scrollHeight && totalHeight < 15000) {
        window.scrollBy(0, distance);
        totalHeight += distance;
        await new Promise(r => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);

    await waitForImages(page);

    // Remove sticky headers
    try {
      await page.addStyleTag({
        content: `header, nav, [style*="position: fixed"], [style*="position: sticky"], .header, .nav, .sticky, .navbar { position: absolute !important; }`
      });
    } catch { /* ignore */ }

    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } catch (err) {
    console.error("❌ Screenshot error:", err);
    return false;
  }
}
