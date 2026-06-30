// src/index.ts — YouTube Agent
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as cron from "node-cron";
import axios from "axios";
import { chromium } from "playwright";
import { getLogger, sanitize, toDateStr, makeFolder, saveCaptionFile, screenshotPath, loadProgress, saveProgress, isSaved, markSaved } from "./helpers";
import { takeScreenshot } from "./screenshot";
import type { Post, Comment } from "./types";

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "C:\\screenshots";
const API_KEY    = process.env.YOUTUBE_API_KEY ?? "";
const CHANNELS   = (process.env.YOUTUBE_CHANNELS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const HEADLESS   = (process.env.HEADLESS ?? "false").toLowerCase() !== "false";
const MAX_POSTS  = parseInt(process.env.MAX_POSTS ?? "0") || 0;
const CRON       = process.env.CRON_SCHEDULE ?? "0 8 * * *";
const YT         = "https://www.googleapis.com/youtube/v3";

const LOG_FILE = path.join(OUTPUT_DIR, "..", "logs", "youtube-agent.log");
const logger = getLogger(LOG_FILE);

async function expandComments(page: any): Promise<void> {
  // Scroll down to trigger comment section loading
  await page.evaluate(() => window.scrollBy(0, 4000));
  await page.waitForTimeout(3000);

  for (let i = 0; i < 5; i++) {
    let expanded = false;
    for (const sel of [
      'ytd-button-renderer#more-replies button',
      'yt-next-continuation button',
      'paper-button:has-text("Show more replies")',
      '#continuation button',
    ]) {
      try {
        const btns = await page.locator(sel).all();
        for (const btn of btns) {
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click();
            await page.waitForTimeout(2000);
            expanded = true;
          }
        }
      } catch { /* ignore */ }
    }
    if (!expanded) break;
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(1000);
  }
}

async function getComments(page: any, videoUrl: string): Promise<Comment[]> {
  try {
    return await page.evaluate((vUrl: string) => {
      const results: { author: string; text: string; url: string }[] = [];
      const seen = new Set<string>();

      // YouTube comments are in ytd-comment-thread-renderer elements
      const commentEls = Array.from(document.querySelectorAll(
        'ytd-comment-thread-renderer, ytd-comment-renderer'
      ));

      for (const el of commentEls) {
        // Author
        let author = "Unknown";
        const authorEl = el.querySelector('#author-text span, #author-text, a.yt-simple-endpoint#author-text');
        if (authorEl) author = authorEl.textContent?.trim() || "Unknown";

        // Comment text
        let text = "";
        const contentEl = el.querySelector('#content-text, yt-formatted-string#content-text');
        if (contentEl) text = contentEl.textContent?.trim() || "";

        if (!text) continue;

        // Comment URL: YouTube doesn't have direct comment URLs easily accessible
        // Use the video URL with a note
        let commentUrl = vUrl;
        const timeEl = el.querySelector('a.yt-simple-endpoint[href*="lc="]');
        if (timeEl) {
          commentUrl = (timeEl as HTMLAnchorElement).href;
        }

        const key = `${author}:${text.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({ author, text, url: commentUrl });
      }

      return results;
    }, videoUrl);
  } catch (err) {
    logger.error("Comment extraction error: " + err);
    return [];
  }
}

async function scrapeWithApi(channelInput: string, page: any, progress: Record<string, string[]>): Promise<Post[]> {
  const clean = channelInput.replace(/https?:\/\/(www\.)?youtube\.com\/(channel\/|@)?/i, "").replace(/\/$/, "").trim();
  let channelId = "";
  let channelName = clean;

  if (/^UC[\w-]{22}$/.test(clean)) { channelId = clean; }
  else {
    try {
      const handle = clean.replace(/^@/, "");
      const { data } = await axios.get(`${YT}/channels`, { params: { key: API_KEY, forHandle: handle, part: "id,snippet" }, timeout: 10000 });
      channelId = data?.items?.[0]?.id ?? "";
      channelName = data?.items?.[0]?.snippet?.title ?? clean;
    } catch (err) { logger.error("Channel resolve error: " + err); }
  }

  if (!channelId) { logger.error("Channel ID পাওয়া যায়নি: " + channelInput); return []; }

  const posts: Post[] = [];
  let pageToken = "";
  let postIndex = 1;

  while (true) {
    const params: Record<string, string> = { key: API_KEY, channelId, part: "snippet", order: "date", type: "video", maxResults: "50" };
    if (pageToken) params.pageToken = pageToken;

    const { data } = await axios.get(`${YT}/search`, { params, timeout: 20000 });
    const items = data?.items ?? [];

    for (const item of items) {
      if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
      const videoId = item.id?.videoId ?? "";
      if (!videoId || isSaved(progress, channelName, videoId)) continue;
      const sn = item.snippet ?? {};
      const postDate = toDateStr(sn.publishedAt ?? "");
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const caption = `${sn.title ?? ""}\n\n${(sn.description ?? "").slice(0, 500)}`;

      let comments: Comment[] = [];
      try {
        await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(4000);
        await expandComments(page);
        comments = await getComments(page, videoUrl);
      } catch { /* ignore */ }

      const folder = makeFolder(OUTPUT_DIR, "youtube", sanitize(channelName));
      const post: Post = { id: videoId, platform: "youtube", source: channelName, caption, url: videoUrl, postDate, createdTime: sn.publishedAt ?? new Date().toISOString(), comments };

      saveCaptionFile(folder, post, videoId);
      const ssOk = await takeScreenshot(page, screenshotPath(folder, postDate, videoId));

      if (ssOk) {
        markSaved(progress, channelName, videoId);
        saveProgress(progress);
        posts.push(post);
        postIndex++;
        logger.info(`    ✓ [${postIndex - 1}] ${sn.title?.slice(0, 60)} | ${comments.length} comments | screenshot ✓`);
      } else {
        logger.warn(`    ⚠️ Caption saved but screenshot FAILED for ${videoId}`);
      }
    }

    if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
    pageToken = data?.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return posts;
}

async function scrapeWithBrowser(channelInput: string, page: any, progress: Record<string, string[]>): Promise<Post[]> {
  const handle = channelInput.replace(/https?:\/\/(www\.)?youtube\.com\//i, "").replace(/\/$/, "").trim();
  const channelUrl = handle.startsWith("@") ? `https://www.youtube.com/${handle}/videos` : `https://www.youtube.com/@${handle}/videos`;

  await page.goto(channelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);

  // Cookie popup
  try {
    const btn = page.locator('button:has-text("Accept all")').first();
    if (await btn.isVisible({ timeout: 2000 })) await btn.click();
  } catch { /* ignore */ }

  let channelName = handle;
  try { channelName = (await page.locator("ytd-channel-name #text, #channel-name yt-formatted-string").first().textContent({ timeout: 3000 })) ?? handle; channelName = channelName.trim(); } catch { /* ignore */ }

  const videoUrls = new Set<string>();
  let lastHeight = 0;
  let noNewCount = 0;

  logger.info(`  🔍 Video URLs collect করছি...`);
  while (true) {
    const links = await page.locator('a#video-title-link[href*="/watch"], a#thumbnail[href*="/watch"]').all();
    for (const link of links) {
      const href = await link.getAttribute("href") ?? "";
      if (href.includes("/watch?v=")) videoUrls.add(href);
    }
    if (MAX_POSTS > 0 && videoUrls.size >= MAX_POSTS) break;
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(2000);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastHeight) { noNewCount++; if (noNewCount >= 4) break; } else { noNewCount = 0; lastHeight = h; }
  }

  logger.info(`  📋 ${videoUrls.size}টি video পাওয়া গেছে`);

  const posts: Post[] = [];
  let postIndex = 1;

  for (const href of videoUrls) {
    if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
    const match = href.match(/v=([^&]+)/);
    const videoId = match?.[1] ?? "";
    if (!videoId || isSaved(progress, channelName, videoId)) continue;

    const videoUrl = `https://www.youtube.com${href}`;
    try {
      await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(4000);

      let title = "";
      try { title = (await page.locator("h1.ytd-watch-metadata yt-formatted-string").first().textContent({ timeout: 3000 })) ?? ""; title = title.trim(); } catch { /* ignore */ }

      await expandComments(page);
      const comments = await getComments(page, videoUrl);

      const postDate = toDateStr(new Date().toISOString());
      const folder = makeFolder(OUTPUT_DIR, "youtube", sanitize(channelName));
      const post: Post = { id: videoId, platform: "youtube", source: channelName, caption: title || videoId, url: videoUrl, postDate, createdTime: new Date().toISOString(), comments };

      saveCaptionFile(folder, post, videoId);
      const ssOk = await takeScreenshot(page, screenshotPath(folder, postDate, videoId));

      if (ssOk) {
        markSaved(progress, channelName, videoId);
        saveProgress(progress);
        posts.push(post);
        postIndex++;
        logger.info(`    ✓ [${postIndex - 1}] ${title.slice(0, 60)} | ${comments.length} comments | screenshot ✓`);
      } else {
        logger.warn(`    ⚠️ Caption saved but screenshot FAILED for ${videoId}`);
      }
    } catch (err) { logger.warn(`    ⚠️ Skip: ${videoId} — ${err}`); }
  }
  return posts;
}

async function run() {
  if (CHANNELS.length === 0) { logger.error(".env-এ YOUTUBE_CHANNELS দাও!"); return; }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const progress = loadProgress();

  const browser = await chromium.launch({ headless: HEADLESS, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });
  const page = await context.newPage();

  let total = 0;
  for (const channel of CHANNELS) {
    logger.info(`\n🔴 YouTube: ${channel}`);
    try {
      const posts = API_KEY
        ? await scrapeWithApi(channel, page, progress)
        : await scrapeWithBrowser(channel, page, progress);
      total += posts.length;
      logger.info(`  ✅ ${channel}: ${posts.length}টি video`);
    } catch (err) { logger.error(`  ❌ Error [${channel}]: ${err}`); }
  }

  await browser.close();
  logger.info(`\n🎉 YouTube Agent সম্পন্ন! মোট ${total}টি video`);
}

logger.info("╔══════════════════════════════════════╗");
logger.info("║     🔴  YouTube Agent                ║");
logger.info("╚══════════════════════════════════════╝");

const args = process.argv.slice(2);
if (args.includes("--schedule")) {
  logger.info(`⏰ Scheduler: ${CRON}`);
  cron.schedule(CRON, () => run().catch(e => logger.error("Error: " + e)));
  process.stdin.resume();
} else {
  run().catch(e => { logger.error("Fatal: " + e); process.exit(1); });
}
