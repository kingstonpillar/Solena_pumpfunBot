
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { updateMarketCapAndCheckRetracement, getMarketCapMemory } from "./stage1_retracement.js";
import { computeCandle } from "./computeCandle.js";
import { checkTokenSecurity } from "./tokensecurities.js";
import { checkToken2022ExtensionsSafety } from "./token2022ExtensionsGate.js";
import { resolvePumpSwapPool } from "./poolResolver.js";
import { checkPumpMigration } from "./checkPumpMigration.js";
import { executeAmmMigrationBuy, ensureEntryCapacity } from "./swapexecutorAMM_pumpswap.js";

const POLL_INTERVAL = 10000;
const CONCURRENCY_LIMIT = 3;
const BONDING_FILE = path.resolve(
  process.env.BONDING_OUT_FILE || "./bonding_candidates.json"
);

// ---------------- Load JSON ----------------
function loadBondingCandidates(filePath = BONDING_FILE) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.error("[JSON] Failed to load bonding candidates:", err.message);
    return [];
  }
}
// ---------------- Save JSON ----------------
function saveBondingCandidates(candidates, filePath = BONDING_FILE) {
  fs.writeFileSync(filePath, JSON.stringify(candidates, null, 2));
}
// ---------------- Remove JSON ----------------

function removeMintFromCandidates(mint, filePath = BONDING_FILE) {
  const candidates = loadBondingCandidates(filePath);

  const filtered = candidates.filter((c) => {
    const candidateMint = typeof c === "string" ? c : c?.mint;
    return candidateMint !== mint;
  });

  saveBondingCandidates(filtered, filePath);
  console.log(`[JSON] Removed ${mint} from candidates`);
}
// ---------------- TELEGRAM ALERT ----------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("[Telegram Alert ERROR]", err.message);
  }
}


// ---------------- LIMIT RUNNING MINT----------------
async function runWithConcurrencyLimit(items, limit, handler) {
  const executing = new Set();

  for (const item of items) {
    const p = handler(item)
      .catch((err) => {
        console.error('[buyCaller] mint error', {
          mint: item,
          error: err?.message,
        });
        return false;
      })
      .finally(() => executing.delete(p));

    executing.add(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.allSettled(executing);
}




// ---------------- Stage 1 polling ----------------
async function stage1PollingLoop(mint, lastClose) {
  const POLL_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  const startTime = Date.now();

  while (Date.now() - startTime < POLL_DURATION) {
    const stage1Result = await updateMarketCapAndCheckRetracement(mint);
    const mem = getMarketCapMemory(mint);

    if (!mem) {
      console.log(`[STAGE1] Memory not ready for ${mint}, waiting...`);
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Only consider levels that were crossed down first and then crossed up
    const levels = stage1Result?.details?.levelsUsed || [];

const levelToWatch = [...levels].reverse().find(
  lvl => mem.retracementLevels[lvl]?.crossedDown &&
         mem.retracementLevels[lvl]?.crossedUp
);

if (!levelToWatch) {
  console.log(`[STAGE1] No retracement level crossed up yet for ${mint}, waiting...`);
  await new Promise(r => setTimeout(r, POLL_INTERVAL));
  continue;
}

    // Compute candle with momentum
    const candle = await computeCandle(mint, mem.newHighMcap, mem.newLowMcap, lastClose);

    // Ensure candle returns momentum
    if (typeof candle.momentum !== "number") {
      candle.momentum = candle.close - candle.open;
    }

    // Only proceed if candle is green and internally has >=15% momentum
    if (candle.color === "green" && candle.momentum >= 15) {
      console.log(`[STAGE1] Green candle above level ${levelToWatch}% with sufficient momentum → Proceed`);
      return { stage1Result, candle, level: levelToWatch };
    }

    console.log(`[STAGE1] Waiting: either red candle or momentum < 15% for ${mint}`);
    lastClose = candle.close;

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // ---------------- 24 hours passed, remove mint ----------------
  console.warn(`[STAGE1] 24 hours polling ended for ${mint}, no green candle detected`);
  removeMintFromCandidates(mint);
  await sendTelegramAlert(`[INFO] ${mint} removed from bonding candidates after 24h of polling without green candle`);
  return null;
}

// ---------------- Process single mint ----------------
async function processMint(mint) {
  let lastClose = null;
  let stage1Data = null;

  // ---------------- Stage 1: Polling ----------------
  while (!stage1Data) {
    stage1Data = await stage1PollingLoop(mint, lastClose);
    if (!stage1Data) {
      // stage1PollingLoop already removes mint after 24h
      return false;
    } else lastClose = stage1Data.candle.close;
  }

  // ---------------- Stage 2: Token Security ----------------
try {
  const sec = await checkTokenSecurity(mint);

  if (!sec.safe) {
    await sendTelegramAlert(
      `[FAIL] ${mint} failed security → removed from JSON\nRetracement Level: ${stage1Data.level}\nCandle: ${JSON.stringify(stage1Data.candle)}`
    );
    removeMintFromCandidates(mint);
    return false;
  }

  if (sec.isToken2022) {
    const t2022 = await checkToken2022ExtensionsSafety(mint);

    if (!t2022.ok) {
      await sendTelegramAlert(
        `[FAIL] ${mint} failed Token-2022 check → removed from JSON\nRetracement Level: ${stage1Data.level}\nCandle: ${JSON.stringify(stage1Data.candle)}`
      );
      removeMintFromCandidates(mint);
      return false;
    }
  }
} catch (err) {
  await sendTelegramAlert(
    `[FAIL] ${mint} processing error → removed from JSON\nError: ${err.message}`
  );
  removeMintFromCandidates(mint);
  return false;
}

  // ---------------- Stage 3: Resolve Pool ----------------
let poolPk;
try {
  const mintPk = new PublicKey(mint);   // ✅ FIX
  poolPk = await resolvePumpSwapPool(mintPk);
} catch (err) {
  await sendTelegramAlert(
    `[FAIL] ${mint} failed to resolve pool → removed from JSON\nError: ${err?.message}`
  );
  removeMintFromCandidates(mint);
  return false;
}

// ---------------- Stage 4: Check Migration ----------------
try {
  const migrated = await checkPumpMigration(poolPk);
  if (!migrated) {
    await sendTelegramAlert(
      `[FAIL] ${mint} pool not migrated → removed from JSON`
    );
    removeMintFromCandidates(mint);
    return false;
  }
} catch (err) {
  await sendTelegramAlert(
    `[FAIL] ${mint} migration check error → removed from JSON\nError: ${err?.message}`
  );
  removeMintFromCandidates(mint);
  return false;
}

  // ---------------- Stage 5: Execute Buy ----------------
  // Stage 5: Execute Buy with capacity check
  try {
    // Check maximum entry capacity before buying
  
const capacity = ensureEntryCapacity();

if (capacity.reached) {
  console.log("[MAX_ENTRY_REACHED]", {
    mint,
    currentCount: capacity.currentCount,
    maxEntry: capacity.maxEntry,
    action: "skip_buy_keep_candidate",
  });

  return false;
}
const buyRes = await executeAmmMigrationBuy({ mint });

console.log("[STAGE5_BUY_SUCCESS]", {
  mint,
  signature: buyRes.signature,
  level: stage1Data.level,
  candle: stage1Data.candle,
});

await sendTelegramAlert(
  `[SUCCESS] ${mint} bought successfully ✅\nSignature: ${buyRes.signature}\nRetracement Level: ${stage1Data.level}\nCandle: ${JSON.stringify(stage1Data.candle)}`
);

    // Remove mint after successful buy
    removeMintFromCandidates(mint);
    return true;
  } catch (err) {
    await sendTelegramAlert(`[FAIL] ${mint} buy execution failed → removed from JSON\nError: ${err?.message}`);
    removeMintFromCandidates(mint);
    return false;
  }
}

// ---------------- START/STOP LOOP ----------------
const BUY_LOOP_MS = Number(process.env.BUYCALLER_LOOP_MS || 10_000);

let buyTimer = null;
let buyTickRunning = false;

// ---------------- CORE LOOP ----------------
async function runBuyTick(label) {
  if (buyTickRunning) return;

  buyTickRunning = true;

  try {
    const candidates = loadBondingCandidates();

    // ✅ DEBUG LOG (inserted here)
    console.log("[buyCaller] file debug", {
      cwd: process.cwd(),
      bondingFile: BONDING_FILE,
      exists: fs.existsSync(BONDING_FILE),
      count: candidates.length,
      first: candidates[0] ?? null,
    });

    if (!candidates.length) {
      console.log('[buyCaller] no bonding candidates');
      return;
    }

    console.log('[buyCaller] processing', {
      count: candidates.length,
      concurrency: CONCURRENCY_LIMIT,
    });

    await runWithConcurrencyLimit(candidates, CONCURRENCY_LIMIT, async (candidate) => {
      const mint = typeof candidate === "string" ? candidate : candidate?.mint;

      if (!mint) {
        console.warn('[buyCaller] skipping invalid candidate', { candidate });
        return false;
      }

      return processMint(mint);
    });

  } catch (err) {
    console.error(`[buyCaller] ${label} error:`, String(err?.message || err));
  } finally {
    buyTickRunning = false;
  }
}

// ---------------- START ----------------
export function startBuyCaller() {
  if (buyTimer) return;

  console.log('[buyCaller] started', { BUY_LOOP_MS });

  // Run immediately
  void runBuyTick('initial');

  // Loop
  buyTimer = setInterval(() => {
    void runBuyTick('loop');
  }, BUY_LOOP_MS);
}

// ---------------- STOP ----------------
export async function stopBuyCaller(reason = 'manual') {
  if (!buyTimer) return;

  clearInterval(buyTimer);
  buyTimer = null;

  while (buyTickRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('[buyCaller] stopped', { reason });
}

// ---------------- EXPORTS ----------------
export const startBuyCallerLoop = startBuyCaller;
export const stopBuyCallerLoop = stopBuyCaller;

// ---------------- CLI ----------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  startBuyCaller();
}