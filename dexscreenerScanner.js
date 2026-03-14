import axios from "axios";
import dotenv from "dotenv";
import { SolanaDeepBuyBot } from "./buyCaller_pumpswap.js";
import { withHttpLimit } from "./httpLimiter.js";

dotenv.config();

const trackedMints = new Map();
const retiredMints = new Set();

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 15000);
const TRACKING_EXPIRY_HOURS = Number(process.env.TRACKING_EXPIRY_HOURS || 12);
const MAX_ACTIVE_TOKENS = Number(process.env.MAX_ACTIVE_TOKENS || 50);

/* -------------------------------------------------
   Exported function
--------------------------------------------------*/
export async function fetchFreshPumpSwapPairs() {
  const url = "https://api.dexscreener.com/latest/dex/search/?q=solana";

  const { data } = await withHttpLimit(() =>
    axios.get(url, { timeout: 10000 })
  );

  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];

  return pairs.filter(
    (p) =>
      p.chainId === "solana" &&
      String(p.dexId || "").toLowerCase() === "pumpswap" &&
      p.baseToken?.address
  );
}

/* -------------------------------------------------
   Add newly discovered tokens
--------------------------------------------------*/
async function discoverNewTokens() {
  const pairs = await fetchFreshPumpSwapPairs();

  for (const pair of pairs) {
    const mint = pair.baseToken.address;

    if (trackedMints.has(mint) || retiredMints.has(mint)) continue;
    if (trackedMints.size >= MAX_ACTIVE_TOKENS) break;

    console.log({
      event: "NEW_TOKEN_DETECTED",
      time: new Date().toISOString(),
      mint,
      pairAddress: pair.pairAddress,
      dex: pair.dexId
    });

    const bot = new SolanaDeepBuyBot(mint);

    trackedMints.set(mint, {
      startedAt: Date.now(),
      pairAddress: pair.pairAddress,
      bot
    });

    console.log({
      event: "TOKEN_SENT_TO_BUY_ENGINE",
      time: new Date().toISOString(),
      mint,
      engine: "SolanaDeepBuyBot"
    });

    console.log({
      event: "BOT_MONITORING_STARTED",
      time: new Date().toISOString(),
      mint
    });
  }
}

/* -------------------------------------------------
   Tick all tracked bots in parallel
--------------------------------------------------*/
async function processTrackedTokens() {
  const entries = [...trackedMints.entries()];

  if (!entries.length) return;

  const jobs = entries.map(async ([mint, item]) => {
    const bot = item.bot;

    const result = await bot.tickAndReturn();

    const ageMs = Date.now() - item.startedAt;
    const expired = ageMs > TRACKING_EXPIRY_HOURS * 60 * 60 * 1000;

    const tooOld =
      bot.market &&
      bot.market.migrationAgeHours > bot.config.maxMigrationAgeHours;

    const bought = bot.hasBought === true;
    const blocked = bot.isBlocked === true;

    return {
      mint,
      result,
      expired,
      tooOld,
      bought,
      blocked
    };
  });

  const settled = await Promise.allSettled(jobs);

  for (const row of settled) {
    if (row.status !== "fulfilled") {
      console.error({
        event: "BOT_BATCH_ERROR",
        time: new Date().toISOString(),
        error: row.reason?.message || String(row.reason)
      });
      continue;
    }

    const { mint, result, expired, tooOld, bought, blocked } = row.value;

    console.log({
      event: "BOT_TICK_RESULT",
      time: new Date().toISOString(),
      mint,
      result
    });

    if (bought || blocked || expired || tooOld) {
      trackedMints.delete(mint);
      retiredMints.add(mint);

      console.log({
        event: "BOT_MONITORING_STOPPED",
        time: new Date().toISOString(),
        mint,
        reason: bought
          ? "BUY_EXECUTED"
          : blocked
          ? "SECURITY_BLOCKED"
          : expired
          ? "TRACKING_EXPIRED"
          : "MIGRATION_TOO_OLD"
      });
    }
  }
}

/* -------------------------------------------------
   Main loop
--------------------------------------------------*/
async function scanAndTrack() {
  try {
    await discoverNewTokens();
    await processTrackedTokens();
  } catch (err) {
    console.error({
      event: "SCANNER_ERROR",
      time: new Date().toISOString(),
      error: err.message
    });
  }
}

setInterval(scanAndTrack, SCAN_INTERVAL_MS);