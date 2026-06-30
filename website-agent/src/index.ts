// src/index.ts — Website Agent
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as cron from "node-cron";
import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { chromium } from "playwright";
import { getLogger, sanitize, toDateStr, makeFolder, saveCaptionFile, screenshotPath, loadProgress, saveProgress, isSaved, markSaved, isWithinDays } from "./helpers";
import { takeScreenshot } from "./screenshot";
import type { Post, Comment } from "./types";

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "C:\\screenshots";
const WEBSITES   = (process.env.WEBSITES ?? "").split(",").map(s => s.trim()).filter(Boolean);
const HEADLESS   = (process.env.HEADLESS ?? "false").toLowerCase() !== "false";
const MAX_POSTS  = parseInt(process.env.MAX_POSTS ?? "0") || 0;
const DAYS_BACK  = parseInt(process.env.DAYS_BACK ?? "7") || 7;
const CRON       = process.env.CRON_SCHEDULE ?? "0 8 * * *";
const UA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

const LOG_FILE = path.join(OUTPUT_DIR, "..", "logs", "website-agent.log");
const logger = getLogger(LOG_FILE);
const rssParser = new Parser({ timeout: 20000 });

function getSiteName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

async function findRss(siteUrl: string): Promise<string | null> {
  const candidates = [`${siteUrl}/feed`, `${siteUrl}/rss`, `${siteUrl}/feed.xml`, `${siteUrl}/rss.xml`, `${siteUrl}/atom.xml`];
  for (const u of candidates) {
    try { const r = await axios.head(u, { timeout: 4000 }); if (r.status < 400) return u; } catch { /* try next */ }
  }
  try {
    const { data } = await axios.get(siteUrl, { headers: { "User-Agent": UA }, timeout: 10000 });
    const $ = cheerio.load(data);
    const link = $('link[type="application/rss+xml"], link[type="application/atom+xml"]').attr("href");
    if (link) return link.startsWith("http") ? link : `${new URL(siteUrl).origin}${link}`;
  } catch { /* ignore */ }
  return null;
}

async function getPageComments(page: any, articleUrl: string): Promise<Comment[]> {
  try {
    return await page.evaluate((url: string) => {
      const results: { author: string; text: string; url: string }[] = [];
      const seen = new Set<string>();

      // Common comment section selectors across news/blog sites
      const commentEls = Array.from(document.querySelectorAll(
        '.comment, .comment-body, [class*="comment-content"], ' +
        '#comments li, .comments-list > div, .comment-item, ' +
        '[itemprop="comment"], .disqus-comment-body'
      ));

      for (const el of commentEls) {
        // Author
        let author = "Unknown";
        const authorEl = el.querySelector(
          '.comment-author, .author, [class*="comment-author"], ' +
          '[itemprop="author"], .fn, .username, b, strong'
        );
        if (authorEl) author = authorEl.textContent?.trim() || "Unknown";

        // Comment text
        let text = "";
        const textEl = el.querySelector(
          '.comment-text, .comment-content, [class*="comment-body"], ' +
          '[itemprop="text"], p'
        );
        if (textEl) text = textEl.textContent?.trim() || "";

        if (!text || text.length < 5) continue;

        const key = `${author}:${text.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({ author, text, url });
      }

      return results;
    }, articleUrl);
  } catch {
    return [];
  }
}

async function scrapeWebsite(siteUrl: string, page: any, progress: Record<string, string[]>): Promise<Post[]> {
  const siteName = getSiteName(siteUrl);
  logger.info(`\n🌐 Website: ${siteName}`);

  const posts: Post[] = [];
  let postIndex = 1;

  const rssUrl = await findRss(siteUrl);

  if (rssUrl) {
    logger.info(`  📡 RSS: ${rssUrl}`);
    const feed = await rssParser.parseURL(rssUrl);

    for (const item of feed.items ?? []) {
      if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
      const postId = item.link ?? item.guid ?? item.title ?? "";
      if (!postId || isSaved(progress, siteName, postId)) continue;

      const postDate = toDateStr(item.pubDate ?? item.isoDate ?? "");
      if (!isWithinDays(postDate, DAYS_BACK)) {
        logger.info(`    ⏭️ Too old (${postDate}), stopping`);
        break;
      }
      const title = item.title ?? "";
      const desc = cheerio.load(item.contentSnippet ?? item.content ?? "").text().trim().slice(0, 400);
      const caption = desc && desc !== title ? `${title}\n\n${desc}` : title;
      const url = item.link ?? siteUrl;

      let ssOk = false;

      if (url) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(3000);

          const folder = makeFolder(OUTPUT_DIR, "website", sanitize(siteName));
          const cleanPostId = sanitize(postId);
          const post: Post = { id: postId, platform: "website", source: siteName, caption, url, postDate, createdTime: item.isoDate ?? new Date().toISOString() };

          saveCaptionFile(folder, post, cleanPostId);
          ssOk = await takeScreenshot(page, screenshotPath(folder, postDate, cleanPostId));

          if (ssOk) {
            markSaved(progress, siteName, postId);
            saveProgress(progress);
            posts.push(post);
            postIndex++;
            logger.info(`    ✓ [${postIndex - 1}] ${title.slice(0, 60)} | screenshot ✓`);
          } else {
            logger.warn(`    ⚠️ Caption saved but screenshot FAILED for ${title.slice(0, 40)}`);
          }
        } catch (err) {
          logger.warn(`    ⚠️ Error loading ${url}: ${err}`);
        }
      }
    }
  } else {
    logger.info(`  🔍 RSS নেই — HTML scraping`);
    const { data: html } = await axios.get(siteUrl, { headers: { "User-Agent": UA }, timeout: 20000 });
    const $ = cheerio.load(html);
    const articles = $("article, .post, .news-item, .entry, .article-card");

    for (let i = 0; i < articles.length; i++) {
      if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
      const el = articles.eq(i);
      const title = el.find("h1, h2, h3, h4").first().text().trim();
      if (!title) continue;
      const href = el.find("a[href]").first().attr("href") ?? "";
      const url = href.startsWith("http") ? href : href ? new URL(href, siteUrl).href : siteUrl;
      if (isSaved(progress, siteName, url)) continue;

      const summary = el.find("p").first().text().trim().slice(0, 300);
      const caption = summary && summary !== title ? `${title}\n\n${summary}` : title;
      const postDate = toDateStr(new Date().toISOString());

      if (url) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(3000);

          const folder = makeFolder(OUTPUT_DIR, "website", sanitize(siteName));
          const cleanPostId = sanitize(url);
          const post: Post = { id: url, platform: "website", source: siteName, caption, url, postDate, createdTime: new Date().toISOString() };

          saveCaptionFile(folder, post, cleanPostId);
          const ssOk = await takeScreenshot(page, screenshotPath(folder, postDate, cleanPostId));

          if (ssOk) {
            markSaved(progress, siteName, url);
            saveProgress(progress);
            posts.push(post);
            postIndex++;
            logger.info(`    ✓ [${postIndex - 1}] ${title.slice(0, 60)} | screenshot ✓`);
          } else {
            logger.warn(`    ⚠️ Caption saved but screenshot FAILED for ${title.slice(0, 40)}`);
          }
        } catch (err) {
          logger.warn(`    ⚠️ Error loading ${url}: ${err}`);
        }
      }
    }
  }

  logger.info(`  ✅ ${siteName}: ${posts.length}টি article`);
  return posts;
}

async function run() {
  if (WEBSITES.length === 0) { logger.error(".env-এ WEBSITES দাও!"); return; }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const progress = loadProgress();

  const browser = await chromium.launch({ headless: HEADLESS, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: UA });
  const page = await context.newPage();

  let total = 0;
  for (const siteUrl of WEBSITES) {
    try { const posts = await scrapeWebsite(siteUrl, page, progress); total += posts.length; }
    catch (err) { logger.error(`  ❌ Error [${siteUrl}]: ${err}`); }
  }

  await browser.close();
  logger.info(`\n🎉 Website Agent সম্পন্ন! মোট ${total}টি article`);
}

logger.info("╔══════════════════════════════════════╗");
logger.info("║     🌐  Website Agent                ║");
logger.info("╚══════════════════════════════════════╝");

const args = process.argv.slice(2);
if (args.includes("--schedule")) {
  logger.info(`⏰ Scheduler: ${CRON}`);
  cron.schedule(CRON, () => run().catch(e => logger.error("Error: " + e)));
  process.stdin.resume();
} else {
  run().catch(e => { logger.error("Fatal: " + e); process.exit(1); });
}
