import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import {
  updateMarketCapAndCheckRetracement,
  getMarketCapMemory,
  clearMarketCapMemory,
} from "./stage1_retracement.js";
import { computeCandle } from "./computeCandle.js";
import { checkTokenSecurity } from "./tokensecurities.js";
import { checkToken2022ExtensionsSafety } from "./token2022ExtensionsGate.js";
import { resolvePumpSwapPool } from "./poolResolver.js";
import { checkPumpMigration } from "./checkPumpMigration.js";
import {
  executeAmmMigrationBuy,
  ensureEntryCapacity,
} from "./swapexecutorAMM_pumpswap.js";

const CONCURRENCY_LIMIT = Number(process.env.BUYCALLER_CONCURRENCY || 3);
const BUY_LOOP_MS = Number(process.env.BUYCALLER_LOOP_MS || 10_000);
const STAGE1_TIMEOUT_MS = 9 * 60 * 60 * 1000;

const BONDING_FILE = path.resolve(
  process.env.BONDING_OUT_FILE || "./bonding_candidates.json"
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const LAST_CLOSE_MAP = new Map();
const FIRST_SEEN_MAP = new Map();

let buyTimer = null;
let buyTickRunning = false;

// ---------------- JSON ----------------
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

function saveBondingCandidates(candidates, filePath = BONDING_FILE) {
  fs.writeFileSync(filePath, JSON.stringify(candidates, null, 2));
}

function cleanupMintState(mint) {
  FIRST_SEEN_MAP.delete(mint);
  LAST_CLOSE_MAP.delete(mint);
}

function removeMintFully(mint, reason = "unknown", filePath = BONDING_FILE) {
  const candidates = loadBondingCandidates(filePath);

  const filtered = candidates.filter((c) => {
    const candidateMint = typeof c === "string" ? c : c?.mint;
    return candidateMint !== mint;
  });

  saveBondingCandidates(filtered, filePath);
  cleanupMintState(mint);

  console.log("[JSON] Removed mint from candidates", {
    mint,
    reason,
    remaining: filtered.length,
  });
}

// ---------------- TELEGRAM ----------------
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (err) {
    console.error("[Telegram Alert ERROR]", err.message);
  }
}

// ---------------- CONCURRENCY ----------------
async function runWithConcurrencyLimit(items, limit, handler) {
  const executing = new Set();

  for (const item of items) {
    const p = handler(item)
      .catch((err) => {
        console.error("[buyCaller] mint error", {
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

// ---------------- STAGE 1 ----------------
async function checkStage1Once(mint, lastClose) {
  const stage1Result = await updateMarketCapAndCheckRetracement(mint);
  const mem = getMarketCapMemory(mint);

  if (!mem) {
    console.log(`[STAGE1] Memory not ready for ${mint}, waiting...`);
    return { ok: false, reason: "memory_not_ready", lastClose };
  }

  const levels = stage1Result?.details?.levelsUsed || [];

  const levelToWatch = [...levels].reverse().find(
    (lvl) =>
      mem.retracementLevels[lvl]?.crossedDown &&
      mem.retracementLevels[lvl]?.crossedUp
  );

  if (!levelToWatch) {
    console.log(
      `[STAGE1] No retracement level crossed up yet for ${mint}, waiting...`
    );
    return { ok: false, reason: "no_retracement_crossup", lastClose };
  }

  const candle = await computeCandle(
    mint,
    mem.newHighMcap,
    mem.newLowMcap,
    lastClose
  );

  if (typeof candle.momentum !== "number") {
    candle.momentum = candle.close - candle.open;
  }

  if (candle.color === "green" && candle.momentum >= 15) {
    console.log(
      `[STAGE1] Green candle above level ${levelToWatch}% with sufficient momentum → Proceed`
    );
    return {
      ok: true,
      stage1Result,
      candle,
      level: levelToWatch,
      lastClose: candle.close,
    };
  }

  console.log(
    `[STAGE1] Waiting: either red candle or momentum < 15% for ${mint}`
  );

  return {
    ok: false,
    reason: "candle_not_ready",
    lastClose: candle.close,
  };
}

// ---------------- PROCESS ONE MINT ----------------
async function processMint(mint) {
  const now = Date.now();

  if (!FIRST_SEEN_MAP.has(mint)) {
    FIRST_SEEN_MAP.set(mint, now);
  }

  const startedAt = FIRST_SEEN_MAP.get(mint);

  if (now - startedAt >= STAGE1_TIMEOUT_MS) {
    console.warn(
      `[STAGE1] 24 hours polling ended for ${mint}, no green candle detected`
    );

    removeMintFully(mint, "stage1_timeout");

    await sendTelegramAlert(
      `[INFO] ${mint} removed from bonding candidates after 24h of polling without green candle`
    );

    return false;
  }

  const lastClose = LAST_CLOSE_MAP.get(mint) ?? null;
  const stage1Data = await checkStage1Once(mint, lastClose);

  if (!stage1Data.ok) {
    if (stage1Data.lastClose != null) {
      LAST_CLOSE_MAP.set(mint, stage1Data.lastClose);
    }
    return false;
  }

  if (stage1Data.lastClose != null) {
    LAST_CLOSE_MAP.set(mint, stage1Data.lastClose);
  }

  // ---------------- Stage 2: Token Security ----------------
  try {
    const sec = await checkTokenSecurity(mint);

    if (!sec.safe) {
      await sendTelegramAlert(
        `[FAIL] ${mint} failed security → removed from JSON\nRetracement Level: ${stage1Data.level}\nCandle: ${JSON.stringify(stage1Data.candle)}`
      );
      removeMintFully(mint, "security_fail");
      return false;
    }

    if (sec.isToken2022) {
      const t2022 = await checkToken2022ExtensionsSafety(mint);

      if (!t2022.ok) {
        await sendTelegramAlert(
          `[FAIL] ${mint} failed Token-2022 check → removed from JSON\nRetracement Level: ${stage1Data.level}\nCandle: ${JSON.stringify(stage1Data.candle)}`
        );
        removeMintFully(mint, "token2022_fail");
        return false;
      }
    }
  } catch (err) {
    await sendTelegramAlert(
      `[FAIL] ${mint} processing error → removed from JSON\nError: ${err.message}`
    );
    removeMintFully(mint, "security_processing_error");
    return false;
  }

  // ---------------- Stage 3: Resolve Pool ----------------
  let poolPk;
  try {
    const mintPk = new PublicKey(mint);
    poolPk = await resolvePumpSwapPool(mintPk);
  } catch (err) {
    await sendTelegramAlert(
      `[FAIL] ${mint} failed to resolve pool → removed from JSON\nError: ${err?.message}`
    );
    removeMintFully(mint, "pool_resolve_fail");
    return false;
  }

  // ---------------- Stage 4: Check Migration ----------------
  try {
    const migrated = await checkPumpMigration(poolPk);

    if (!migrated) {
      await sendTelegramAlert(
        `[FAIL] ${mint} pool not migrated → removed from JSON`
      );
      removeMintFully(mint, "pool_not_migrated");
      return false;
    }
  } catch (err) {
    await sendTelegramAlert(
      `[FAIL] ${mint} migration check error → removed from JSON\nError: ${err?.message}`
    );
    removeMintFully(mint, "migration_check_fail");
    return false;
  }

  // ---------------- Stage 5: Execute Buy ----------------
try {
  const capacity = ensureEntryCapacity();

  if (capacity.reached) {
    console.log("[MAX_ENTRY_REACHED]", {
      mint,
      currentCount: capacity.currentCount,
      maxEntry: capacity.maxEntry,
      action: "skip_buy_keep_candidate",
    });

    // keep candidate and keep maps
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

  clearMarketCapMemory(mint);
  removeMintFully(mint, "buy_success");
  return true;
} catch (err) {
  await sendTelegramAlert(
    `[FAIL] ${mint} buy execution failed → removed from JSON\nError: ${err?.message}`
  );
  removeMintFully(mint, "buy_execution_fail");
  return false;
}
}



// ---------------- CORE LOOP ----------------
async function runBuyTick(label) {
  if (buyTickRunning) return;

  buyTickRunning = true;

  try {
    const candidates = loadBondingCandidates();

    console.log("[buyCaller] file debug", {
      cwd: process.cwd(),
      bondingFile: BONDING_FILE,
      exists: fs.existsSync(BONDING_FILE),
      count: candidates.length,
      mints: candidates.map((c) => (typeof c === "string" ? c : c?.mint)),
    });

    if (!candidates.length) {
      console.log("[buyCaller] no bonding candidates");
      return;
    }

    console.log("[buyCaller] processing", {
      count: candidates.length,
      concurrency: CONCURRENCY_LIMIT,
    });

    await runWithConcurrencyLimit(
      candidates,
      CONCURRENCY_LIMIT,
      async (candidate) => {
        const mint = typeof candidate === "string" ? candidate : candidate?.mint;

        if (!mint) {
          console.warn("[buyCaller] skipping invalid candidate", { candidate });
          return false;
        }

        console.log("[PROCESS_MINT_START]", { mint });
        return processMint(mint);
      }
    );
  } catch (err) {
    console.error(`[buyCaller] ${label} error:`, String(err?.message || err));
  } finally {
    buyTickRunning = false;
  }
}

// ---------------- START / STOP ----------------
export function startBuyCaller() {
  if (buyTimer) return;

  console.log("[buyCaller] started", { BUY_LOOP_MS });

  void runBuyTick("initial");

  buyTimer = setInterval(() => {
    void runBuyTick("loop");
  }, BUY_LOOP_MS);
}

export async function stopBuyCaller(reason = "manual") {
  if (!buyTimer) return;

  clearInterval(buyTimer);
  buyTimer = null;

  while (buyTickRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[buyCaller] stopped", { reason });
}

// ---------------- EXPORTS ----------------
export const startBuyCallerLoop = startBuyCaller;
export const stopBuyCallerLoop = stopBuyCaller;

// ---------------- CLI ----------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  startBuyCaller();
}