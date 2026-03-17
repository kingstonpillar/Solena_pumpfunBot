// dexscreenerScanner.js
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import bs58 from "bs58";
import { withHttpLimit } from "./httpLimiter.js";
import { checkPumpMigration } from "./checkPumpMigration.js";
dotenv.config();

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 15000);
const MAX_ACTIVE_TOKENS = Number(process.env.MAX_ACTIVE_TOKENS || 50);
const CANDIDATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CANDIDATES_FILE = path.resolve(process.env.BONDING_OUT_FILE || "./bonding_candidates.json");

const trackedMints = new Map();
const retiredMints = new Set();
let scanning = false;
let intervalHandle = null;

/* -------------------- TELEGRAM -------------------- */
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

/* -------------------- UTILS -------------------- */
function loadCandidates() {
  try {
    if (!fs.existsSync(CANDIDATES_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(CANDIDATES_FILE, "utf8") || "[]");
    return data;
  } catch {
    return [];
  }
}

function saveCandidates() {
  const arr = [...trackedMints.values()].map(v => ({
    mint: v.mint,
    pairAddress: v.pairAddress,
    seenAt: v.seenAt
  }));

  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(arr, null, 2), "utf8");

  console.log(`[Scanner] Candidates saved (${arr.length})`);
}
function isValidSolanaMint(address) {
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/* -------------------- SCANNER -------------------- */
async function fetchFreshPumpSwapPairs() {
  console.log("[Scanner] Fetching PumpSwap pairs from Dexscreener...");

  const url = "https://api.dexscreener.com/latest/dex/search/?q=solana";
  let data;

  try {
    const res = await withHttpLimit(() => axios.get(url, { timeout: 10000 }));
    data = res.data;
  } catch (err) {
    console.error("[Scanner] Dexscreener request failed:", err.message);
    return [];
  }

  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];

  console.log(`[Scanner] Total pairs received: ${pairs.length}`);

  const filtered = pairs.filter((p) => {

    if (p.chainId !== "solana") return false;

    if (String(p.dexId || "").toLowerCase() !== "pumpswap") return false;

    if (typeof p.baseToken?.address !== "string") return false;

    if (!isValidSolanaMint(p.baseToken.address)) return false;

    if (!p.baseToken.address.toLowerCase().endsWith("pump")) return false;

    const created = new Date(p.createdAt || Date.now()).getTime();

    if (Number.isNaN(created)) return false;

    if (Date.now() - created > CANDIDATE_TTL_MS) return false;

    return true;
  });

  console.log(`[Scanner] PumpSwap candidates found: ${filtered.length}`);

  return filtered;
}

async function discoverNewTokens() {
  const pairs = await fetchFreshPumpSwapPairs();

  for (const pair of pairs) {
    const mint = pair.baseToken.address;
    const pairAddress = pair.pairAddress;

    console.log(`[Scanner] Inspecting token: ${mint}`);

    if (!pairAddress) {
      console.log("[Scanner] Skipped: No pair address");
      continue;
    }

    if (trackedMints.has(mint)) {
      console.log("[Scanner] Skipped: Already tracked");
      continue;
    }

    if (retiredMints.has(mint)) {
      console.log("[Scanner] Skipped: Already retired");
      continue;
    }

    if (trackedMints.size >= MAX_ACTIVE_TOKENS) {
      console.log("[Scanner] Max active tokens reached");
      break;
    }

    let migrated = false;

    try {
      console.log(`[Scanner] Checking Pump migration for pair ${pairAddress}`);
      migrated = await checkPumpMigration(pairAddress);
    } catch (err) {
      console.log("[Scanner] Migration check failed:", err.message);
      continue;
    }

    if (!migrated) {
      console.log(`[Scanner] Not migrated yet: ${mint}`);
      continue;
    }

    // Add to tracking
    const seenAt = Date.now();
    trackedMints.set(mint, {
      mint,
      pairAddress,
      seenAt
    });

    // Save immediately
    saveCandidates();

    console.log("=======================================");
    console.log("🚀 NEW TOKEN DETECTED");
    console.log(`Mint: ${mint}`);
    console.log(`Pair: ${pairAddress}`);
    console.log("=======================================");
    console.log(`[Scanner] Token added to tracking. Total tracked: ${trackedMints.size}`);

    // Send Telegram alert
    try {
      await telegram.send(
        `🚀 NEW PUMPSWAP TOKEN DETECTED\nMint: ${mint}\nPair: ${pairAddress}`
      );
    } catch (err) {
      console.log("[Scanner] Telegram alert failed:", err.message);
    }
  }
}


function retireOldTokens() {
  const now = Date.now();

  for (const [mint, v] of trackedMints.entries()) {

    if (now - v.seenAt > CANDIDATE_TTL_MS) {

      console.log(`[Scanner] Token expired and removed: ${mint}`);

      trackedMints.delete(mint);
      retiredMints.add(mint);

      telegram.send(
        `⏳ Token expired: ${mint} (older than 5 minutes)`
      ).catch(() => {});
    }
  }

  saveCandidates();
}

async function scanAndTrack() {
  if (scanning) {
    console.log("[Scanner] Previous scan still running, skipping...");
    return;
  }

  scanning = true;

  console.log("--------------------------------------------------");
  console.log("[Scanner] Starting scan cycle...");
  console.log(`Tracked tokens: ${trackedMints.size}`);
  console.log(`Retired tokens: ${retiredMints.size}`);
  console.log("--------------------------------------------------");

  try {
    await discoverNewTokens();
    retireOldTokens();
  } catch (err) {
    console.error("[Scanner Error]", err);
  } finally {
    scanning = false;
    console.log("[Scanner] Scan cycle finished\n");
  }
}

function restoreCandidates() {
  const arr = loadCandidates();

  console.log(`[Scanner] Restoring ${arr.length} saved candidates`);

  for (const item of arr) {
    if (!item?.mint || !item?.pairAddress || !item?.seenAt) {
      console.log("[Scanner] Skipping invalid candidate entry");
      continue;
    }

    const mint = item.mint;
    const pairAddress = item.pairAddress;
    const seenAt = item.seenAt;

    trackedMints.set(mint, { mint, pairAddress, seenAt });

    console.log(`[Scanner] Restored token: ${mint} | Pair: ${pairAddress} | SeenAt: ${new Date(seenAt).toISOString()}`);
  }

  console.log(`[Scanner] Tracking ${trackedMints.size} tokens after restore`);
}
/* -------------------- MODULE API -------------------- */
export async function startDexScanner() {
  console.log("[DexScanner] Booting scanner...");

  restoreCandidates();

  await scanAndTrack();

  intervalHandle = setInterval(scanAndTrack, SCAN_INTERVAL_MS);

  console.log(`[DexScanner] Started | Scan interval: ${SCAN_INTERVAL_MS}ms`);
}

export async function stopDexScanner() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  console.log("[DexScanner] Stopped");
}
/* -------------------- NODE DIRECT ENTRY -------------------- */
if (process.argv[1] === new URL(import.meta.url).pathname) {
  // Run DexScanner directly via `node dexscreenerScanner.js`
  void startDexScanner().catch(err => {
    console.error("[DexScanner] Failed to start:", err);
  });
}