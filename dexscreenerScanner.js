// dexscreenerScanner.js
import axios from "axios";
import dotenv from "dotenv";
import bs58 from "bs58";
import { withHttpLimit } from "./httpLimiter.js";
import { checkPumpMigration } from "./checkPumpMigration.js";
import fs from "fs";

dotenv.config();

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 15000);
const CANDIDATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BLOCK_FAILED_MS = 5 * 60 * 1000; // 5 minutes block for failed tokens
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const CANDIDATES_FILE = process.env.BONDING_OUT_FILE || "./bonding_candidates.json";

let intervalHandle = null;

// -------------------- TELEGRAM --------------------
class Telegram {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async send(message) {
    if (!this.botToken || !this.chatId) return;
    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
      console.log("[Telegram] Sent message successfully");
    } catch (err) {
      console.error("[Telegram Error]", err.message || err);
    }
  }
}

const telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

// -------------------- MEMORY --------------------
const processedMints = new Map(); // mint -> timestamp processed
const failedMints = new Map();    // mint -> timestamp failed

// Clear processed tokens memory every 12 hours
setInterval(() => {
  processedMints.clear();
  console.log("[Scanner] Cleared processedMints memory after 12 hours");
}, TWELVE_HOURS_MS);

// Check if mint is blocked due to migration failure
function isBlocked(mint) {
  return failedMints.has(mint);
}

// -------------------- UTILS --------------------
function isValidSolanaMint(address) {
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

function saveToken(tokenData) {
  let existing = [];
  try {
    if (fs.existsSync(CANDIDATES_FILE)) {
      existing = JSON.parse(fs.readFileSync(CANDIDATES_FILE, "utf8") || "[]");
    }
  } catch (err) {
    console.error("[Scanner] Failed to read existing JSON:", err.message || err);
  }

  existing.push(tokenData);
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(existing, null, 2), "utf8");
  console.log(`[Scanner] Token saved to JSON: ${tokenData.mint}`);
}

// -------------------- SCANNER --------------------
async function fetchFreshPumpSwapPairs() {
  console.log("[Scanner] Fetching PumpSwap pairs from Dexscreener...");
  const url = "https://api.dexscreener.com/latest/dex/search/?q=solana";
  let data;

  try {
    const res = await withHttpLimit(() => axios.get(url, { timeout: 10000 }));
    data = res.data;
  } catch (err) {
    console.error("[Scanner] Dexscreener request failed:", err.message || err);
    return [];
  }

  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const now = Date.now();

  return pairs.filter(p => {
    if (p.chainId !== "solana") return false;
    if (String(p.dexId || "").toLowerCase() !== "pumpswap") return false;
    if (typeof p.baseToken?.address !== "string") return false;
    if (!isValidSolanaMint(p.baseToken.address)) return false;
    if (!p.baseToken.address.toLowerCase().endsWith("pump")) return false;

    const createdAt = new Date(p.createdAt || now).getTime();
    if (Number.isNaN(createdAt)) return false;

    return now - createdAt <= CANDIDATE_TTL_MS;
  });
}

async function processTokens() {
  console.log("--------------------------------------------------");
  console.log("[Scanner] Starting token processing cycle...");

  const freshPairs = await fetchFreshPumpSwapPairs();

  for (const pair of freshPairs) {
    const mint = pair.baseToken.address;
    const pairAddress = pair.pairAddress;

    console.log(`[Scanner] Inspecting token: ${mint}`);

    // Skip if already processed in memory
    if (processedMints.has(mint)) {
      console.log("[Scanner] Skipped: Already processed in memory");
      continue;
    }

    // Skip if token blocked
    if (isBlocked(mint)) {
      console.log("[Scanner] Skipped: Token blocked due to previous migration failure");
      continue;
    }

    // Skip if no pair address → mark as failed
    if (!pairAddress) {
      console.log("[Scanner] Skipped: No pair address, marking as failed");
      failedMints.set(mint, Date.now());
      continue;
    }

    // Check migration
    let migrated = false;
    try {
      console.log(`[Scanner] Checking Pump migration for pair ${pairAddress}`);
      migrated = await checkPumpMigration(pairAddress);
    } catch (err) {
      console.log("[Scanner] Migration check failed:", err.message);
      failedMints.set(mint, Date.now());
      continue;
    }

    if (!migrated) {
      console.log(`[Scanner] Migration failed: ${mint} discarded and blocked`);
      failedMints.set(mint, Date.now());
      continue;
    }

    // Save token to JSON for other modules
    saveToken({ mint, pairAddress, seenAt: Date.now() });

    // Mark processed in memory
    processedMints.set(mint, Date.now());

    console.log("=======================================");
    console.log("🚀 NEW TOKEN DETECTED");
    console.log(`Mint: ${mint}`);
    console.log(`Pair: ${pairAddress}`);
    console.log("=======================================");

    // Telegram alert
    try {
      await telegram.send(`🚀 NEW PUMPSWAP TOKEN DETECTED\nMint: ${mint}\nPair: ${pairAddress}`);
    } catch (err) {
      console.log("[Scanner] Telegram alert failed:", err.message);
    }
  }

  console.log("[Scanner] Token processing cycle finished\n");
}

// -------------------- MODULE API --------------------
export async function startDexScanner() {
  console.log("[DexScanner] Booting scanner...");
  await processTokens();
  intervalHandle = setInterval(processTokens, SCAN_INTERVAL_MS);
  console.log(`[DexScanner] Started | Scan interval: ${SCAN_INTERVAL_MS}ms`);
}

export async function stopDexScanner() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[DexScanner] Scanner stopped");
  } else {
    console.log("[DexScanner] Scanner was not running");
  }
}

// -------------------- NODE DIRECT ENTRY --------------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  void startDexScanner().catch(err => {
    console.error("[DexScanner] Failed to start:", err);
  });
}