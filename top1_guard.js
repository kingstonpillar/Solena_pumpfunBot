// top1_guard.js (ESM)
//
// Reads ACTIVE_POSITIONS_FILE every 10 seconds.
// For each position:
// - Top1pct(mint) -> normalize to percent
// - getPumpFunPriceOnce(mint) -> current SOL price
// - profit% = (current - entry) / entry * 100
// If top1>30 and profit<60 => SELL immediately via sellCaller
// If top1>30 and profit>=110 => HOLD signal (no sell)
//
// This file does NOT do token security.

import fs from "fs";
import path from "path";
import "dotenv/config";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { Top1pct } from "./heliusTop10.js";

const ACTIVE_POSITIONS_FILE = path.resolve(
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json"
);

const sold = new Set();
const held = new Set();
const SCAN_MS = Number(process.env.TOP1_GUARD_ACTIVE_SCAN_MS || 10_000);

// ---------- helpers ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// normalize (handles number | string | bigint | BN-like | null)
function toPctNumber(v) {
  if (v == null) return NaN;

  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);

  if (typeof v === "string") {
    const m = v.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }

  if (typeof v === "object") {
    if (typeof v.toNumber === "function") return Number(v.toNumber());
    if (typeof v.toString === "function") {
      const s = v.toString();
      const m = s.match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : NaN;
    }
  }

  return NaN;
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    const json = JSON.parse(raw || JSON.stringify(fallback));
    return json;
  } catch {
    return fallback;
  }
}

function loadActivePositions() {
  const arr = safeReadJson(ACTIVE_POSITIONS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function resolveMint(pos) {
  return String(pos?.mintAddress ?? pos?.mint ?? "").trim();
}

function pickEntryPriceSOL(pos) {
  const v =
    pos?.buyPriceSOL ??
    pos?.entryPriceSOL ??
    pos?.pumpPriceSOL ??
    pos?.entryPrice ??     // accept your json key
    pos?.buyPrice ??
    pos?.buy_price ??
    null;

  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function calcProfitPct(entryPriceSOL, currentPriceSOL) {
  const e = Number(entryPriceSOL);
  const c = Number(currentPriceSOL);
  if (!Number.isFinite(e) || e <= 0) return NaN;
  if (!Number.isFinite(c) || c <= 0) return NaN;
  return ((c - e) / e) * 100;
}

// ---------- your rule ----------
export function decideTop1Guard(top1Pct, profitPct) {
  if (top1Pct > 30) {
    if (profitPct >= 110) {
      return { action: "HOLD", reason: "top1>30 and profit>=110" };
    }

    if (profitPct < 60) {
      return { action: "SELL", reason: "top1>30 and profit<60 (rug-risk)" };
    }
  }

  return { action: "NONE", reason: "rule_not_met" };
}

// ---------- scan one position ----------
async function evaluateOnePosition({ pos }) {
  const mint = resolveMint(pos);
  if (!mint) return null;

  const entryPriceSOL = pickEntryPriceSOL(pos);
  if (!entryPriceSOL) return null;

  // Top1%
  let top1Pct = 0;
  try {
    const raw = await Top1pct(mint);
    top1Pct = toPctNumber(raw);
    if (!Number.isFinite(top1Pct)) top1Pct = 0;
  } catch {
    return null;
  }

  // Price
  let currentPriceSOL = NaN;
  try {
    const pr = await getPumpFunPriceOnce({ mint });
    currentPriceSOL = Number(pr?.priceSOL);
  } catch {
    currentPriceSOL = NaN;
  }

  const profitPct = calcProfitPct(entryPriceSOL, currentPriceSOL);
  if (!Number.isFinite(profitPct)) return null;

  const d = decideTop1Guard(top1Pct, profitPct);

  return {
    mint,
    entryPriceSOL,
    currentPriceSOL,
    profitPct,
    top1Pct,
    decision: d,
    pos,
  };
}

/**
 * Main runner (what you described).
 *
 * You call this from sellCaller like:
 *   await runTop1GuardFromActivePositions({
 *     Top1pct,
 *   })
 *
 * RETURNS (only when it triggers SELL or HOLD):
 * - SELL: { ok:true, action:"SELL", ...context, sellResult }
 * - HOLD: { ok:true, action:"HOLD", ...context }
 */

export async function runTop1GuardFromActivePositions({
  onSignal, // async ({ mint, action, reason, context })
  scanMs = SCAN_MS,
} = {}) {
  if (typeof onSignal !== "function") {
    throw new Error("runTop1GuardFromActivePositions: onSignal function required");
  }

  while (true) {
    const positions = loadActivePositions();

    for (const pos of positions) {
      const ctx = await evaluateOnePosition({ pos });
      if (!ctx) continue;

      const { decision } = ctx;

      if (decision.action === "SELL") {
        if (!sold.has(ctx.mint)) {
          sold.add(ctx.mint);

          await onSignal({
            mint: ctx.mint,
            action: "SELL",
            reason: decision.reason,
            context: ctx,
          });
        }
        continue;
      }

      if (decision.action === "HOLD") {
        if (!held.has(ctx.mint)) {
          held.add(ctx.mint);

          await onSignal({
            mint: ctx.mint,
            action: "HOLD",
            reason: decision.reason,
            context: ctx,
          });
        }
        continue;
      }

      // decision.action === "NONE"
      held.delete(ctx.mint);
      sold.delete(ctx.mint);
    }

    await sleep(scanMs);
  }
}