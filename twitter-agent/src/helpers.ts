// src/helpers.ts
import * as fs from "fs";
import * as path from "path";
import { createLogger, format, transports } from "winston";
import type { Post } from "./types";

let _logger: ReturnType<typeof createLogger> | null = null;

export function getLogger(logFile: string) {
  if (_logger) return _logger;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  _logger = createLogger({
    level: "info",
    format: format.combine(
      format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [
      new transports.File({ filename: logFile }),
      new transports.Console({
        format: format.combine(format.colorize(), format.printf(({ level, message }) => `${level}: ${message}`))
      }),
    ],
  });
  return _logger;
}

export function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 80);
}

export function toDateStr(val: string): string {
  try { return new Date(val).toISOString().slice(0, 10); } catch { return new Date().toISOString().slice(0, 10); }
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function makeFolder(baseDir: string, platform: string, source: string): string {
  const folder = path.join(baseDir, sanitize(platform), sanitize(source));
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

export function saveCaptionFile(folder: string, post: Post, postId: string): string {
  const filepath = path.join(folder, `${post.postDate}_${postId}_caption.txt`);
  const lines = [
    `PLATFORM  : ${post.platform}`,
    `PAGE      : ${post.source}`,
    `DATE      : ${post.postDate}`,
    `POST LINK : ${post.url}`,
    `SAVED AT  : ${new Date().toISOString()}`,
    "─".repeat(60),
    "",
    post.caption,
    "",
  ];

  fs.writeFileSync(filepath, lines.join("\n"), "utf8");
  return filepath;
}

// Progress tracker — resume support
const PROGRESS_FILE = path.join(process.cwd(), ".progress.json");

export function loadProgress(): Record<string, string[]> {
  try { if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")); } catch { /* ignore */ }
  return {};
}

export function saveProgress(p: Record<string, string[]>): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

export function isSaved(p: Record<string, string[]>, key: string, id: string): boolean {
  return (p[key] ?? []).includes(id);
}

export function markSaved(p: Record<string, string[]>, key: string, id: string): void {
  if (!p[key]) p[key] = [];
  if (!p[key].includes(id)) p[key].push(id);
}

export function isWithinDays(dateStr: string, days: number): boolean {
  const postDate = new Date(dateStr);
  if (isNaN(postDate.getTime())) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return postDate >= cutoff;
}

export function screenshotPath(folder: string, postDate: string, postId: string): string {
  return path.join(folder, `${postDate}_${postId}_screenshot.png`);
}
