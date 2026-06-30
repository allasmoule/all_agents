// src/index.ts — Instagram Agent
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as cron from "node-cron";
import { chromium } from "playwright";
import { getLogger, sanitize, toDateStr, makeFolder, saveCaptionFile, screenshotPath, loadProgress, saveProgress, isSaved, markSaved } from "./helpers";
import { takeScreenshot } from "./screenshot";
import type { Post, Comment } from "./types";

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "C:\\screenshots";
const EMAIL      = process.env.INSTAGRAM_EMAIL ?? "";
const PASSWORD   = process.env.INSTAGRAM_PASSWORD ?? "";
const ACCOUNTS   = (process.env.INSTAGRAM_ACCOUNTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const HEADLESS   = (process.env.HEADLESS ?? "false").toLowerCase() !== "false";
const MAX_POSTS  = parseInt(process.env.MAX_POSTS ?? "0") || 0;
const CRON       = process.env.CRON_SCHEDULE ?? "0 8 * * *";

const LOG_FILE = path.join(OUTPUT_DIR, "..", "logs", "instagram-agent.log");
const logger = getLogger(LOG_FILE);

async function login(page: any, email: string, password: string): Promise<boolean> {
  logger.info("🔐 Instagram login করছি...");
  try {
    await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    for (const sel of ['button:has-text("Allow all cookies")', 'button:has-text("Accept All")', 'button:has-text("Allow essential and optional cookies")']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click(); await page.waitForTimeout(1500); break; } } catch { /* ignore */ }
    }

    const usernameField = page.locator('input[name="username"]').first();
    await usernameField.waitFor({ state: "visible", timeout: 10000 });
    await usernameField.click();
    await usernameField.fill("");
    await usernameField.type(email, { delay: 80 });
    await page.waitForTimeout(500);

    const passField = page.locator('input[name="password"]').first();
    await passField.click();
    await passField.fill("");
    await passField.type(password, { delay: 80 });
    await page.waitForTimeout(500);

    let clicked = false;
    for (const sel of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Log In")']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click(); clicked = true; break; } } catch { /* try next */ }
    }
    if (!clicked) await passField.press("Enter");

    await page.waitForTimeout(6000);

    for (const txt of ["Not Now", "Not now", "Skip"]) {
      try { const b = page.locator(`button:has-text("${txt}")`).first(); if (await b.isVisible({ timeout: 2000 })) { await b.click(); await page.waitForTimeout(1000); } } catch { /* ignore */ }
    }

    const url = page.url();
    if (!url.includes("login") && !url.includes("challenge")) { logger.info("✅ Login সফল!"); return true; }
    if (url.includes("challenge")) {
      logger.warn("⚠️  2FA — ৪৫ সেকেন্ড সময় দিচ্ছি...");
      await page.waitForTimeout(45000);
      return !page.url().includes("login");
    }
    logger.error("❌ Login failed");
    return false;
  } catch (err) { logger.error("Login error: " + err); return false; }
}

async function expandComments(page: any): Promise<void> {
  for (let i = 0; i < 10; i++) {
    let expanded = false;
    for (const sel of [
      'button:has-text("View all")',
      'button:has-text("Load more comments")',
      'span:has-text("View all")',
      'li button[type="button"]',
    ]) {
      try {
        const btns = await page.locator(sel).all();
        for (const btn of btns) {
          const text = (await btn.textContent({ timeout: 500 })) ?? "";
          if (text.includes("View all") || text.includes("Load more")) {
            if (await btn.isVisible({ timeout: 500 })) {
              await btn.click();
              await page.waitForTimeout(2000);
              expanded = true;
            }
          }
        }
      } catch { /* ignore */ }
    }
    if (!expanded) break;
  }
}

async function getComments(page: any, postUrl: string): Promise<Comment[]> {
  try {
    return await page.evaluate((pUrl: string) => {
      const results: { author: string; text: string; url: string }[] = [];
      const seen = new Set<string>();

      // Instagram comments are in ul > li structure inside article
      const commentItems = Array.from(document.querySelectorAll('ul > li, div[role="button"]'));

      for (const item of commentItems) {
        // Find username link
        let author = "Unknown";
        const userLink = item.querySelector('a[href*="/"] span, a[title]') as HTMLElement;
        if (userLink) {
          author = userLink.textContent?.trim() || "Unknown";
        }

        // Find comment text
        let text = "";
        const spans = Array.from(item.querySelectorAll('span[dir]'));
        for (const span of spans) {
          const t = span.textContent?.trim() || "";
          if (!t || t === author) continue;
          if (["Reply", "Like", "See translation", "Translate", "likes"].some(w => t === w)) continue;
          if (t.match(/^\d+[wdhms]$/) || t.match(/^\d+\s*(?:week|day|hour|min|sec|like|repl)s?/i)) continue;
          if (t.length > text.length) text = t;
        }

        if (!text || text.length < 2) continue;

        const key = `${author}:${text.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Comment URL: IG doesn't have per-comment URLs easily, use post URL
        const timeLink = item.querySelector('a[href*="/c/"], time');
        let commentUrl = pUrl;
        if (timeLink) {
          const parent = timeLink.closest('a') as HTMLAnchorElement;
          if (parent?.href) commentUrl = parent.href;
        }

        results.push({ author, text, url: commentUrl });
      }

      return results;
    }, postUrl);
  } catch (err) {
    logger.error("Comment extraction error: " + err);
    return [];
  }
}

async function scrapeAccount(page: any, accountInput: string, progress: Record<string, string[]>): Promise<Post[]> {
  const username = accountInput.replace(/https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/$/, "").replace(/^@/, "").trim();
  const profileUrl = `https://www.instagram.com/${username}/`;

  logger.info(`\n🟣 Instagram: @${username}`);
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  let profileName = username;
  try { const h1 = await page.locator("h1").first().textContent({ timeout: 3000 }); if (h1) profileName = h1.trim(); } catch { /* ignore */ }

  const allHrefs = new Set<string>();
  let lastHeight = 0;
  let noNewCount = 0;

  logger.info(`  🔍 Post links collect করছি...`);
  while (true) {
    const links = await page.locator('a[href*="/p/"]').all();
    for (const link of links) {
      const href = await link.getAttribute("href") ?? "";
      if (href.includes("/p/")) allHrefs.add(href);
    }
    if (MAX_POSTS > 0 && allHrefs.size >= MAX_POSTS) break;
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(2000);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastHeight) { noNewCount++; if (noNewCount >= 4) break; } else { noNewCount = 0; lastHeight = h; }
  }

  logger.info(`  📋 ${allHrefs.size}টি post URL পাওয়া গেছে`);

  const posts: Post[] = [];
  let postIndex = 1;

  for (const href of allHrefs) {
    if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
    const postId = href.replace(/^\/p\//, "").replace(/\/$/, "");
    if (isSaved(progress, username, postId)) continue;

    const postUrl = `https://www.instagram.com${href}`;
    try {
      await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(3000);

      let caption = "";
      for (const sel of ['article h1', 'div._a9zs span', 'li:first-child span[dir]', 'div[data-testid="post-comment-root"] span']) {
        try { const txt = (await page.locator(sel).first().textContent({ timeout: 800 })) ?? ""; if (txt.trim().length > caption.length) caption = txt.trim(); } catch { /* ignore */ }
      }

      let postDate = toDateStr(new Date().toISOString());
      try { const dt = await page.locator("time").first().getAttribute("datetime"); if (dt) postDate = toDateStr(dt); } catch { /* ignore */ }

      const folder = makeFolder(OUTPUT_DIR, "instagram", sanitize(profileName));
      const post: Post = { id: postId, platform: "instagram", source: profileName, caption: caption || "(No caption)", url: postUrl, postDate, createdTime: new Date().toISOString() };

      saveCaptionFile(folder, post, postId);
      const ssOk = await takeScreenshot(page, screenshotPath(folder, postDate, postId));

      if (ssOk) {
        markSaved(progress, username, postId);
        saveProgress(progress);
        posts.push(post);
        postIndex++;
        logger.info(`    ✓ [${postIndex - 1}] ${caption.slice(0, 50) || postId} | screenshot ✓`);
      } else {
        logger.warn(`    ⚠️ Caption saved but screenshot FAILED for ${postId}`);
      }
    } catch (err) { logger.warn(`    ⚠️ Skip: ${postId} — ${err}`); }
  }
  return posts;
}

async function run() {
  if (!EMAIL || !PASSWORD) { logger.error(".env-এ INSTAGRAM_EMAIL এবং INSTAGRAM_PASSWORD দাও!"); return; }
  if (ACCOUNTS.length === 0) { logger.error(".env-এ INSTAGRAM_ACCOUNTS দাও!"); return; }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const progress = loadProgress();

  const browser = await chromium.launch({ headless: HEADLESS, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });

  const SESSION = path.join(process.cwd(), ".ig_session.json");
  try { if (fs.existsSync(SESSION)) { await context.addCookies(JSON.parse(fs.readFileSync(SESSION, "utf8"))); logger.info("💾 Session loaded"); } } catch { /* ignore */ }

  const page = await context.newPage();
  let loggedIn = false;

  try {
    await page.goto("https://www.instagram.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000);
    loggedIn = !page.url().includes("login");
    if (loggedIn) logger.info("✅ Existing session কাজ করছে");
  } catch { /* ignore */ }

  if (!loggedIn) {
    loggedIn = await login(page, EMAIL, PASSWORD);
    if (loggedIn) fs.writeFileSync(SESSION, JSON.stringify(await context.cookies(), null, 2));
  }

  if (!loggedIn) { logger.error("❌ Login হয়নি"); await browser.close(); return; }

  let total = 0;
  for (const account of ACCOUNTS) {
    try { const posts = await scrapeAccount(page, account, progress); total += posts.length; logger.info(`  ✅ ${account}: ${posts.length}টি`); }
    catch (err) { logger.error(`  ❌ Error [${account}]: ${err}`); }
  }

  await browser.close();
  logger.info(`\n🎉 Instagram Agent সম্পন্ন! মোট ${total}টি post`);
}

logger.info("╔══════════════════════════════════════╗");
logger.info("║     📷  Instagram Agent              ║");
logger.info("╚══════════════════════════════════════╝");

const args = process.argv.slice(2);
if (args.includes("--schedule")) {
  logger.info(`⏰ Scheduler: ${CRON}`);
  cron.schedule(CRON, () => run().catch(e => logger.error("Error: " + e)));
  process.stdin.resume();
} else {
  run().catch(e => { logger.error("Fatal: " + e); process.exit(1); });
}
