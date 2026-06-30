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

async function scrapePage(page: any, username: string, progress: Record<string, string[]>): Promise<Post[]> {
  const pageUrl = `https://www.facebook.com/${username}`;
  logger.info(`\n🔵 Facebook page: ${username}`);

  // Navigate to page
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {
    await page.goto(pageUrl, { waitUntil: "load", timeout: 30000 });
  }
  await page.waitForTimeout(5000);

  // Get page name
  let pageName = username;
  try { const h1 = await page.locator("h1").first().textContent({ timeout: 3000 }); if (h1) pageName = h1.trim(); } catch { /* ignore */ }

  const folder = makeFolder(OUTPUT_DIR, "facebook", sanitize(pageName));
  const posts: Post[] = [];
  const seenIds = new Set<string>();
  let limit = MAX_POSTS > 0 ? MAX_POSTS : 50;
  let tooOldCount = 0;

  // Scroll and process posts directly from feed
  for (let scroll = 0; scroll < 20; scroll++) {
    if (posts.length >= limit) break;
    if (tooOldCount >= 2) break;

    // Find all article elements on page
    const articleCount = await page.locator('div[role="article"]').count();

    for (let idx = 0; idx < articleCount; idx++) {
      if (posts.length >= limit) break;

      try {
        const article = page.locator('div[role="article"]').nth(idx);
        if (!(await article.isVisible({ timeout: 1000 }))) continue;

        // Generate unique ID from article content
        const articleData = await article.evaluate((el: Element) => {
          // Get all text for hashing
          const text = el.textContent?.trim().slice(0, 200) || "";
          // Find any post link
          let postUrl = "";
          const links = Array.from(el.querySelectorAll('a[href]'));
          for (const a of links) {
            const h = (a as HTMLAnchorElement).getAttribute("href") || "";
            if (h.includes("/posts/") || h.includes("pfbid") || h.includes("story_fbid") ||
                h.includes("permalink") || h.includes("/photo/") || h.includes("/reel/") || h.includes("/videos/")) {
              postUrl = h; break;
            }
          }
          // Fallback: timestamp link
          if (!postUrl) {
            const timeLink = el.querySelector('a[role="link"] time, a time');
            if (timeLink) {
              const parent = timeLink.closest('a') as HTMLAnchorElement;
              if (parent?.href) postUrl = parent.href;
            }
          }
          // Get date
          let date = "";
          const timeEl = el.querySelector("time");
          if (timeEl) date = timeEl.getAttribute("datetime") || "";
          const abbrEl = el.querySelector("abbr[data-utime]");
          if (abbrEl) {
            const ut = abbrEl.getAttribute("data-utime");
            if (ut) date = new Date(parseInt(ut) * 1000).toISOString();
          }
          // Caption: largest text block
          let caption = "";
          const divs = Array.from(el.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
          for (const d of divs) {
            const t = d.textContent?.trim() || "";
            if (t.length > caption.length && t.length > 10) caption = t;
          }
          return { text: text.slice(0, 100), postUrl, date, caption };
        });

        // Generate post ID
        let postId = "";
        if (articleData.postUrl) {
          const match = articleData.postUrl.match(/(?:posts\/|pfbid|story_fbid=|permalink\/|photo\/|reel\/|videos\/)([\w]+)/);
          if (match) postId = match[1];
        }
        if (!postId) {
          // Hash from text content
          let hash = 0;
          for (let i = 0; i < articleData.text.length; i++) { hash = ((hash << 5) - hash + articleData.text.charCodeAt(i)) | 0; }
          postId = `post_${Math.abs(hash).toString(36)}`;
        }

        const fullId = `${username}_${postId}`;
        if (seenIds.has(fullId)) continue;
        seenIds.add(fullId);

        // Skip non-post articles (page info, details etc)
        if (!articleData.caption || articleData.caption.length < 10) continue;

        if (isSaved(progress, username, fullId)) continue;

        // Date check
        const postDate = articleData.date ? toDateStr(articleData.date) : toDateStr(new Date().toISOString());
        if (articleData.date && !isWithinDays(articleData.date, DAYS_BACK)) {
          logger.info(`  ⏭️ Too old (${postDate}), stopping`);
          tooOldCount++;
          continue;
        }

        // Take screenshot of the article element directly
        const ssFile = screenshotPath(folder, postDate, sanitize(fullId));
        let ssOk = false;
        try {
          fs.mkdirSync(path.dirname(ssFile), { recursive: true });
          await article.scrollIntoViewIfNeeded();
          await page.waitForTimeout(1000);
          await article.screenshot({ path: ssFile });
          ssOk = fs.existsSync(ssFile) && fs.statSync(ssFile).size > 5000;
        } catch { /* ignore */ }

        if (!ssOk) {
          logger.warn(`  ⚠️ Screenshot failed for ${fullId}`);
          continue;
        }

        const postUrl = articleData.postUrl
          ? (articleData.postUrl.startsWith("http") ? articleData.postUrl : `https://www.facebook.com${articleData.postUrl}`)
          : pageUrl;

        const post: Post = {
          id: fullId,
          platform: "facebook",
          source: pageName,
          caption: articleData.caption,
          url: postUrl,
          postDate,
          createdTime: new Date().toISOString(),
        };

        saveCaptionFile(folder, post, sanitize(fullId));
        markSaved(progress, username, fullId);
        saveProgress(progress);
        posts.push(post);
        logger.info(`  ✓ [${posts.length}] ${articleData.caption.slice(0, 60)} | screenshot ✓`);
      } catch { /* skip article */ }
    }

    // Scroll down to load more
    try {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await page.waitForTimeout(3000);
    } catch { break; }
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
