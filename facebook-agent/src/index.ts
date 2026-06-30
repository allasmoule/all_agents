// src/index.ts — Facebook Agent
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as cron from "node-cron";
import { chromium } from "playwright";
import { getLogger, sanitize, toDateStr, makeFolder, saveCaptionFile, screenshotPath, loadProgress, saveProgress, isSaved, markSaved, isWithinDays } from "./helpers";
import type { Post } from "./types";

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "C:\\screenshots";
const EMAIL = process.env.FACEBOOK_EMAIL ?? "";
const PASSWORD = process.env.FACEBOOK_PASSWORD ?? "";
const PAGES = (process.env.FACEBOOK_PAGES ?? "").split(",").map(s => s.trim()).filter(Boolean);
const HEADLESS = (process.env.HEADLESS ?? "false").toLowerCase() !== "false";
const MAX_POSTS = parseInt(process.env.MAX_POSTS ?? "0") || 0;
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? "7") || 7;
const CRON = process.env.CRON_SCHEDULE ?? "0 8 * * *";

const LOG_FILE = path.join(OUTPUT_DIR, "..", "logs", "facebook-agent.log");
const logger = getLogger(LOG_FILE);

async function login(page: any, email: string, password: string): Promise<boolean> {
  logger.info("🔐 Facebook login করছি...");
  try {
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    for (const sel of ['[data-cookiebanner="accept_button"]', 'button:has-text("Allow all cookies")', 'button:has-text("Accept all")']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1000 })) { await b.click(); await page.waitForTimeout(1000); break; } } catch { /* ignore */ }
    }

    let emailField = page.locator("#email").first();
    if (!(await emailField.isVisible({ timeout: 2000 }).catch(() => false))) emailField = page.locator('input[name="email"]').first();
    await emailField.waitFor({ state: "visible", timeout: 10000 });
    await emailField.fill(email);
    await page.waitForTimeout(500);

    let passField = page.locator("#pass").first();
    if (!(await passField.isVisible({ timeout: 2000 }).catch(() => false))) passField = page.locator('input[name="pass"], input[type="password"]').first();
    await passField.waitFor({ state: "visible", timeout: 10000 });
    await passField.fill(password);
    await page.waitForTimeout(500);

    let clicked = false;
    for (const sel of ['button[name="login"]', 'button[type="submit"]', '[data-testid="royal_login_button"]', 'button:has-text("Log in")']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click(); clicked = true; break; } } catch { /* try next */ }
    }
    if (!clicked) await passField.press("Enter");

    await page.waitForTimeout(8000);
    const url = page.url();
    if (url.includes("facebook.com") && !url.includes("login")) { logger.info("✅ Login সফল!"); return true; }
    if (url.includes("checkpoint") || url.includes("challenge")) {
      logger.warn("⚠️  2FA/Checkpoint — ৪৫ সেকেন্ড সময় দিচ্ছি...");
      await page.waitForTimeout(45000);
      return !page.url().includes("login");
    }
    logger.error("❌ Login failed. URL: " + url);
    return false;
  } catch (err) { logger.error("Login error: " + err); return false; }
}

// Collect post URLs by scrolling the page feed
async function collectPostUrls(page: any, username: string, limit: number): Promise<{ url: string; date: string }[]> {
  const found = new Map<string, string>(); // url -> date
  let noNewCount = 0;

  for (let scroll = 0; scroll < 25; scroll++) {
    if (found.size >= limit) break;
    if (noNewCount >= 4) break;
    const prevSize = found.size;

    // Method 1: Find all links that look like post permalinks
    const postLinks = await page.evaluate(() => {
      const results: { url: string; date: string }[] = [];
      const seen = new Set<string>();

      // Find links with post-identifying URL patterns
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      for (const a of allLinks) {
        const href = (a as HTMLAnchorElement).href || "";
        if (!href) continue;

        const isPostLink = href.includes("/posts/") || href.includes("pfbid") ||
          href.includes("story_fbid") || href.includes("/permalink/") ||
          href.includes("/photo") || href.includes("/reel/") || href.includes("/videos/") ||
          href.includes("fbid=");
        if (!isPostLink) continue;

        // Normalize URL — keep query params for fbid/pfbid/story_fbid URLs
        let cleanUrl = href;
        if (href.includes("fbid=") || href.includes("pfbid") || href.includes("story_fbid")) {
          // Keep important query params, strip tracking params
          try {
            const u = new URL(href);
            const keep = ["fbid", "set", "story_fbid", "id"];
            const params = new URLSearchParams();
            for (const k of keep) { const v = u.searchParams.get(k); if (v) params.set(k, v); }
            cleanUrl = `${u.origin}${u.pathname}${params.toString() ? "?" + params.toString() : ""}`;
          } catch { cleanUrl = href.split("&__cft__")[0]; }
        } else {
          cleanUrl = href.split("?")[0];
        }

        // Skip generic section links without actual content IDs
        if (/\/(reel|videos|photos|posts|permalink)\/?$/.test(cleanUrl)) continue;
        if (cleanUrl.endsWith("/photo/") || cleanUrl.endsWith("/photo")) continue;

        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);

        // Try to find date near this link
        let date = "";
        const parent = a.closest('div') || a.parentElement;
        if (parent) {
          // Look for time element near this link (within the same post container)
          let container: Element | null = a as Element;
          for (let i = 0; i < 10; i++) {
            container = container?.parentElement || null;
            if (!container) break;
            const timeEl = container.querySelector("time");
            if (timeEl) {
              date = timeEl.getAttribute("datetime") || "";
              break;
            }
          }
        }
        // Also check if the link itself wraps a time element
        const timeInLink = (a as Element).querySelector("time");
        if (timeInLink && !date) date = timeInLink.getAttribute("datetime") || "";

        results.push({ url: cleanUrl, date });
      }

      // Method 2: Find timestamp links (a > time pattern) — these always point to posts
      const timeLinks = Array.from(document.querySelectorAll('a time'));
      for (const timeEl of timeLinks) {
        const anchor = timeEl.closest('a') as HTMLAnchorElement;
        if (!anchor?.href) continue;
        const href = anchor.href;
        if (seen.has(href.split("?")[0])) continue;
        seen.add(href.split("?")[0]);
        const date = (timeEl as HTMLElement).getAttribute("datetime") || "";
        results.push({ url: href.split("?")[0], date });
      }

      return results;
    });

    for (const { url, date } of postLinks) {
      if (!found.has(url)) found.set(url, date);
    }

    if (found.size === prevSize) noNewCount++;
    else noNewCount = 0;

    logger.info(`  📜 Scroll ${scroll + 1}: found ${found.size} unique post URLs`);

    // Scroll down
    try {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await page.waitForTimeout(3000);
    } catch { break; }
  }

  return Array.from(found.entries()).map(([url, date]) => ({ url, date }));
}

async function scrapePage(page: any, username: string, progress: Record<string, string[]>): Promise<Post[]> {
  const pageUrl = `https://www.facebook.com/${username}`;
  logger.info(`\n🔵 Facebook page: ${username}`);

  // Navigate to the page
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {
    await page.goto(pageUrl, { waitUntil: "load", timeout: 30000 });
  }
  await page.waitForTimeout(5000);

  // Try clicking the "Posts" tab if visible
  try {
    const postsTab = page.locator('a[role="tab"]:has-text("Posts")').first();
    if (await postsTab.isVisible({ timeout: 2000 })) {
      await postsTab.click();
      await page.waitForTimeout(3000);
      logger.info(`  📑 "Posts" tab clicked`);
    }
  } catch { /* ignore */ }

  logger.info(`  📍 URL: ${page.url()}`);

  // Get page name
  let pageName = username;
  try { const h1 = await page.locator("h1").first().textContent({ timeout: 3000 }); if (h1) pageName = h1.trim(); } catch { /* ignore */ }

  const folder = makeFolder(OUTPUT_DIR, "facebook", sanitize(pageName));
  const posts: Post[] = [];
  let limit = MAX_POSTS > 0 ? MAX_POSTS : 50;

  // Phase 1: Collect post URLs from the feed
  logger.info(`  🔍 Post URLs সংগ্রহ করছি...`);
  const postUrls = await collectPostUrls(page, username, limit);
  logger.info(`  📋 ${postUrls.length}টি post URL পাওয়া গেছে`);

  if (postUrls.length === 0) {
    logger.info(`  ⚠️ কোনো post URL পাওয়া যায়নি`);
    return posts;
  }

  // Phase 2: Visit each post individually and take screenshot
  for (const { url: postUrl, date: feedDate } of postUrls) {
    if (posts.length >= limit) break;

    // Extract post ID from URL
    let postId = "";
    // Try extracting fbid from query params first
    try { const u = new URL(postUrl.startsWith("http") ? postUrl : `https://www.facebook.com${postUrl}`); const fbid = u.searchParams.get("fbid"); if (fbid) postId = fbid; } catch { /* ignore */ }
    if (!postId) {
      const idMatch = postUrl.match(/(?:posts\/|pfbid|story_fbid=|permalink\/|photo\/|reel\/|videos\/)([\w]+)/);
      if (idMatch) postId = idMatch[1];
    }
    if (!postId) {
      let hash = 0;
      const str = postUrl;
      for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0; }
      postId = `post_${Math.abs(hash).toString(36)}`;
    }

    const fullId = `${username}_${postId}`;
    if (isSaved(progress, username, fullId)) continue;

    // Date check from feed (if available)
    if (feedDate && !isWithinDays(feedDate, DAYS_BACK)) {
      logger.info(`  ⏭️ Too old (${toDateStr(feedDate)}), skipping`);
      continue;
    }

    // Navigate to the individual post
    try {
      const fullUrl = postUrl.startsWith("http") ? postUrl : `https://www.facebook.com${postUrl}`;
      await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(4000);
    } catch {
      try {
        const fullUrl = postUrl.startsWith("http") ? postUrl : `https://www.facebook.com${postUrl}`;
        await page.goto(fullUrl, { waitUntil: "load", timeout: 20000 });
        await page.waitForTimeout(4000);
      } catch (err) {
        logger.warn(`  ⚠️ Cannot open post: ${err}`);
        continue;
      }
    }

    // Extract date and caption from the individual post page
    const postData = await page.evaluate(() => {
      let date = "";
      const timeEl = document.querySelector("time");
      if (timeEl) date = timeEl.getAttribute("datetime") || "";
      const abbrEl = document.querySelector("abbr[data-utime]");
      if (abbrEl) {
        const ut = abbrEl.getAttribute("data-utime");
        if (ut) date = new Date(parseInt(ut) * 1000).toISOString();
      }

      let caption = "";
      const divs = Array.from(document.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
      for (const d of divs) {
        const t = d.textContent?.trim() || "";
        if (t.length > caption.length && t.length > 10) caption = t;
      }
      return { date, caption };
    });

    const postDate = postData.date ? toDateStr(postData.date) : (feedDate ? toDateStr(feedDate) : toDateStr(new Date().toISOString()));

    // Date check from individual post page
    if (postData.date && !isWithinDays(postData.date, DAYS_BACK)) {
      logger.info(`  ⏭️ Too old (${postDate}), skipping`);
      continue;
    }

    // Take screenshot — try article element first, then full viewport
    const ssFile = screenshotPath(folder, postDate, sanitize(fullId));
    let ssOk = false;
    try {
      fs.mkdirSync(path.dirname(ssFile), { recursive: true });

      // Try to find the post container on the individual post page
      const articleEl = page.locator('div[role="article"]').first();
      if (await articleEl.isVisible({ timeout: 2000 }).catch(() => false)) {
        await articleEl.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1000);
        await articleEl.screenshot({ path: ssFile });
      } else {
        // Fallback: screenshot the main content area or full viewport
        const mainEl = page.locator('div[role="main"]').first();
        if (await mainEl.isVisible({ timeout: 2000 }).catch(() => false)) {
          await mainEl.screenshot({ path: ssFile });
        } else {
          await page.screenshot({ path: ssFile, fullPage: false });
        }
      }
      ssOk = fs.existsSync(ssFile) && fs.statSync(ssFile).size > 5000;
    } catch (ssErr) { logger.warn(`  ⚠️ Screenshot error: ${ssErr}`); }

    if (!ssOk) {
      logger.warn(`  ⚠️ Screenshot failed for ${fullId}`);
      continue;
    }

    const fullPostUrl = postUrl.startsWith("http") ? postUrl : `https://www.facebook.com${postUrl}`;
    const post: Post = {
      id: fullId,
      platform: "facebook",
      source: pageName,
      caption: postData.caption || "(no caption)",
      url: fullPostUrl,
      postDate,
      createdTime: new Date().toISOString(),
    };

    saveCaptionFile(folder, post, sanitize(fullId));
    markSaved(progress, username, fullId);
    saveProgress(progress);
    posts.push(post);
    logger.info(`  ✓ [${posts.length}] ${(postData.caption || postId).slice(0, 60)} | screenshot ✓`);
  }

  logger.info(`  ✅ ${pageName}: ${posts.length}টি post`);
  return posts;
}

async function run() {
  if (!EMAIL || !PASSWORD) { logger.error(".env-এ FACEBOOK_EMAIL এবং FACEBOOK_PASSWORD দাও!"); return; }
  if (PAGES.length === 0) { logger.error(".env-এ FACEBOOK_PAGES দাও!"); return; }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const progress = loadProgress();

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const SESSION = path.join(process.cwd(), ".fb_session.json");
  try { if (fs.existsSync(SESSION)) { await context.addCookies(JSON.parse(fs.readFileSync(SESSION, "utf8"))); logger.info("💾 Session loaded"); } } catch { /* ignore */ }

  const page = await context.newPage();
  let loggedIn = false;

  try {
    await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);
    const cookies = await context.cookies();
    const hasUser = cookies.some((c: any) => c.name === "c_user");
    loggedIn = hasUser && !page.url().includes("login");
    if (loggedIn) logger.info("✅ Existing session কাজ করছে");
  } catch { loggedIn = false; }

  if (!loggedIn) {
    await context.clearCookies();
    try { if (fs.existsSync(SESSION)) fs.unlinkSync(SESSION); } catch { /* ignore */ }
    loggedIn = await login(page, EMAIL, PASSWORD);
    if (loggedIn) fs.writeFileSync(SESSION, JSON.stringify(await context.cookies(), null, 2));
  }

  if (!loggedIn) { logger.error("❌ Login হয়নি"); await browser.close(); return; }

  let total = 0;
  for (const pageInput of PAGES) {
    const username = pageInput.replace(/https?:\/\/(www\.)?facebook\.com\//i, "").replace(/\/$/, "").trim();
    try {
      const posts = await scrapePage(page, username, progress);
      total += posts.length;
    } catch (err) { logger.error(`  ❌ Error [${username}]: ${err}`); }
  }

  await browser.close();
  logger.info(`\n🎉 Facebook Agent সম্পন্ন! মোট ${total}টি post`);
}

logger.info("╔══════════════════════════════════════╗");
logger.info("║     📘  Facebook Agent               ║");
logger.info("╚══════════════════════════════════════╝");

const args = process.argv.slice(2);
if (args.includes("--schedule")) {
  logger.info(`⏰ Scheduler: ${CRON}`);
  cron.schedule(CRON, () => run().catch(e => logger.error("Error: " + e)));
  process.stdin.resume();
} else {
  run().catch(e => { logger.error("Fatal: " + e); process.exit(1); });
}
