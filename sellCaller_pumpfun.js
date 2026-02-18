// sellCaller_pumpfun.js (ESM)
// Add candle_exit_guard integration (SELL signals) without changing your existing exits.

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

import { applyAdvancedGapTrailing } from "./advanced_trailing.js";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { runTop1GuardFromActivePositions } from "./top1_guard.js";
import { runCandleExitGuardFromActivePositions } from "./candle_exit_guard.js"; // ✅ NEW

import { executeAutoSellPumpfun } from "./autoSell_pumpfun.js";

dotenv.config();

// ---------------- signal buses ----------------
const top1Signals = new Map();    // mint -> { action, reason, context, ts }
const candleSignals = new Map();  // mint -> { action, reason, context, ts } ✅ NEW

let top1GuardStarted = false;
let candleGuardStarted = false;  // ✅ NEW

const ACTIVE_POSITIONS_FILE = path.resolve(
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json"
);

const POLL_INTERVAL_MS = Number(process.env.SELL_POLL_INTERVAL_MS || 10_000);
const MAX_HOLD_HOURS = Number(process.env.MAX_HOLD_HOURS || 24);
const MAIN_TARGET_PCT = Number(process.env.MAIN_TARGET_PCT || 200);

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
  return (pos?.mintAddress || pos?.mint || "").toString().trim();
}

function resolveTimestampMs(pos) {
  const t = Date.parse(pos?.timestamp || pos?.boughtAt || pos?.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

function buildPriceRecord(pos) {
  const mint = resolveMint(pos);
  return { mint, migration: pos?.migration || null };
}

function computeProfitPct(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const p = Number(currentPrice);
  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return 0;
  return ((p - e) / e) * 100;
}

// ---------------- EMERGENCY RUG EXIT ----------------
function checkEmergencyRug(position, priceSOL) {
  const mint = resolveMint(position);
  if (!mint) return { shouldSell: false };

  const p = Number(priceSOL);
  if (!Number.isFinite(p) || p <= 0) return { shouldSell: false };

  if (!position.rug) {
    position.rug = { lastPrice: p };
    return { shouldSell: false };
  }

  const prev = Number(position.rug.lastPrice) || 0;
  const dropPct = prev > 0 ? ((prev - p) / prev) * 100 : 0;

  position.rug.lastPrice = p;

  if (dropPct >= 55) {
    return { shouldSell: true, reason: "rug_price_crash", dropPct };
  }

  return { shouldSell: false };
}

// ---------------- SELL EXEC ----------------
async function trySellAndRemove(positions, pos, reason) {
  const mint = resolveMint(pos);
  if (!mint) return { positions, removed: false };

  console.log(`[SELL] ${reason} mint=${mint}`);

  if (SELL_DRY_RUN) {
    console.log(`[SELL-DRY-RUN] removed mint=${mint}`);
    return {
      positions: positions.filter((p) => resolveMint(p) !== mint),
      removed: true,
    };
  }

  const res = await executeAutoSellPumpfun({ mint, amount: "100%" }).catch((e) => {
    console.log(`[SELL_FAIL] mint=${mint} err=${e?.message || e}`);
    return null;
  });

  if (!res) return { positions, removed: false };

  const isConfirmedSell =
    res.ok === true &&
    res.dryRun !== true &&
    typeof res.signature === "string" &&
    res.signature.length > 0;

  if (!isConfirmedSell) {
    console.log(`[SELL_NOT_REMOVED] mint=${mint} reason=${res.reason || "not_confirmed"}`);
    return { positions, removed: false };
  }

  console.log(`[SELL_OK] mint=${mint} tx=${res.signature}`);

  return {
    positions: positions.filter((p) => resolveMint(p) !== mint),
    removed: true,
  };
}

// ---------------- SIGNAL HANDLERS ----------------
function top1OnSignal({ mint, action, reason, context }) {
  const m = String(mint || "").trim();
  if (!m) return;
  console.log(`[TOP1_GUARD] action=${action} mint=${m} reason=${reason}`);
  top1Signals.set(m, { action, reason, context, ts: Date.now() });
}

function candleOnSignal({ mint, action, reason, context }) {
  const m = String(mint || "").trim();
  if (!m) return;
  console.log(`[CANDLE_GUARD] action=${action} mint=${m} reason=${reason}`);
  candleSignals.set(m, { action, reason, context, ts: Date.now() });
}

function startTop1Guard() {
  if (top1GuardStarted) return;
  top1GuardStarted = true;

  void runTop1GuardFromActivePositions({ onSignal: top1OnSignal }).catch((e) => {
    console.log("[top1_guard] crashed:", e?.message || e);
    top1GuardStarted = false;
  });
}

function startCandleGuard() {
  if (candleGuardStarted) return;
  candleGuardStarted = true;

  void runCandleExitGuardFromActivePositions({ onSignal: candleOnSignal }).catch((e) => {
    console.log("[candle_guard] crashed:", e?.message || e);
    candleGuardStarted = false;
  });
}

// ---------------- MAIN CYCLE ----------------
export async function runSellCycleOnce() {
  let positions = readPositions();
  if (!positions.length) return { ok: true, positions: 0, removed: 0 };

  let removedCount = 0;

  // Iterate a stable snapshot so we can safely mutate `positions` (removals) inside the loop
  for (const pos of [...positions]) {
    const mint = resolveMint(pos);
    if (!mint) continue;

    // Skip if this mint was already removed earlier in this same tick
    // (because we are iterating a snapshot)
    if (!positions.some((p) => resolveMint(p) === mint)) continue;

    // 0A) CANDLE EXIT OVERRIDE (signal-driven sell)
    const cSig = candleSignals.get(mint);
    if (cSig?.action === "SELL") {
      const out = await trySellAndRemove(positions, pos, `CANDLE:${cSig.reason}`);
      positions = out.positions;

      if (out.removed) {
        removedCount += 1;

        // clear all signal sources for this mint
        candleSignals.delete(mint);
        top1Signals.delete(mint);
      } else {
        console.log(`[CANDLE_GUARD] sell failed, will retry next tick mint=${mint}`);
      }

      continue;
    }

    // 0B) TOP1 GUARD OVERRIDE (signal-driven sell)
    const tSig = top1Signals.get(mint);
    if (tSig?.action === "SELL") {
      const out = await trySellAndRemove(positions, pos, `TOP1:${tSig.reason}`);
      positions = out.positions;

      if (out.removed) {
        removedCount += 1;

        // clear all signal sources for this mint
        top1Signals.delete(mint);
        candleSignals.delete(mint);
      } else {
        console.log(`[TOP1_GUARD] sell failed, will retry next tick mint=${mint}`);
      }

      continue;
    }

    const entryPrice = parseEntryPrice(pos);
    if (!entryPrice) continue;

    const priceRes = await getPumpFunPriceOnce(buildPriceRecord(pos)).catch(() => null);
const price = Number(priceRes?.priceSOL);
if (!Number.isFinite(price) || price <= 0) continue;


    // 1) EMERGENCY RUG
    const rug = checkEmergencyRug(pos, price);
    if (rug.shouldSell) {
      const out = await trySellAndRemove(positions, pos, `RUG:${rug.reason}`);
      positions = out.positions;
      if (out.removed) removedCount += 1;
      continue;
    }

    // 2) TARGET
    const profitPct = computeProfitPct(entryPrice, price);
    if (profitPct >= MAIN_TARGET_PCT) {
      const out = await trySellAndRemove(positions, pos, `TARGET:+${profitPct.toFixed(2)}%`);
      positions = out.positions;
      if (out.removed) removedCount += 1;
      continue;
    }

    // 3) TIME
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

    // 4) TRAILING
    if (!pos.entryPrice) pos.entryPrice = entryPrice;
    const trail = applyAdvancedGapTrailing(pos, price);
    if (trail.shouldSell) {
      const out = await trySellAndRemove(positions, pos, `TRAIL:${trail.reason}`);
      positions = out.positions;
      if (out.removed) removedCount += 1;
      continue;
    }

    // Persist optional state updates (pos is the same object reference inside `positions`)
    pos.lastPriceSOL = price;
    pos.lastCheckedAt = new Date().toISOString();
  }

  writePositions(positions);
  return { ok: true, positions: positions.length, removed: removedCount };
}

// ---------------- START/STOP LOOP ----------------
let sellTimer = null;
let sellTickRunning = false;

async function runSellTick(label) {
  if (sellTickRunning) return;
  sellTickRunning = true;
  try {
    await runSellCycleOnce();
  } catch (err) {
    console.error(`[sellCaller] ${label} error:`, err?.message || err);
  } finally {
    sellTickRunning = false;
  }
}

export function startSellCaller() {
  if (sellTimer) return;

  console.log("[sellCaller] started", { POLL_INTERVAL_MS });

  // ✅ start signal guards once
  startTop1Guard();
  startCandleGuard();

  void runSellTick("initial tick");

  sellTimer = setInterval(() => {
    void runSellTick("loop tick");
  }, POLL_INTERVAL_MS);
}

export async function stopSellCaller(reason = "manual") {
  if (!sellTimer) return;

  clearInterval(sellTimer);
  sellTimer = null;

  while (sellTickRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[sellCaller] stopped", { reason });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log("[NODE] sellCaller_pumpfun running");
  startSellCaller();
}