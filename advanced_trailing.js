
// advanced_trailing.js

export function computeProfitPct(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const p = Number(currentPrice);
  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return 0;
  return ((p - e) / e) * 100;
}

// lock ladder (interval = LOCK_INTERVAL)
// Example: startAt=400, step=200
// 425 -> floor 400 -> lock 200
function computeLockPct(profitPct, startAt = 400, step = 200) {
  if (!Number.isFinite(profitPct)) return null;
  if (profitPct < startAt) return null;

  const floor = Math.floor(profitPct / step) * step;
  const lock = floor - step;
  return Math.max(0, lock);
}

export function applyAdvancedGapTrailing(position, currentPrice, opts = {}) {
  const MARK_PCT = Number(opts.markPct ?? 25);
  const STEP_TRIGGER_DELTA_PCT = Number(opts.stepTriggerDeltaPct ?? 100);
  const LOCK_STEP_PCT = Number(opts.lockStepPct ?? 25);
  const START_LOCK_PCT = Number(opts.startLockPct ?? 10);

  // lock system config
  const LOCK_START_AT = Number(opts.lockStartAt ?? 400);
  const LOCK_INTERVAL = Number(opts.lockInterval ?? 200);

  if (!position) return { shouldSell: false, reason: "no_position", position };
  if (!position.entryPrice) return { shouldSell: false, reason: "no_entryPrice", position };

  const profitPct = computeProfitPct(position.entryPrice, currentPrice);

  // init trailing container once
  if (!position.trailing) {
    position.trailing = {
      active: false,
      lockedProfitPct: 0,
      nextStepTriggerPct: null,
      steps: 0,
      lastProfitPct: profitPct,
      lock: { active: false, lockedProfitPct: 0, notifiedAt: null },
    };
  }

  const t = position.trailing;
  t.lastProfitPct = profitPct;

  // ensure lock object exists
  if (!t.lock) t.lock = { active: false, lockedProfitPct: 0, notifiedAt: null };

  // DEBUG log (single place, always runs unless we return early)
  console.log(
    `[TRAIL] mint=${position.mint || position.mintAddress || "?"} profit=${profitPct.toFixed(2)}% ` +
      `trailActive=${t.active} lockActive=${t.lock.active} ` +
      `trailLocked=${t.lockedProfitPct} lockLocked=${t.lock.lockedProfitPct} ` +
      `steps=${t.steps} next=${t.nextStepTriggerPct}`
  );

  // -----------------------------
  // 0) LOCK OVERRIDE (sticky once activated)
  // -----------------------------
  if (t.lock.active) {
    if (profitPct <= t.lock.lockedProfitPct) {
      return {
        shouldSell: true,
        reason: `lock_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${t.lock.lockedProfitPct.toFixed(2)}%`,
        position,
        signal: { type: "LOCK_SELL", lockedProfitPct: t.lock.lockedProfitPct, profitPct },
      };
    }
  }

  // activate or update lock if profit is high enough
  const lockPct = computeLockPct(profitPct, LOCK_START_AT, LOCK_INTERVAL);

  if (lockPct != null) {
    const wasInactive = !t.lock.active;
    const lockLevelChanged = t.lock.lockedProfitPct !== lockPct;

    t.lock.active = true;
    t.lock.lockedProfitPct = lockPct;

    if (profitPct <= lockPct) {
      return {
        shouldSell: true,
        reason: `lock_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${lockPct.toFixed(2)}%`,
        position,
        signal: { type: "LOCK_SELL", lockedProfitPct: lockPct, profitPct },
      };
    }

    // freeze trailing once lock is active
    t.active = false;
    t.lockedProfitPct = 0;
    t.steps = 0;
    t.nextStepTriggerPct = null;

    if (wasInactive || lockLevelChanged) {
      return {
        shouldSell: false,
        reason: `lock_active profit=${profitPct.toFixed(2)}% locked=${lockPct.toFixed(2)}%`,
        position,
        signal: { type: "LOCK_ON", lockedProfitPct: lockPct, profitPct },
      };
    }

    return { shouldSell: false, reason: "lock_holding", position };
  }

  // -----------------------------
  // 1) Normal trailing (< LOCK_START_AT)
  // -----------------------------
  if (!t.active) {
    if (profitPct >= MARK_PCT) {
      t.active = true;
      t.lockedProfitPct = 0;
      t.steps = 0;
      t.nextStepTriggerPct = MARK_PCT + STEP_TRIGGER_DELTA_PCT;
      return { shouldSell: false, reason: "trailing_activated", position };
    }
    return { shouldSell: false, reason: "not_marked_yet", position };
  }

  while (t.nextStepTriggerPct != null && profitPct >= t.nextStepTriggerPct) {
    t.steps += 1;
    t.lockedProfitPct = START_LOCK_PCT + (t.steps - 1) * LOCK_STEP_PCT;
    t.nextStepTriggerPct = MARK_PCT + (t.steps + 1) * STEP_TRIGGER_DELTA_PCT;
  }

  if (profitPct <= t.lockedProfitPct) {
    return {
      shouldSell: true,
      reason: `gap_trailing_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${t.lockedProfitPct.toFixed(2)}%`,
      position,
      signal: { type: "TRAIL_SELL", lockedProfitPct: t.lockedProfitPct, profitPct },
    };
  }

  return { shouldSell: false, reason: "holding", position };
}
