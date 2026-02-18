// candle_exit_guard.js (ESM)
import fs from "fs";
import path from "path";
import "dotenv/config";

import { getCandles } from "./dex_candles.js";

const ACTIVE_POSITIONS_FILE = path.resolve(
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json"
);

const BATCH_SIZE = Number(process.env.CANDLE_GUARD_BATCH_SIZE || 4);
let cursor = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function avgVolume(candles, n = 20) {
  const xs = candles.slice(-n);
  if (!xs.length) return 0;
  const sum = xs.reduce((a, c) => a + Number(c?.v || 0), 0);
  return sum / xs.length;
}

function lastCandle(candles) {
  return candles?.length ? candles[candles.length - 1] : null;
}

function prevCandle(candles) {
  return candles?.length >= 2 ? candles[candles.length - 2] : null;
}

function detectImpulse(c, avgVol, volMult = 1.0, bodyMult = 1.2) {
  if (!c) return null;

  const o = Number(c.o);
  const h = Number(c.h);
  const l = Number(c.l);
  const close = Number(c.c);
  const v = Number(c.v);

  if (![o, h, l, close, v].every(Number.isFinite)) return null;

  const range = Math.max(1e-12, h - l);
  const body = close - o;
  const bullish = close > o;
  const strongBody = bullish && body / range >= bodyMult / 2;
  const volOk = v > avgVol * volMult;

  if (!strongBody || !volOk) return null;

  return {
    impulseHigh: h,
    impulseVolume: v,
    impulseTs: c.t,
  };
}

function evaluateState(prevState, candles5m, opts) {
  const volMult = Number(opts.volMult ?? 1.0);
  const avgN = Number(opts.avgN ?? 20);

  if (!candles5m || candles5m.length < avgN + 2) return prevState;

  const c = lastCandle(candles5m);
  const av = avgVolume(candles5m, avgN);

  const state = prevState || {
    phase: "IDLE",
    impulseHigh: null,
    impulseVolume: null,
    hh1High: null,
    hh1Volume: null,
  };

  if (state.phase === "IDLE") {
    const imp = detectImpulse(c, av, volMult);
    if (imp) return { ...state, phase: "IMPULSE", ...imp };
    return state;
  }

  if (state.phase === "IMPULSE") {
    const h = Number(c.h);
    const v = Number(c.v);
    if (
      Number.isFinite(h) &&
      Number.isFinite(v) &&
      h > state.impulseHigh &&
      v >= state.impulseVolume
    ) {
      return { ...state, phase: "HOLD", hh1High: h, hh1Volume: v };
    }
    return state;
  }

  if (state.phase === "HOLD") {
    const h = Number(c.h);
    const v = Number(c.v);
    if (
      Number.isFinite(h) &&
      Number.isFinite(v) &&
      h > state.hh1High &&
      v < state.hh1Volume &&
      v < state.impulseVolume
    ) {
      return { ...state, phase: "EXIT_READY" };
    }
    return state;
  }

  return state;
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  }).catch(() => null);
}

// M1 confirmation after M5 EXIT_READY:
// require ANY of:
// 1) last 1m candle closes red (c < o)
// 2) last 1m close breaks below previous 1m low (c < prev.l)
// 3) red candle with volume spike (v >= avgVol * volSpikeMult)
function m1ConfirmsExit(candles1m, { volAvgN = 20, volSpikeMult = 1.5 } = {}) {
  if (!candles1m || candles1m.length < 2) {
    return { ok: false, reason: "m1_not_enough_candles" };
  }

  const last = lastCandle(candles1m);
  const prev = prevCandle(candles1m);
  if (!last || !prev) return { ok: false, reason: "m1_missing_last_prev" };

  const o = Number(last.o);
  const c = Number(last.c);
  const v = Number(last.v);
  const prevL = Number(prev.l);

  if (![o, c, v, prevL].every(Number.isFinite)) {
    return { ok: false, reason: "m1_invalid_numbers" };
  }

  const red = c < o;
  const breakPrevLow = c < prevL;

  const av = avgVolume(candles1m, Math.max(2, Number(volAvgN)));
  const volSpike = av > 0 ? v >= av * Number(volSpikeMult) : false;
  const redWithSpike = red && volSpike;

  if (red) return { ok: true, reason: "m1_red_close" };
  if (breakPrevLow) return { ok: true, reason: "m1_break_prev_low" };
  if (redWithSpike) return { ok: true, reason: "m1_red_vol_spike" };

  return { ok: false, reason: "m1_no_confirmation" };
}

export async function runCandleExitGuardFromActivePositions({
  onSignal, // async ({ mint, action, reason, context })
  scanMs = 10_000,
  m5Limit = 120,
  m1Limit = 60,
  volMult = 1.0,
  avgN = 20,

  // NEW: M1 confirmation controls
  m1VolAvgN = Number(process.env.CANDLE_GUARD_M1_VOL_AVG_N || 20),
  m1VolSpikeMult = Number(process.env.CANDLE_GUARD_M1_VOL_SPIKE_MULT || 1.5),
} = {}) {
  if (typeof onSignal !== "function") {
    throw new Error("runCandleExitGuardFromActivePositions: onSignal required");
  }

  const stateByMint = new Map();
  const cooldownSell = new Map();
  const holdAlerted = new Set(); // prevent repeated HOLD spam

  while (true) {
    const positions = loadActivePositions();

    const total = positions.length;
    if (!total) {
      await sleep(scanMs);
      continue;
    }

    const size = Math.max(1, Math.min(BATCH_SIZE, total));

    // build this tick’s batch (wrap-safe)
    const start = cursor % total;
    const end = start + size;

    const batch =
      end <= total
        ? positions.slice(start, end)
        : positions.slice(start).concat(positions.slice(0, end - total));

    console.log("[candle_guard] batch", { start, size, total });

    // advance cursor for next tick
    cursor = (start + size) % total;

    // process only this batch
    for (const pos of batch) {
      const mint = String(pos?.mint || pos?.mintAddress || "").trim();
      if (!mint) continue;

      const candles5m = await getCandles({
        pairAddress: mint,
        timeframe: "5m",
        limit: m5Limit,
      });
      if (!candles5m) continue;

      const prev = stateByMint.get(mint);
      const next = evaluateState(prev, candles5m, { volMult, avgN });
      stateByMint.set(mint, next);

      // HOLD alert (only once per hold cycle)
      if (next.phase === "HOLD" && !holdAlerted.has(mint)) {
        holdAlerted.add(mint);

        await sendTelegramMessage(
          ` HOLD detected\nMint: ${mint}\nImpulse High: ${next.impulseHigh}\nHH1 High: ${next.hh1High}`
        );
      }

      // If EXIT_READY, allow new HOLD alerts later
      if (next.phase === "EXIT_READY") {
        holdAlerted.delete(mint);
      }

      if (next.phase !== "EXIT_READY") continue;

      const lastSell = cooldownSell.get(mint) || 0;
      if (Date.now() - lastSell < 30_000) continue;

      const candles1m = await getCandles({
        pairAddress: mint,
        timeframe: "1m",
        limit: m1Limit,
      });

      const m1Check = m1ConfirmsExit(candles1m, {
        volAvgN: m1VolAvgN,
        volSpikeMult: m1VolSpikeMult,
      });

      // If M1 does NOT confirm, do not SELL yet. Keep state as HOLD so we keep monitoring.
      if (!m1Check.ok) {
        console.log("[candle_guard] EXIT_READY but no M1 confirm", {
          mint,
          reason: m1Check.reason,
        });
        continue;
      }

      const context = {
        mint,
        phase: next.phase,
        confirm: {
          timeframe: "1m",
          ok: true,
          reason: m1Check.reason,
          volAvgN: m1VolAvgN,
          volSpikeMult: m1VolSpikeMult,
        },
        m5: {
          impulseHigh: next.impulseHigh,
          impulseVolume: next.impulseVolume,
          hh1High: next.hh1High,
          hh1Volume: next.hh1Volume,
          lastCandle: lastCandle(candles5m),
        },
        m1: {
          lastCandle: candles1m ? lastCandle(candles1m) : null,
          prevCandle: candles1m ? prevCandle(candles1m) : null,
        },
      };

      cooldownSell.set(mint, Date.now());

      await onSignal({
        mint,
        action: "SELL",
        reason: `M5_exit_ready_M1_confirmed:${m1Check.reason}`,
        context,
      });

      // prevent repeated SELL spam without a new cycle
      stateByMint.set(mint, { ...next, phase: "HOLD" });
    }

    await sleep(scanMs);
  }
}