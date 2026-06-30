// src/index.ts — Twitter Agent
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as cron from "node-cron";
import { chromium } from "playwright";
import { getLogger, sanitize, toDateStr, makeFolder, saveCaptionFile, screenshotPath, loadProgress, saveProgress, isSaved, markSaved, isWithinDays } from "./helpers";
import { takeScreenshot } from "./screenshot";
import type { Post, Comment } from "./types";

dotenv.config();

const OUTPUT_DIR       = process.env.OUTPUT_DIR ?? "C:\\screenshots";
const EMAIL            = process.env.TWITTER_EMAIL ?? "";
const PASSWORD         = process.env.TWITTER_PASSWORD ?? "";
const TWITTER_USERNAME = process.env.TWITTER_USERNAME ?? "";
const ACCOUNTS         = (process.env.TWITTER_ACCOUNTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const HEADLESS         = (process.env.HEADLESS ?? "false").toLowerCase() !== "false";
const MAX_POSTS        = parseInt(process.env.MAX_POSTS ?? "0") || 0;
const DAYS_BACK        = parseInt(process.env.DAYS_BACK ?? "7") || 7;
const CRON             = process.env.CRON_SCHEDULE ?? "0 8 * * *";

const LOG_FILE = path.join(OUTPUT_DIR, "..", "logs", "twitter-agent.log");
const logger = getLogger(LOG_FILE);

async function login(page: any, email: string, password: string, username: string): Promise<boolean> {
  logger.info("🔐 Twitter login করছি...");
  try {
    await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    const emailField = page.locator('input[autocomplete="username"], input[name="text"]').first();
    await emailField.waitFor({ state: "visible", timeout: 10000 });
    await emailField.click();
    await emailField.type(email, { delay: 80 });
    await page.waitForTimeout(500);

    for (const sel of ['button:has-text("Next")', 'div[role="button"]:has-text("Next")']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click(); break; } } catch { /* try next */ }
    }
    await page.waitForTimeout(3000);

    // Unusual activity check
    try {
      const f = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
      if (await f.isVisible({ timeout: 2000 })) {
        await f.fill(username);
        await page.locator('button[data-testid="ocfEnterTextNextButton"]').first().click();
        await page.waitForTimeout(2000);
      }
    } catch { /* ignore */ }

    const passField = page.locator('input[name="password"], input[type="password"]').first();
    await passField.waitFor({ state: "visible", timeout: 10000 });
    await passField.click();
    await passField.type(password, { delay: 80 });
    await page.waitForTimeout(500);

    let clicked = false;
    for (const sel of ['button[data-testid="LoginForm_Login_Button"]', 'button:has-text("Log in")', 'button[type="submit"]']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click(); clicked = true; break; } } catch { /* try next */ }
    }
    if (!clicked) await passField.press("Enter");

    await page.waitForTimeout(6000);
    const url = page.url();
    if (url.includes("x.com") && !url.includes("login") && !url.includes("flow")) { logger.info("✅ Login সফল!"); return true; }
    if (url.includes("challenge")) {
      logger.warn("⚠️  2FA — ৪৫ সেকেন্ড সময় দিচ্ছি...");
      await page.waitForTimeout(45000);
      return !page.url().includes("login");
    }
    logger.error("❌ Login failed. URL: " + url);
    return false;
  } catch (err) { logger.error("Login error: " + err); return false; }
}

async function getReplies(page: any, tweetUrl: string): Promise<Comment[]> {
  try {
    // Scroll down to load replies
    await page.evaluate(() => window.scrollBy(0, 3000));
    await page.waitForTimeout(2000);

    return await page.evaluate((url: string) => {
      const results: { author: string; text: string; url: string }[] = [];
      const seen = new Set<string>();

      // All articles after the first one (main tweet) are replies
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

      for (let i = 1; i < articles.length; i++) {
        const article = articles[i];

        // Author
        let author = "Unknown";
        const nameEl = article.querySelector('[data-testid="User-Name"] a span');
        if (nameEl) author = nameEl.textContent?.trim() || "Unknown";

        // Reply text
        let text = "";
        const tweetText = article.querySelector('[data-testid="tweetText"]');
        if (tweetText) text = tweetText.textContent?.trim() || "";

        if (!text) continue;

        // Reply URL
        let replyUrl = url;
        const timeLink = article.querySelector('a[href*="/status/"] time');
        if (timeLink) {
          const parent = timeLink.closest('a') as HTMLAnchorElement;
          if (parent?.href) replyUrl = parent.href;
        }

        const key = `${author}:${text.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({ author, text, url: replyUrl });
      }

      return results;
    }, tweetUrl);
  } catch (err) {
    logger.error("Reply extraction error: " + err);
    return [];
  }
}

async function scrapeAccount(page: any, accountInput: string, progress: Record<string, string[]>): Promise<Post[]> {
  const username = accountInput.replace(/https?:\/\/(www\.)?(twitter|x)\.com\//i, "").replace(/\/$/, "").replace(/^@/, "").trim();
  const profileUrl = `https://x.com/${username}`;

  logger.info(`\n🐦 Twitter: @${username}`);
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  let displayName = username;
  try { displayName = (await page.locator('[data-testid="UserName"] span').first().textContent({ timeout: 3000 })) ?? username; displayName = displayName.trim(); } catch { /* ignore */ }

  const tweetUrls = new Set<string>();
  let lastHeight = 0;
  let noNewCount = 0;

  logger.info(`  🔍 Tweet URLs collect করছি...`);
  while (true) {
    const links = await page.locator('a[href*="/status/"]').all();
    for (const link of links) {
      const href = await link.getAttribute("href") ?? "";
      if (href.includes("/status/")) tweetUrls.add(href);
    }
    if (MAX_POSTS > 0 && tweetUrls.size >= MAX_POSTS) break;
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(2000);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastHeight) { noNewCount++; if (noNewCount >= 4) break; } else { noNewCount = 0; lastHeight = h; }
  }

  logger.info(`  📋 ${tweetUrls.size}টি tweet URL পাওয়া গেছে`);

  const posts: Post[] = [];
  let postIndex = 1;

  for (const href of tweetUrls) {
    if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
    const match = href.match(/\/status\/(\d+)/);
    const tweetId = match?.[1] ?? "";
    if (!tweetId || isSaved(progress, username, tweetId)) continue;

    const tweetUrl = `https://x.com${href}`;
    try {
      await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(3000);

      let caption = "";
      try { caption = (await page.locator('[data-testid="tweetText"]').first().textContent({ timeout: 2000 })) ?? ""; caption = caption.trim(); } catch { /* ignore */ }

      let postDate = toDateStr(new Date().toISOString());
      try { const dt = await page.locator("time").first().getAttribute("datetime"); if (dt) postDate = toDateStr(dt); } catch { /* ignore */ }

      if (!isWithinDays(postDate, DAYS_BACK)) {
        logger.info(`    ⏭️ Too old (${postDate}), stopping`);
        break;
      }

      const folder = makeFolder(OUTPUT_DIR, "twitter", sanitize(displayName));
      const post: Post = { id: tweetId, platform: "twitter", source: displayName, caption: caption || "(No text)", url: tweetUrl, postDate, createdTime: new Date().toISOString() };

      saveCaptionFile(folder, post, tweetId);
      const ssOk = await takeScreenshot(page, screenshotPath(folder, postDate, tweetId));

      if (ssOk) {
        markSaved(progress, username, tweetId);
        saveProgress(progress);
        posts.push(post);
        postIndex++;
        logger.info(`    ✓ [${postIndex - 1}] ${caption.slice(0, 50) || tweetId} | screenshot ✓`);
      } else {
        logger.warn(`    ⚠️ Caption saved but screenshot FAILED for ${tweetId}`);
      }
    } catch (err) { logger.warn(`    ⚠️ Skip: ${tweetId} — ${err}`); }
  }
  return posts;
}

async function run() {
  if (!EMAIL || !PASSWORD) { logger.error(".env-এ TWITTER_EMAIL এবং TWITTER_PASSWORD দাও!"); return; }
  if (ACCOUNTS.length === 0) { logger.error(".env-এ TWITTER_ACCOUNTS দাও!"); return; }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const progress = loadProgress();

  const browser = await chromium.launch({ headless: HEADLESS, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });

  const SESSION = path.join(process.cwd(), ".tw_session.json");
  try { if (fs.existsSync(SESSION)) { await context.addCookies(JSON.parse(fs.readFileSync(SESSION, "utf8"))); logger.info("💾 Session loaded"); } } catch { /* ignore */ }

  const page = await context.newPage();
  let loggedIn = false;

  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000);
    loggedIn = !page.url().includes("login");
    if (loggedIn) logger.info("✅ Existing session কাজ করছে");
  } catch { /* ignore */ }

  if (!loggedIn) {
    loggedIn = await login(page, EMAIL, PASSWORD, TWITTER_USERNAME);
    if (loggedIn) fs.writeFileSync(SESSION, JSON.stringify(await context.cookies(), null, 2));
  }

  if (!loggedIn) { logger.error("❌ Login হয়নি"); await browser.close(); return; }

  let total = 0;
  for (const account of ACCOUNTS) {
    try { const posts = await scrapeAccount(page, account, progress); total += posts.length; logger.info(`  ✅ ${account}: ${posts.length}টি`); }
    catch (err) { logger.error(`  ❌ Error [${account}]: ${err}`); }
  }

  await browser.close();
  logger.info(`\n🎉 Twitter Agent সম্পন্ন! মোট ${total}টি post`);
}

logger.info("╔══════════════════════════════════════╗");
logger.info("║     🐦  Twitter Agent                ║");
logger.info("╚══════════════════════════════════════╝");

const args = process.argv.slice(2);
if (args.includes("--schedule")) {
  logger.info(`⏰ Scheduler: ${CRON}`);
  cron.schedule(CRON, () => run().catch(e => logger.error("Error: " + e)));
  process.stdin.resume();
} else {
  run().catch(e => { logger.error("Fatal: " + e); process.exit(1); });
}
