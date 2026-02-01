// advanced_trailing.js
// Gap trailing:
// - Activate at +25%
// - Step trigger every +45% more profit
// - Each step increases locked profit by +25%
// - Sell when current profit <= locked profit (after activation)

export function computeProfitPct(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const p = Number(currentPrice);
  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return 0;
  return ((p - e) / e) * 100;
}

/**
 * position must be an object you persist in active_positions.json
 * required: entryPrice
 * updates:
 *  - trailing.active
 *  - trailing.lockedProfitPct
 *  - trailing.nextStepTriggerPct
 *  - trailing.steps
 * returns: { shouldSell, reason, position }
 */
export function applyAdvancedGapTrailing(position, currentPrice, opts = {}) {
  const MARK_PCT = Number(opts.markPct ?? 25);
  const STEP_TRIGGER_DELTA_PCT = Number(opts.stepTriggerDeltaPct ?? 45);
  const LOCK_STEP_PCT = Number(opts.lockStepPct ?? 25);

  if (!position) return { shouldSell: false, reason: "no_position", position };
  if (!position.entryPrice) return { shouldSell: false, reason: "no_entryPrice", position };

  const profitPct = computeProfitPct(position.entryPrice, currentPrice);

  // init trailing state container
  if (!position.trailing) {
    position.trailing = {
      active: false,
      lockedProfitPct: 0,          // profit locked, not "distance"
      nextStepTriggerPct: null,    // profit threshold to increase lock
      steps: 0,
      lastProfitPct: profitPct,
    };
  }

  const t = position.trailing;
  t.lastProfitPct = profitPct;

  // 1) activate at +25%
  if (!t.active) {
    if (profitPct >= MARK_PCT) {
      t.active = true;
      t.lockedProfitPct = 0; // gap starts here, you are not locking 25 immediately
      t.steps = 0;
      t.nextStepTriggerPct = MARK_PCT + STEP_TRIGGER_DELTA_PCT; // 25 + 45 = 70
      return { shouldSell: false, reason: "trailing_activated", position };
    }
    return { shouldSell: false, reason: "not_marked_yet", position };
  }

  // 2) step-up lock only when profit reaches next trigger
  while (t.nextStepTriggerPct != null && profitPct >= t.nextStepTriggerPct) {
    t.steps += 1;
    t.lockedProfitPct = t.steps * LOCK_STEP_PCT; // 1=>25, 2=>50, 3=>75 ...
    t.nextStepTriggerPct = MARK_PCT + (t.steps + 1) * STEP_TRIGGER_DELTA_PCT;
    // steps+1 because next trigger is 25 + 2*45 = 115 after first step
  }

  // 3) sell condition: if profit drops back to locked profit level or below
  // This is the "gap" you wanted.
  if (profitPct <= t.lockedProfitPct) {
    return {
      shouldSell: true,
      reason: `gap_trailing_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${t.lockedProfitPct.toFixed(2)}%`,
      position,
    };
  }

  return { shouldSell: false, reason: "holding", position };
}