// -------------------- IMPORTS --------------------
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import bs58 from "bs58";
import { withHttpLimit } from "./httpLimiter.js";
import { checkPumpMigration } from "./checkPumpMigration.js";

dotenv.config();

// -------------------- CONFIG --------------------
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 15000);
const MAX_ACTIVE_TOKENS = Number(process.env.MAX_ACTIVE_TOKENS || 50);
const CANDIDATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CANDIDATES_FILE = path.resolve(process.env.BONDING_OUT_FILE || "./bonding_candidates.json");

// -------------------- MEMORY --------------------
const trackedMints = new Map();
const retiredMints = new Set();
let scanning = false;
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

// -------------------- UTILS --------------------
function loadCandidates() {
  try {
    if (!fs.existsSync(CANDIDATES_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(CANDIDATES_FILE, "utf8") || "[]");
    console.log(`[+] Loaded ${data.length} candidates from JSON`);
    return data;
  } catch (err) {
    console.error("[ERROR] Failed to load candidates:", err.message || err);
    return [];
  }
}

function saveCandidates() {
  const arr = [...trackedMints.values()].map((v) => ({
    mint: v.mint,
    pairAddress: v.pairAddress,
    seenAt: v.seenAt
  }));
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(arr, null, 2), "utf8");
  console.log(`[+] Saved ${arr.length} candidates to JSON`);
}

function isValidSolanaMint(address) {
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

// -------------------- FETCH DEXSCREENER --------------------
async function fetchFreshPumpSwapPairs() {
  const url = "https://api.dexscreener.com/latest/dex/search/?q=solana";
  console.log("[+] Fetching fresh DexScreener PumpSwap pairs...");

  const { data } = await withHttpLimit(() => axios.get(url, { timeout: 10000 }));

  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  console.log(`[INFO] Total pairs fetched from DexScreener: ${pairs.length}`);

  // First, filter all PumpSwap pairs on Solana
  const pumpSwapPairs = pairs.filter(
    (p) =>
      p.chainId === "solana" &&
      String(p.dexId || "").toLowerCase() === "pumpswap" &&
      typeof p.baseToken?.address === "string" &&
      isValidSolanaMint(p.baseToken.address)
  );

  console.log(`[INFO] Total PumpSwap pairs on Solana: ${pumpSwapPairs.length}`);

  // Then, filter those whose symbol ends with "pump"
  const filteredPairs = pumpSwapPairs.filter(
    (p) =>
      p.baseToken.symbol?.toLowerCase().endsWith("pump") &&
      Date.now() - p.pairCreatedAt <= CANDIDATE_TTL_MS
  );

  console.log(`[+] Found ${filteredPairs.length} valid PumpSwap tokens with 'pump' suffix`);

  return filteredPairs;
}
// -------------------- DISCOVER NEW TOKENS --------------------
async function discoverNewTokens() {
  const pairs = await fetchFreshPumpSwapPairs();

  let newDetected = 0;
  let skipped = 0;
  let migrationFailed = 0;

  for (const pair of pairs) {
    const mint = pair.baseToken.address;
    const symbol = pair.baseToken.symbol || "UNKNOWN";
    const pairAddress = pair.pairAddress;

    if (!pairAddress) {
      console.log(`[SKIP] Invalid pair address for token: ${symbol} | Mint: ${mint}`);
      skipped++;
      continue;
    }

    if (trackedMints.has(mint) || retiredMints.has(mint)) {
      console.log(`[SKIP] Token already tracked or retired: ${symbol} | Mint: ${mint}`);
      skipped++;
      continue;
    }

    if (trackedMints.size >= MAX_ACTIVE_TOKENS) {
      console.log("[INFO] Max active tokens reached, skipping new tokens");
      skipped++;
      break;
    }

    // -------- CHECK MIGRATION WITH RPC LIMITER --------
    let migrated = false;
    try {
      migrated = await checkPumpMigration(pairAddress);
      console.log(
        `[MIGRATION CHECK] Token: ${symbol} | Mint: ${mint} | Pair: ${pairAddress} | Migrated: ${migrated}`
      );
    } catch (err) {
      console.log(`[WARN] Migration check failed for ${symbol} | Pair: ${pairAddress}: ${err.message || err}`);
      migrationFailed++;
      continue;
    }

    if (!migrated) {
      console.log(`[SKIP] Pair not migrated via PumpSwap: ${symbol} | Pair: ${pairAddress}`);
      migrationFailed++;
      continue;
    }

    console.log(`[PASS] PumpSwap migrated pair detected: ${symbol} | Pair: ${pairAddress}`);

    const seenAt = Date.now();
    trackedMints.set(mint, { mint, pairAddress, symbol, seenAt });

    newDetected++;

    await telegram.send(
      `🚀 NEW PUMPSWAP TOKEN DETECTED\nSymbol: ${symbol}\nMint: ${mint}\nPair: ${pairAddress}`
    );
  }

  saveCandidates();

  console.log("----- SCAN SUMMARY -----");
  console.log(`New Pump tokens detected: ${newDetected}`);
  console.log(`Tokens skipped: ${skipped}`);
  console.log(`Tokens failed migration check: ${migrationFailed}`);
  console.log("------------------------");
}
// -------------------- REMOVE EXPIRED TOKENS --------------------
function retireOldTokens() {
  const now = Date.now();
  for (const [mint, v] of trackedMints.entries()) {
    if (now - v.seenAt > CANDIDATE_TTL_MS) {
      trackedMints.delete(mint);
      retiredMints.add(mint);

      console.log({
        event: "TOKEN_EXPIRED",
        time: new Date().toISOString(),
        mint,
        reason: "older than 5 minutes"
      });

      telegram.send(` Token expired: ${mint} (older than 5 minutes)`).catch(() => {});
    }
  }

  saveCandidates();
}

// -------------------- MAIN LOOP --------------------
async function scanAndTrack() {
  if (scanning) {
    console.log("[SCAN] Previous scan still running");
    return;
  }

  scanning = true;
  console.log(`[SCAN] Running scan at ${new Date().toISOString()}`);

  try {
    await discoverNewTokens();
    retireOldTokens();

    // ---- LOG CURRENT ACTIVE TOKENS ----
    if (trackedMints.size > 0) {
      console.log("----- ACTIVE PUMPSWAP TOKENS -----");
      for (const [mint, token] of trackedMints.entries()) {
        console.log(`Symbol: ${token.symbol || "UNKNOWN"} | Mint: ${mint} | Pair: ${token.pairAddress}`);
      }
      console.log(`Total active tokens: ${trackedMints.size}`);
      console.log("---------------------------------");
    } else {
      console.log("[INFO] No active PumpSwap tokens currently tracked.");
    }

  } catch (err) {
    console.error({
      event: "SCANNER_ERROR",
      time: new Date().toISOString(),
      error: err.message || err
    });
  }

  scanning = false;
}

// -------------------- RESTORE PREVIOUS CANDIDATES --------------------
function restoreCandidates() {
  const arr = loadCandidates();
  for (const item of arr) {
    trackedMints.set(item.mint, {
      mint: item.mint,
      pairAddress: item.pairAddress,
      seenAt: item.seenAt
    });
  }
  console.log(`[+] Restored ${trackedMints.size} tracked tokens`);
}

restoreCandidates();

// -------------------- MODULE API --------------------
export async function startDexScanner() {
  console.log("[DexScanner] Booting scanner...");
  await scanAndTrack();
  intervalHandle = setInterval(scanAndTrack, SCAN_INTERVAL_MS);
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