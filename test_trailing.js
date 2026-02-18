// test_trailing.js (ESM)
// Update this to match your NEW trailing params:
// - MARK at +25%
// - STEP trigger delta = 100 (because volatility)
// - LOCK step = 50 (you said lock 50)
//
// Meaning:
// activate at >= 25%
// first step happens at 25 + 100 = 125% profit  -> locked = 50
// second step happens at 25 + 200 = 225% profit -> locked = 100
// sell when profitPct <= lockedProfitPct

import { applyAdvancedGapTrailing } from "./advanced_trailing.js";

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

function logStep(label, out) {
  const t = out?.position?.trailing || {};
  console.log(
    `${label} | shouldSell=${out.shouldSell} | reason=${out.reason}\n` +
      `  profit=${fmt(t.lastProfitPct)}% active=${t.active} locked=${fmt(t.lockedProfitPct)} next=${fmt(t.nextStepTriggerPct)} steps=${t.steps}\n`
  );
}

async function main() {
  // Fake position like what you store in active_positions.json
  const pos = {
    mint: "TEST",
    entryPrice: 1.0,
  };

  // Explicitly pass the new parameters to avoid ambiguity
  const opts = {
    markPct: 25,
    stepTriggerDeltaPct: 100,
    lockStepPct: 50,
  };

  // Price path:
  // 1) below +25%: not active
  // 2) >= +25%: activates
  // 3) reach +125%: step1 -> lock 50
  // 4) drop to +60%: still above lock 50 (hold)
  // 5) drop to +49%: <= lock 50 (SELL)
  //
  // entry=1.0 so:
  // +25% => 1.25
  // +125% => 2.25
  // +60% => 1.60
  // +49% => 1.49
  const prices = [
    1.10, // +10% (not marked)
    1.26, // +26% (activate)
    2.25, // +125% (step1 -> lock 50)
    1.60, // +60% (still > locked 50 -> hold)
    1.49, // +49% (<= locked 50 -> SELL)
  ];

  console.log("ENTRY:", pos.entryPrice);
  console.log("OPTS:", opts);

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const out = applyAdvancedGapTrailing(pos, p, opts);
    logStep(`step=${i} price=${p}`, out);

    if (out.shouldSell) {
      console.log("SELL TRIGGERED. Stop test.");
      break;
    }
  }
}

main().catch((e) => console.error(e));
