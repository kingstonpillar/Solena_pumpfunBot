import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import bs58 from "bs58";
import { withHttpLimit } from "./httpLimiter.js";
import { checkPumpMigration } from "./checkPumpMigration.js";

dotenv.config();

// ---------------- CONFIG ----------------
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 15000);
const MAX_ACTIVE_TOKENS = Number(process.env.MAX_ACTIVE_TOKENS || 50);
const MEMORY_TTL_MS = Number(process.env.MEMORY_TTL_MS || 10 * 60 * 60 * 1000); // 10 hours default
const MIGRATED_FILE = path.resolve("./Migrated_Token.json");
const BONDING_FILE = path.resolve(process.env.BONDING_OUT_FILE || "./bonding_candidates.json");

// ---------------- MEMORY ----------------
const rescanMemory = new Map();
let scanning = false;
let intervalHandle = null;

// ---------------- TELEGRAM ----------------
class Telegram {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async send(message) {
    if (!this.botToken || !this.chatId || !message) return;
    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      console.log(`[Telegram] Message sent (${message.length} chars)`);
    } catch (err) {
      console.error("[Telegram Error]", err.message || err);
    }
  }
}

const telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

// ---------------- UTILS ----------------
function isValidSolanaMint(address) {
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = fs.readFileSync(filePath, "utf8") || "[]";
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function saveMigratedToken(token) {
  const existing = loadJsonFile(MIGRATED_FILE);
  existing.push(token);
  saveJsonFile(MIGRATED_FILE, existing);
}

function saveBondingCandidate(token) {
  const existing = loadJsonFile(BONDING_FILE);
  existing.push(token);
  saveJsonFile(BONDING_FILE, existing);
}

// ---------------- FETCH DEXSCREENER ----------------
async function fetchPumpSwapPairs() {
  const url = "https://api.dexscreener.com/latest/dex/search/?q=solana";
  console.log("[+] Fetching DexScreener PumpSwap pairs...");
  try {
    const { data } = await withHttpLimit(() => axios.get(url, { timeout: 10000 }));

    if (!Array.isArray(data?.pairs)) {
      console.log("[DexScreener] No pairs found or unexpected data format:", data);
      return [];
    }

    console.log(`[DexScreener] Total pairs fetched: ${data.pairs.length}`);

    const now = Date.now();
    const FIVE_MINUTES_MS = 5 * 60 * 1000;

    const filteredPairs = data.pairs.filter(p => {
      // PumpSwap only on Solana
      if (p.chainId !== "solana" || String(p.dexId || "").toLowerCase() !== "pumpswap") return false;

      const pairCreatedAt = p.pairCreatedAt;
      if (!pairCreatedAt) return false;

      return now - new Date(pairCreatedAt).getTime() <= FIVE_MINUTES_MS;
    });

    console.log(`[DexScreener] Pairs created in last 5 minutes: ${filteredPairs.length}`);

    filteredPairs.forEach((p, idx) => {
      console.log(`Pair #${idx + 1}:`, {
        chainId: p.chainId,
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        baseToken: p.baseToken ? { symbol: p.baseToken.symbol, address: p.baseToken.address } : null,
        quoteToken: p.quoteToken ? { symbol: p.quoteToken.symbol, address: p.quoteToken.address } : null,
        pairCreatedAt: p.pairCreatedAt,
      });
    });

    return filteredPairs;
  } catch (err) {
    console.error("[DexScreener Error]", err.message || err);
    return [];
  }
}

// ---------------- DISCOVER TOKENS ----------------
async function discoverNewTokens() {
  const pairs = await fetchPumpSwapPairs();
  const migratedTokens = new Set(loadJsonFile(MIGRATED_FILE).map(t => t.mint));

  await Promise.all(
    pairs.map(async pair => {
      const mint = pair?.baseToken?.address;
      const symbol = pair?.baseToken?.symbol || "UNKNOWN";
      const pairAddress = pair?.pairAddress;

      if (!mint || !pairAddress || !isValidSolanaMint(mint)) return;
      if (migratedTokens.has(mint)) return; // Already migrated

      let migrated = false;
      try {
        migrated = await checkPumpMigration(pairAddress);
      } catch (err) {
        console.log(`[MIGRATION CHECK FAILED] Symbol: ${symbol} | Mint: ${mint} | Pair: ${pairAddress} | Error: ${err.message}`);
      }

      const tokenObj = { mint, symbol, pairAddress, migratedAt: Date.now() };

      if (migrated) {
        saveMigratedToken(tokenObj);
        saveBondingCandidate(tokenObj);
        console.log(`[MIGRATION PASSED] Symbol: ${symbol} | Mint: ${mint} | Pair: ${pairAddress}`);
        return;
      }

      rescanMemory.set(mint, { ...tokenObj, seenAt: Date.now() });
      console.log(`[NEW TOKEN DISCOVERED] Symbol: ${symbol} | Mint: ${mint} | Pair: ${pairAddress}`);

      await telegram.send(`🚀 NEW TOKEN DETECTED\nSymbol: ${symbol}\nMint: ${mint}\nPair: ${pairAddress}`);
    })
  );
}

// ---------------- RESCAN MEMORY TOKENS ----------------
async function rescanMemoryTokens() {
  const migratedTokens = new Set(loadJsonFile(MIGRATED_FILE).map(t => t.mint));
  const now = Date.now();

  for (const [mint, token] of rescanMemory.entries()) {
    // Remove expired tokens
    if (now - token.seenAt > MEMORY_TTL_MS) {
      rescanMemory.delete(mint);
      console.log(`[MEMORY EXPIRED] ${token.symbol} | ${mint}`);
      continue;
    }

    if (migratedTokens.has(mint)) {
      rescanMemory.delete(mint);
      continue;
    }

    let migrated = false;
    try {
      migrated = await checkPumpMigration(token.pairAddress);
    } catch (err) {
      console.log(`[MIGRATION CHECK FAILED] Symbol: ${token.symbol} | Mint: ${mint} | Pair: ${token.pairAddress} | Error: ${err.message}`);
    }

    if (migrated) {
      saveMigratedToken(token);
      saveBondingCandidate(token);    // <--- Added bonding candidate
      rescanMemory.delete(mint);
      console.log(`[MIGRATION PASSED] Symbol: ${token.symbol} | Mint: ${mint} | Pair: ${token.pairAddress}`);
    } else {
      console.log(`[RESCAN PENDING] Symbol: ${token.symbol} | Mint: ${mint} | Pair: ${token.pairAddress}`);
    }
  }
}

// ---------------- MEMORY CLEAN ----------------
function cleanMemory() {
  const now = Date.now();
  for (const [mint, token] of rescanMemory.entries()) {
    if (now - token.seenAt > MEMORY_TTL_MS) {
      rescanMemory.delete(mint);
      console.log(`[MEMORY EXPIRED] ${token.symbol} | ${mint}`);
    }
  }

  if (rescanMemory.size > MAX_ACTIVE_TOKENS) {
    const sorted = [...rescanMemory.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [mint] of sorted.slice(0, rescanMemory.size - MAX_ACTIVE_TOKENS)) {
      rescanMemory.delete(mint);
    }
  }
}

// ---------------- MAIN LOOP ----------------
async function scanAndTrack() {
  if (scanning) return;
  scanning = true;
  console.log(`[SCAN] Running scan at ${new Date().toISOString()}`);
  try {
    await discoverNewTokens();
    await rescanMemoryTokens(); // Keep rescanning memory
    cleanMemory();
  } catch (err) {
    console.error("[SCANNER ERROR]", err);
  }
  scanning = false;
}

// ---------------- START/STOP ----------------
export async function startDexScanner() {
  if (intervalHandle) return;
  console.log("[DexScanner] Booting scanner...");
  await scanAndTrack();
  intervalHandle = setInterval(scanAndTrack, SCAN_INTERVAL_MS);
  console.log(`[DexScanner] Started | Scan interval: ${SCAN_INTERVAL_MS}ms`);
}

export async function stopDexScanner() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  console.log("[DexScanner] Scanner stopped");
}

// ---------------- DIRECT NODE ENTRY ----------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  void startDexScanner().catch(err => console.error("[DexScanner] Failed to start:",