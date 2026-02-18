// advanced_trailing.js
// Volatility-friendly gap trailing
// - Activate at +25%
// - Step trigger every +100% more profit
// - First lock = 10%
// - Each step increases lock by +25%
// - Sell when profit <= locked profit

export function computeProfitPct(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const p = Number(currentPrice);
  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return 0;
  return ((p - e) / e) * 100;
}

export function applyAdvancedGapTrailing(position, currentPrice, opts = {}) {
  const MARK_PCT = Number(opts.markPct ?? 25);
  const STEP_TRIGGER_DELTA_PCT = Number(opts.stepTriggerDeltaPct ?? 100);
  const LOCK_STEP_PCT = Number(opts.lockStepPct ?? 25);
  const START_LOCK_PCT = Number(opts.startLockPct ?? 10);

  if (!position) {
    return { shouldSell: false, reason: "no_position", position };
  }

  if (!position.entryPrice) {
    return { shouldSell: false, reason: "no_entryPrice", position };
  }

  const profitPct = computeProfitPct(position.entryPrice, currentPrice);

  // Initialize trailing container
  if (!position.trailing) {
    position.trailing = {
      active: false,
      lockedProfitPct: 0,
      nextStepTriggerPct: null,
      steps: 0,
      lastProfitPct: profitPct,
    };
  }

  const t = position.trailing;
  t.lastProfitPct = profitPct;

  // 1) Activate at +25%
  if (!t.active) {
    if (profitPct >= MARK_PCT) {
      t.active = true;
      t.lockedProfitPct = 0;
      t.steps = 0;
      t.nextStepTriggerPct = MARK_PCT + STEP_TRIGGER_DELTA_PCT; // 25 + 100 = 125
      return { shouldSell: false, reason: "trailing_activated", position };
    }

    return { shouldSell: false, reason: "not_marked_yet", position };
  }

  // 2) Step lock upward only when hitting trigger levels
  while (t.nextStepTriggerPct != null && profitPct >= t.nextStepTriggerPct) {
    t.steps += 1;

    // Volatility-friendly locking logic
    t.lockedProfitPct =
      START_LOCK_PCT + (t.steps - 1) * LOCK_STEP_PCT;

    t.nextStepTriggerPct =
      MARK_PCT + (t.steps + 1) * STEP_TRIGGER_DELTA_PCT;
  }

  // 3) Sell if profit falls to locked level
  if (profitPct <= t.lockedProfitPct) {
    return {
      shouldSell: true,
      reason: `gap_trailing_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${t.lockedProfitPct.toFixed(2)}%`,
      position,
    };
  }

  return { shouldSell: false, reason: "holding", position };
}