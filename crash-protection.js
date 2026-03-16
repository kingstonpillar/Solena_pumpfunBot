// crash-protection.js — PM2-friendly start/stop + hourly ping + memory cleanup
import fs from "fs";
import path from "path";
import process from "process";
import fetch from "node-fetch";

// === TELEGRAM CONFIG ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === LOG SETUP ===
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const LOG_FILE = path.join(LOG_DIR, "crash.log");
const COUNT_FILE = path.join(LOG_DIR, "restart-count.txt");

// === RESTART COUNT ===
let restartCount = 0;
if (fs.existsSync(COUNT_FILE)) {
  try {
    restartCount = parseInt(fs.readFileSync(COUNT_FILE, "utf8"), 10) || 0;
  } catch {}
}
restartCount += 1;
fs.writeFileSync(COUNT_FILE, String(restartCount), "utf8");

// === STATE ===
let started = false;
let startTimeMs = 0;
let pingTimer = null;
let pingTickRunning = false;
let uncaughtHandler = null;
let unhandledHandler = null;

// === HELPERS ===
function formatDuration(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hr = Math.floor(ms / (1000 * 60 * 60));
  return `${hr}h ${min}m ${sec}s`;
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: String(message),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("Failed to send Telegram message:", err?.message || err);
  }
}

function logError(type, error) {
  const uptime = formatDuration(Date.now() - startTimeMs);
  const entry = `[${new Date().toISOString()}] [${type}] [Uptime: ${uptime}] ${error?.stack || error}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
  console.error(entry);

  void sendTelegram(
    `⚠️ <b>[${type}] Bot error</b>\n` +
    `⏱️ Uptime before crash: <b>${uptime}</b>\n\n` +
    `${error?.message || error}`
  );
}

// === MEMORY CLEANUP & HOURLY PING ===
async function runPingTick(label) {
  if (pingTickRunning) return;
  pingTickRunning = true;

  try {
    const uptime = formatDuration(Date.now() - startTimeMs);
    let usedMB = process.memoryUsage().rss / 1024 / 1024;

    await sendTelegram(
      `⏱ <b>Hourly ping: Bot alive</b>\n` +
      `Uptime: <b>${uptime}</b>\n` +
      `Memory usage: <b>${usedMB.toFixed(2)} MB</b>`
    );

    if (usedMB > 700) {
      // Clear logs
      try { fs.writeFileSync(LOG_FILE, ""); } catch {}
      // Clear in-memory caches (update with your bot's cache variables)
      if (global.trackedMints) global.trackedMints.clear?.();
      if (global.retiredMints) global.retiredMints.clear?.();
      if (global.tokenCache) global.tokenCache.clear?.();

      // Force GC if Node started with --expose-gc
      if (global.gc) global.gc();

      usedMB = process.memoryUsage().rss / 1024 / 1024;

      await sendTelegram(
        `🧹 <b>Memory cleanup executed</b>\n` +
        `Memory after cleanup: <b>${usedMB.toFixed(2)} MB</b>\n` +
        `Logs and caches cleared`
      );

      console.log(`🧹 Cleanup done, memory now: ${usedMB.toFixed(2)} MB`);
    }

  } catch (err) {
    console.error(`[crash-protection] ${label} ping error:`, err?.message || err);
  } finally {
    pingTickRunning = false;
  }
}

// === PUBLIC API ===
export function startCrashProtection() {
  if (started) return;

  started = true;
  startTimeMs = Date.now();

  uncaughtHandler = (err) => logError("UncaughtException", err);
  unhandledHandler = (reason) => logError("UnhandledRejection", reason);

  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", unhandledHandler);

  void runPingTick("initial");

  pingTimer = setInterval(() => void runPingTick("interval"), 60 * 60 * 1000);

  console.log("✅ Crash protection enabled (hourly ping ON)");

  void sendTelegram(
    `🚀 <b>Bot started</b>\n` +
    `🕒 ${new Date().toISOString()}\n` +
    `🔄 Restart count: <b>${restartCount}</b>`
  );
}

export async function stopCrashProtection(reason = "manual") {
  if (!started) return;

  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

  while (pingTickRunning) { await new Promise(r => setTimeout(r, 200)); }

  if (uncaughtHandler) process.off("uncaughtException", uncaughtHandler);
  if (unhandledHandler) process.off("unhandledRejection", unhandledHandler);

  uncaughtHandler = null;
  unhandledHandler = null;
  started = false;

  console.log("🛑 Crash protection stopped", { reason });
  void sendTelegram(`🛑 <b>Crash protection stopped</b>\nReason: <code>${reason}</code>`);
}

export function protect() { startCrashProtection(); }

// === NODE DIRECT ENTRY ===
if (process.argv[1] === new URL(import.meta.url).pathname) {
  startCrashProtection();
}