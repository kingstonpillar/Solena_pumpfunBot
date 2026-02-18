// test_candle_exit_guard.js (ESM)
// Runs candle_exit_guard with a local stubbed candle feed (no API calls).
// It simulates 5m candles to reach IMPULSE -> HOLD -> EXIT_READY,
// then simulates 1m confirmation to allow SELL.
// You should see:
// - batch logs
// - HOLD telegram simulated log
// - SELL onSignal fired

import { runCandleExitGuardFromActivePositions } from "./candle_exit_guard.js";

// ------------ CONFIG (override for test) ------------
process.env.CANDLE_GUARD_BATCH_SIZE = "4";

// ------------ helpers ------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------ stub active positions ------------
const fakePositions = [
  { mint: "MINT_A" },
  { mint: "MINT_B" },
];

// Monkeypatch fs read inside candle_exit_guard by writing a temp file
// (Simplest: create a real active_positions.json for the test)
import fs from "fs";
import path from "path";

const ACTIVE_POSITIONS_FILE = path.resolve(
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json"
);

fs.writeFileSync(ACTIVE_POSITIONS_FILE, JSON.stringify(fakePositions, null, 2));

// ------------ STUB getCandles (no network) ------------
// We replace ./dex_candles.js by temporarily intercepting global fetch is messy.
// Cleaner: create a dedicated "test" version of candle_exit_guard that imports from this stub.
// BUT since you asked "test file", we do a Node loader trick: easiest is to run this test
// after you temporarily edit dex_candles.js to re-export from this stub.
// If you do not want to touch dex_candles.js at all, tell me and I’ll give you the Node ESM loader method.

// Candle builder: { t, o, h, l, c, v }
function mkCandle({ t, o, h, l, c, v }) {
  return { t, o, h, l, c, v };
}

// Build a baseline series with stable volume for avg calc
function baseline5m({ startTs, n = 30, base = 1.0, vol = 100 }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base;
    const c = base + 0.01;
    out.push(
      mkCandle({
        t: startTs + i * 300_000,
        o,
        h: c + 0.01,
        l: o - 0.01,
        c,
        v: vol,
      })
    );
  }
  return out;
}

// Scenario state per mint
const scenario = new Map(); // mint -> step

function stubGetCandles({ pairAddress, timeframe, limit }) {
  const mint = pairAddress;
  const step = scenario.get(mint) ?? 0;

  const now = Date.now();
  if (timeframe === "5m") {
    // We want: IDLE -> IMPULSE -> HOLD -> EXIT_READY over successive polls.
    // Each call returns last candle tuned to push phase forward.
    const candles = baseline5m({ startTs: now - 60 * 300_000, n: 30, base: 1.0, vol: 100 });

    if (step === 0) {
      // IMPULSE candle: strong bullish + vol spike > avg*1
      candles.push(
        mkCandle({
          t: now,
          o: 1.0,
          h: 1.35,
          l: 0.98,
          c: 1.30,
          v: 250, // avg ~100 -> spike
        })
      );
      scenario.set(mint, 1);
      return candles.slice(-limit);
    }

    if (step === 1) {
      // Still show impulse already detected previously, now give HH1:
      // h > impulseHigh and v >= impulseVolume
      // So impulseHigh should be from previous last candle (1.35), we exceed it.
      candles.push(
        mkCandle({
          t: now,
          o: 1.25,
          h: 1.45, // higher high
          l: 1.20,
          c: 1.40,
          v: 260, // >= impulseVolume
        })
      );
      scenario.set(mint, 2);
      return candles.slice(-limit);
    }

    // step >= 2: produce HH2 with weaker volume:
    candles.push(
      mkCandle({
        t: now,
        o: 1.35,
        h: 1.55, // higher than HH1 high
        l: 1.30,
        c: 1.38,
        v: 120, // < hh1Volume and < impulseVolume
      })
    );
    scenario.set(mint, 3);
    return candles.slice(-limit);
  }

  if (timeframe === "1m") {
    // Confirmation candle for SELL
    // Return last candle as red OR break below prev low OR red+vol spike
    const candles = [];
    const t0 = now - 10 * 60_000;

    // previous candle
    candles.push(
      mkCandle({
        t: t0,
        o: 1.40,
        h: 1.42,
        l: 1.36,
        c: 1.41,
        v: 80,
      })
    );

    // last candle red with volume spike (distribution style)
    candles.push(
      mkCandle({
        t: now,
        o: 1.41,
        h: 1.42,
        l: 1.30,
        c: 1.33, // red close < open
        v: 300,  // spike
      })
    );

    return candles.slice(-limit);
  }

  return null;
}

// ------ IMPORTANT ------
// Temporary patch: since candle_exit_guard imports getCandles from "./dex_candles.js",
// you must temporarily change dex_candles.js to export this stubGetCandles for this test run.
// Easiest quick toggle:
//
//   // dex_candles.js
//   export async function getCandles(args){ return stubGetCandles(args); }
//
// If you don’t want to touch dex_candles.js, reply "no edits" and I’ll give you
// an ESM loader approach that injects the stub without modifying files.

// ------------ onSignal ------------
async function onSignal({ mint, action, reason, context }) {
  console.log("[TEST onSignal]", { mint, action, reason });
  if (action === "SELL") {
    console.log("[TEST SELL context]", {
      phase: context?.phase,
      m5_last: context?.m5?.lastCandle,
      m1_last: context?.m1?.lastCandle,
    });
  }
}

// ------------ run test ------------
async function main() {
  console.log("[TEST] starting candle_exit_guard test");

  // Run guard, but stop after first SELL signal for any mint
  let sold = false;

  const wrappedOnSignal = async (sig) => {
    await onSignal(sig);
    if (sig.action === "SELL") sold = true;
  };

  // Fire guard loop
  void runCandleExitGuardFromActivePositions({
    onSignal: wrappedOnSignal,
    scanMs: 1000,
    m5Limit: 60,
    m1Limit: 10,
    volMult: 1.0,
    avgN: 20,
  });

  // Wait up to ~10 seconds for SELL
  for (let i = 0; i < 10; i++) {
    if (sold) {
      console.log("[TEST] PASS: SELL signal fired");
      process.exit(0);
    }
    await sleep(1000);
  }

  console.log("[TEST] FAIL: No SELL signal within timeout");
  process.exit(1);
}

main().catch((e) => {
  console.error("[TEST] crashed:", e);
  process.exit(1);
});