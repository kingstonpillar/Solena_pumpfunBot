// sellCaller_pumpfun.js (ESM)
// Internal loop, no external polling scheduler.
// 4 exits: (1) Emergency rug, (2) +200% target, (3) 24h timeout, (4) advanced gap trailing (your logic)
// Deletes sold token from active_positions.json ONLY on successful sell.
// SELL_DRY_RUN handling: treat dry-run as success (remove position), so tests do not loop forever.
// NOTE: SELL_DRY_RUN is independent from autoSell_pumpfun.js DRY_RUN, so it won't affect other modules.

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

import { applyAdvancedGapTrailing } from "./advanced_trailing.js";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";

// IMPORTANT: match your autoSell export name
import { executeAutoSellPumpfun } from "./autoSell_pumpfun.js";

dotenv.config();

const ACTIVE_POSITIONS_FILE = path.resolve(
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json"
);

const POLL_INTERVAL_MS = Number(process.env.SELL_POLL_INTERVAL_MS || 10_000);
const MAX_HOLD_HOURS = Number(process.env.MAX_HOLD_HOURS || 24);
const MAIN_TARGET_PCT = Number(process.env.MAIN_TARGET_PCT || 200);

// NEW: independent dry-run for SELL CALLER ONLY
const SELL_DRY_RUN = process.env.SELL_DRY_RUN === "1";

// ---------------- utils ----------------
function readPositions() {
  try {
    if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8") || "[]");
  } catch {
    return [];
  }
}

function writePositions(arr) {
  const tmp = `${ACTIVE_POSITIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, ACTIVE_POSITIONS_FILE);
}

function nowMs() {
  return Date.now();
}

function parseEntryPrice(pos) {
  const ep = Number(pos?.entryPrice ?? pos?.buyPrice ?? pos?.buy_price ?? 0);
  return Number.isFinite(ep) && ep > 0 ? ep : 0;
}

function resolveMint(pos) {
  return (pos?.mintAddress || pos?.mint || "").toString();
}

function resolveTimestampMs(pos) {
  const t = Date.parse(pos?.timestamp || pos?.boughtAt || pos?.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

// feed getPumpFunPriceOnce() the shape it expects: { mint, migration: { signature } }
function buildPriceRecord(pos) {
  const mint = resolveMint(pos);
  return {
    mint,
    migration: pos?.migration || null,
  };
}

function computeProfitPct(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const p = Number(currentPrice);
  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return 0;
  return ((p - e) / e) * 100;
}

// ---------------- EMERGENCY RUG EXIT ----------------
// Uses reserves deltas from getPumpFunPriceOnce() output.
// Persists per-position state in position.rug
function checkEmergencyRug(position, priceRes) {
  const priceSOL = Number(priceRes?.priceSOL);
  const reserves = priceRes?.reserves;

  if (!Number.isFinite(priceSOL) || priceSOL <= 0 || !reserves) return { shouldSell: false };

  const wsol = Number(reserves?.wsol);
  const tok = Number(reserves?.token);

  if (!Number.isFinite(wsol) || !Number.isFinite(tok)) return { shouldSell: false };

  if (!position.rug) {
    position.rug = {
      lastPrice: priceSOL,
      lastWsol: wsol,
      lastToken: tok,
      peakWsol: wsol,
    };
    return { shouldSell: false };
  }

  const r = position.rug;

  if (wsol > r.peakWsol) r.peakWsol = wsol;

  const wsolDropPct = r.peakWsol > 0 ? ((r.peakWsol - wsol) / r.peakWsol) * 100 : 0;
  const tokenSpikePct = r.lastToken > 0 ? ((tok - r.lastToken) / r.lastToken) * 100 : 0;
  const priceDropPct = r.lastPrice > 0 ? ((r.lastPrice - priceSOL) / r.lastPrice) * 100 : 0;

  r.lastPrice = priceSOL;
  r.lastWsol = wsol;
  r.lastToken = tok;

  if (wsolDropPct >= 60) return { shouldSell: true, reason: "rug_liquidity_collapse" };
  if (tokenSpikePct >= 80) return { shouldSell: true, reason: "rug_token_dump" };
  if (priceDropPct >= 55) return { shouldSell: true, reason: "rug_price_crash" };

  return { shouldSell: false };
}

// ---------------- SELL EXEC (single place) ----------------
async function trySellAndRemove(positions, pos, reason) {
  const mint = resolveMint(pos);
  if (!mint) return { positions, removed: false };

  console.log(`[SELL] ${reason} mint=${mint}`);

  // NEW: SELL caller dry-run (does not touch autoSell module DRY_RUN)
  if (SELL_DRY_RUN) {
    console.log(`[SELL-DRY-RUN] sell skipped for mint=${mint} (treated as success, position removed)`);
    const next = positions.filter((p) => resolveMint(p) !== mint);
    return { positions: next, removed: true };
  }

  // Real sell
  const res = await executeAutoSellPumpfun({ mint, amount: "100%" }).catch((e) => {
    console.log(`[SELL_FAIL] mint=${mint} err=${e?.message || e}`);
    return null;
  });

  const sig = res?.signature || null;
  const isAutoSellDryRun = res?.dryRun === true;

  // Success condition:
  // - real tx signature OR autoSell DRY_RUN (in case autoSell is still configured that way)
  if (!sig && !isAutoSellDryRun) {
    return { positions, removed: false };
  }

  console.log(`[SELL_OK] mint=${mint} ${sig ? `tx=${sig}` : "(autoSell dry_run)"}`);

  const next = positions.filter((p) => resolveMint(p) !== mint);
  return { positions: next, removed: true };
}

// ---------------- MAIN CYCLE ----------------
export async function runSellCycleOnce() {
  let positions = readPositions();
  if (!positions.length) return { ok: true, positions: 0, removed: 0 };

  let removedCount = 0;

  // Work on a snapshot but mutate objects inside (trailing/rug state)
  for (const pos of positions) {
    const mint = resolveMint(pos);
    if (!mint) continue;

    const entryPrice = parseEntryPrice(pos);
    if (!entryPrice) {
      console.log(`[SKIP] missing entryPrice/buyPrice mint=${mint}`);
      continue;
    }

    // price fetch
    const priceRecord = buildPriceRecord(pos);
    const priceRes = await getPumpFunPriceOnce(priceRecord).catch(() => null);
    const price = Number(priceRes?.priceSOL);

    if (!Number.isFinite(price) || price <= 0) continue;

    // 1) EMERGENCY RUG EXIT
    const rug = checkEmergencyRug(pos, priceRes);
    if (rug.shouldSell) {
      const out = await trySellAndRemove(positions, pos, `RUG:${rug.reason}`);
      positions = out.positions;
      if (out.removed) removedCount += 1;
      continue;
    }

    // profit %
    const profitPct = computeProfitPct(entryPrice, price);

    // 2) MAIN TARGET EXIT (+200%)
    if (profitPct >= MAIN_TARGET_PCT) {
      const out = await trySellAndRemove(positions, pos, `TARGET:+${profitPct.toFixed(2)}%`);
      positions = out.positions;
      if (out.removed) removedCount += 1;
      continue;
    }

    // 3) 24-HOUR TIME EXIT
    const ts = resolveTimestampMs(pos);
    if (ts) {
      const ageHours = (nowMs() - ts) / 3_600_000;
      if (ageHours >= MAX_HOLD_HOURS) {
        const out = await trySellAndRemove(positions, pos, `TIME:${ageHours.toFixed(2)}h`);
        positions = out.positions;
        if (out.removed) removedCount += 1;
        continue;
      }
    }

    // 4) ADVANCED GAP TRAILING (YOUR LOGIC, UNTOUCHED)
    if (!pos.entryPrice) pos.entryPrice = entryPrice;

    const trail = applyAdvancedGapTrailing(pos, price);
    if (trail.shouldSell) {
      const out = await trySellAndRemove(positions, pos, `TRAIL:${trail.reason}`);
      positions = out.positions;
      if (out.removed) removedCount += 1;
      continue;
    }

    // Optional state
    pos.lastPriceSOL = price;
    pos.lastCheckedAt = new Date().toISOString();
  }

  // Persist state updates + removals
  writePositions(positions);

  return { ok: true, positions: positions.length, removed: removedCount };
}

// Keep your original loop behavior, but call the exported single-cycle runner
async function runSellCycle() {
  await runSellCycleOnce().catch(() => {});
}

// ---------------- INTERNAL LOOP ----------------
let sellWatcherTimer = null;

export function startSellCaller() {
  if (sellWatcherTimer) return;
  console.log("[START] sellCaller_pumpfun started");
  runSellCycle().catch(() => {});
  sellWatcherTimer = setInterval(() => {
    runSellCycle().catch(() => {});
  }, POLL_INTERVAL_MS);
}

export function stopSellCaller() {
  if (!sellWatcherTimer) return;
  clearInterval(sellWatcherTimer);
  sellWatcherTimer = null;
  console.log("[STOP] sellCaller_pumpfun stopped");
}

// ---------------- NODE TEST ENTRY ----------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log("[NODE] sellCaller_pumpfun running");
  startSellCaller();
}