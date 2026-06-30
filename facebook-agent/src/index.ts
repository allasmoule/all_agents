// src/index.ts — Facebook Agent
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
const EMAIL = process.env.FACEBOOK_EMAIL ?? "";
const PASSWORD = process.env.FACEBOOK_PASSWORD ?? "";
const PAGES = (process.env.FACEBOOK_PAGES ?? "").split(",").map(s => s.trim()).filter(Boolean);
const HEADLESS = (process.env.HEADLESS ?? "false").toLowerCase() !== "false";
const MAX_POSTS = parseInt(process.env.MAX_POSTS ?? "0") || 0;
const CRON = process.env.CRON_SCHEDULE ?? "0 8 * * *";

const LOG_FILE = path.join(OUTPUT_DIR, "..", "logs", "facebook-agent.log");
const logger = getLogger(LOG_FILE);

async function login(page: any, email: string, password: string): Promise<boolean> {
  logger.info("🔐 Facebook login করছি...");
  try {
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Cookie popup dismiss
    for (const sel of [
      '[data-cookiebanner="accept_button"]',
      'button[data-testid="cookie-policy-manage-dialog-accept-button"]',
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
    ]) {
      try {
        const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 1000 })) { await b.click(); await page.waitForTimeout(1000); break; }
      } catch { /* ignore */ }
    }

    // Email field
    let emailField = page.locator("#email").first();
    if (!(await emailField.isVisible({ timeout: 2000 }).catch(() => false))) {
      emailField = page.locator('input[name="email"]').first();
    }
    await emailField.waitFor({ state: "visible", timeout: 10000 });
    await emailField.fill(email);
    await page.waitForTimeout(500);

    // Password field
    let passField = page.locator("#pass").first();
    if (!(await passField.isVisible({ timeout: 2000 }).catch(() => false))) {
      passField = page.locator('input[name="pass"], input[type="password"]').first();
    }
    await passField.waitFor({ state: "visible", timeout: 10000 });
    await passField.fill(password);
    await page.waitForTimeout(500);

    // Login button
    let clicked = false;
    for (const sel of ['button[name="login"]', 'button[type="submit"]', '[data-testid="royal_login_button"]', 'button:has-text("Log in")', 'button:has-text("Log In")']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click(); clicked = true; break; } } catch { /* try next */ }
    }
    if (!clicked) { await passField.press("Enter"); }

    await page.waitForTimeout(8000);
    const url = page.url();

    const stillOnLogin = await page.locator("#email").first().isVisible({ timeout: 2000 }).catch(() => false) ||
      await page.locator('input[name="email"]').first().isVisible({ timeout: 2000 }).catch(() => false);

    if (!stillOnLogin && url.includes("facebook.com") && !url.includes("login")) { logger.info("✅ Login সফল!"); return true; }
    if (url.includes("checkpoint") || url.includes("challenge")) {
      logger.warn("⚠️  2FA/Checkpoint — ৪৫ সেকেন্ড সময় দিচ্ছি...");
      await page.waitForTimeout(45000);
      return !page.url().includes("login");
    }
    logger.error("❌ Login failed. URL: " + url);
    return false;
  } catch (err) { logger.error("Login error: " + err); return false; }
}

async function collectPostUrls(page: any, pageUrl: string, username: string, progress: Record<string, string[]>): Promise<{ id: string; url: string; postDate: string }[]> {
  // Page already navigated by caller, no need to goto again
  await page.waitForTimeout(2000);

  const collected: { id: string; url: string; postDate: string }[] = [];
  const seenIds = new Set<string>();
  let lastHeight = 0;
  let noNewCount = 0;

  const processedCount = progress[username] ? progress[username].length : 0;
  const isFirstRun = processedCount < 10;
  let limit = isFirstRun ? (10 - processedCount) : (MAX_POSTS > 0 ? MAX_POSTS : 99999);
  if (MAX_POSTS > 0 && MAX_POSTS < limit) limit = MAX_POSTS;

  logger.info(`  🔍 Post URLs scan করছি: ${pageUrl}`);

  let shouldStop = false;

  while (true) {
    const links = await page.locator('a[href*="/posts/"], a[href*="story_fbid="], a[href*="permalink/"]').all();

    for (const link of links) {
      if (collected.length >= limit) { shouldStop = true; break; }
      try {
        const href = await link.getAttribute("href") ?? "";
        if (!href || (!href.includes("/posts/") && !href.includes("story_fbid=") && !href.includes("permalink/"))) continue;
        const fullUrl = href.startsWith("http") ? href : `https://www.facebook.com${href}`;
        const match = href.match(/(?:posts\/|story_fbid=|permalink\/)([A-Za-z0-9_\-]+)/);
        if (!match) continue;
        const postId = `${username}_${match[1]}`;

        if (seenIds.has(postId)) continue;
        seenIds.add(postId);

        const saved = isSaved(progress, username, postId);
        if (saved && !isFirstRun && seenIds.size > 1) {
          logger.info(`    ℹ️ Already saved post: ${postId}. Stopping.`);
          shouldStop = true;
          break;
        }

        if (!saved) {
          let postDate = toDateStr(new Date().toISOString());
          try {
            const art = link.locator("xpath=ancestor::div[@role='article']").first();
            const utime = await art.locator("abbr[data-utime]").first().getAttribute("data-utime");
            const dt = await art.locator("time").first().getAttribute("datetime");
            if (utime) postDate = toDateStr(new Date(parseInt(utime) * 1000).toISOString());
            else if (dt) postDate = toDateStr(dt);
          } catch { /* ignore */ }

          collected.push({ id: postId, url: fullUrl, postDate });
          logger.info(`    📌 [${collected.length}] Found: ${postId}`);
          if (collected.length >= limit) { shouldStop = true; break; }
        }
      } catch { /* skip */ }
    }

    if (shouldStop) break;
    try {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await page.waitForTimeout(3000);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === lastHeight) { noNewCount++; if (noNewCount >= 4) break; } else { noNewCount = 0; lastHeight = h; }
    } catch { break; }
  }

  logger.info(`  ✅ Scan সম্পন্ন — ${collected.length}টি new post`);
  return collected;
}

async function getFullCaption(page: any): Promise<string> {
  try {
    for (const sel of ['div[role="button"]:has-text("See more")', 'div[role="button"]:has-text("আরও দেখুন")', 'span:has-text("See more")']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 800 })) { await b.click(); await page.waitForTimeout(600); break; } } catch { /* ignore */ }
    }

    let best = "";
    for (const sel of ['[data-ad-comet-preview="message"]', '[data-ad-preview="message"]', 'div[dir="auto"]']) {
      try {
        const els = await page.locator(sel).all();
        for (const el of els) {
          const txt = ((await el.textContent({ timeout: 800 })) ?? "").trim();
          if (txt.length > best.length) best = txt;
        }
      } catch { /* ignore */ }
    }
    return best;
  } catch { return ""; }
}

async function expandComments(page: any): Promise<void> {
  logger.info("  💬 Expanding all comments...");
  let totalExpanded = 0;

  for (let attempt = 0; attempt < 15; attempt++) {
    let expandedAny = false;

    for (const sel of [
      'span:has-text("View more comments")',
      'span:has-text("View previous comments")',
      'span:has-text("See more replies")',
      'span:has-text("আরও মন্তব্য দেখুন")',
      'span:has-text("পূর্ববর্তী মন্তব্য দেখুন")',
      'div[role="button"]:has-text("View more comments")',
      'div[role="button"]:has-text("View previous comments")',
      'div[role="button"]:has-text("See more replies")',
      'div[role="button"]:has-text("আরও মন্তব্য দেখুন")',
      'span:has-text("View all")',
      'span:has-text("View")',
    ]) {
      try {
        const btns = await page.locator(sel).all();
        for (const btn of btns) {
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click();
            await page.waitForTimeout(1500);
            expandedAny = true;
            totalExpanded++;
          }
        }
      } catch { /* ignore */ }
    }

    // Also scroll down inside the page to trigger lazy load
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(1000);

    if (!expandedAny) break;
  }
  logger.info(`  💬 Comments expanded: ${totalExpanded} clicks`);
}

async function getComments(page: any): Promise<Comment[]> {
  logger.info("  💬 Extracting comments...");
  try {
    const comments: Comment[] = await page.evaluate(() => {
      const results: { author: string; text: string; url: string }[] = [];
      const seen = new Set<string>();

      // Strategy 1: Find comment containers by role="article" inside the comments section
      const articles = Array.from(document.querySelectorAll('div[role="article"]'));

      for (const article of articles) {
        // Skip the main post article (usually the first one or has specific structure)
        const isMainPost = article.querySelector('div[data-ad-comet-preview="message"]') ||
          article.querySelector('div[data-ad-preview="message"]');
        if (isMainPost) continue;

        // Author: first link with user profile
        let author = "Unknown";
        const profileLinks = Array.from(article.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        for (const pl of profileLinks) {
          const href = pl.href;
          if (href.includes("/comment") || href.includes("story_fbid") || href.includes("/posts/")) continue;
          if (href.includes("facebook.com/") && !href.includes("/groups/")) {
            const txt = pl.textContent?.trim();
            if (txt && txt.length > 0 && txt.length < 80) { author = txt; break; }
          }
        }

        // Comment text: dir="auto" spans, skip author name and action words
        let commentText = "";
        const textEls = Array.from(article.querySelectorAll('span[dir="auto"], div[dir="auto"]'));
        for (const el of textEls) {
          const txt = el.textContent?.trim() || "";
          if (!txt || txt === author) continue;
          if (["Like", "Reply", "Share", "Translate", "Write a reply...", "See translation", "Most relevant"].includes(txt)) continue;
          if (txt.match(/^\d+[wdhms]$/) || txt.match(/^\d+\s*(?:wk|day|hr|min|sec|week|month|year)s?\b/i)) continue;
          if (txt.length > commentText.length) commentText = txt;
        }

        if (!commentText) continue;

        // Comment URL: look for time links or any link with comment-related href
        let commentUrl = "";
        for (const pl of profileLinks) {
          if (pl.href.includes("comment_id=") || pl.href.includes("/comment/")) {
            commentUrl = pl.href;
            break;
          }
        }
        // Fallback: use aria-label time link
        if (!commentUrl) {
          const timeLink = article.querySelector('a[href*="comment_id="], a[role="link"] time');
          if (timeLink) {
            const parent = timeLink.closest('a');
            if (parent) commentUrl = (parent as HTMLAnchorElement).href;
          }
        }

        const key = `${author}:${commentText.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          author,
          text: commentText,
          url: commentUrl || window.location.href
        });
      }

      // Strategy 2: If no results from articles, try ul/li comment structure
      if (results.length === 0) {
        const commentItems = Array.from(document.querySelectorAll('ul > li'));
        for (const li of commentItems) {
          const spans = Array.from(li.querySelectorAll('span[dir="auto"]'));
          if (spans.length < 2) continue;

          let author = "Unknown";
          let text = "";
          for (const span of spans) {
            const t = span.textContent?.trim() || "";
            if (!t) continue;
            if (["Like", "Reply", "Share", "Translate"].includes(t)) continue;
            if (t.match(/^\d+[wdhms]$/)) continue;
            if (author === "Unknown" && t.length < 50) { author = t; continue; }
            if (t.length > text.length) text = t;
          }

          if (text) {
            const key = `${author}:${text.slice(0, 50)}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push({ author, text, url: window.location.href });
            }
          }
        }
      }

      return results;
    });

    logger.info(`  💬 Found ${comments.length} comments`);
    return comments;
  } catch (err) {
    logger.error("Comment extraction error: " + err);
    return [];
  }
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
    const hasLogin = await page.locator("#email").first().isVisible({ timeout: 2000 }).catch(() => false);
    loggedIn = hasUser && !hasLogin && !page.url().includes("login");
    if (loggedIn) logger.info("✅ Existing session কাজ করছে");
  } catch { loggedIn = false; }

  if (!loggedIn) {
    await context.clearCookies();
    try { if (fs.existsSync(SESSION)) fs.unlinkSync(SESSION); } catch { /* ignore */ }
    loggedIn = await login(page, EMAIL, PASSWORD);
    if (loggedIn) fs.writeFileSync(SESSION, JSON.stringify(await context.cookies(), null, 2));
  }

  if (!loggedIn) { logger.error("❌ Login হয়নি"); await browser.close(); return; }

  const allPosts: Post[] = [];

  for (const pageInput of PAGES) {
    const username = pageInput.replace(/https?:\/\/(www\.)?facebook\.com\//i, "").replace(/\/$/, "").trim();
    const pageUrl = `https://www.facebook.com/${username}`;
    logger.info(`\n🔵 Facebook page: ${username}`);

    try {
      try {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch {
        // Facebook often aborts initial navigation with redirects, try again with load
        await page.goto(pageUrl, { waitUntil: "load", timeout: 30000 });
      }
      await page.waitForTimeout(4000);
      let pageName = username;
      try { const h1 = await page.locator("h1").first().textContent({ timeout: 3000 }); if (h1) pageName = h1.trim(); } catch { /* ignore */ }

      const infos = await collectPostUrls(page, pageUrl, username, progress);
      if (infos.length === 0) { logger.info("  ℹ️  কোনো নতুন post নেই"); continue; }

      logger.info(`  📸 ${infos.length}টি post processing শুরু...`);

      for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        logger.info(`  [${i + 1}/${infos.length}] Opening: ${info.url}`);
        try {
          try {
            await page.goto(info.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          } catch {
            await page.goto(info.url, { waitUntil: "load", timeout: 30000 });
          }
          await page.waitForTimeout(4000);

          const caption = await getFullCaption(page);

          const folder = makeFolder(OUTPUT_DIR, "facebook", sanitize(pageName));
          const post: Post = {
            id: info.id,
            platform: "facebook",
            source: pageName,
            caption: caption || "(Caption নেই)",
            url: info.url,
            postDate: info.postDate,
            createdTime: new Date().toISOString(),
          };

          saveCaptionFile(folder, post, info.id);
          const ssOk = await takeScreenshot(page, screenshotPath(folder, info.postDate, info.id), true);

          if (ssOk) {
            markSaved(progress, username, info.id);
            saveProgress(progress);
            allPosts.push(post);
            logger.info(`    ✓ Done: ${caption.slice(0, 60) || info.id} | screenshot ✓`);
          } else {
            logger.warn(`    ⚠️ Caption saved but screenshot FAILED for ${info.id} — will retry next run`);
          }
        } catch (err) { logger.warn(`    ⚠️ Skip: ${info.id} — ${err}`); }
      }
      logger.info(`  ✅ ${pageName}: সম্পন্ন`);
    } catch (err) { logger.error(`  ❌ Error [${username}]: ${err}`); }
  }

  await browser.close();
  logger.info(`\n🎉 Facebook Agent সম্পন্ন! মোট ${allPosts.length}টি post`);
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
