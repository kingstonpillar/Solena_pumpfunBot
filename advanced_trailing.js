// advanced_trailing.js

const TRAILING_STATE = new Map();

export function computeProfitPct(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const p = Number(currentPrice);
  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) return 0;
  return ((p - e) / e) * 100;
}

// lock ladder (interval = LOCK_INTERVAL)
// Example: startAt=350, step=100
// 375 -> floor 350 -> lock 200
function computeLockPct(profitPct, startAt = 350, step = 100) {
  if (!Number.isFinite(profitPct)) return null;
  if (profitPct < startAt) return null;

  const floor = Math.floor(profitPct / step) * step;
  const lock = floor - step;
  return Math.max(0, lock);
}

function resolveMint(position) {
  return String(position?.mint || position?.mintAddress || "").trim();
}

function createInitialTrailingState(profitPct = 0) {
  return {
    active: false,
    lockedProfitPct: 0,
    nextStepTriggerPct: null,
    steps: 0,
    lastProfitPct: profitPct,
    lock: {
      active: false,
      lockedProfitPct: 0,
      notifiedAt: null,
    },
  };
}

function cloneState(state) {
  return {
    active: !!state?.active,
    lockedProfitPct: Number(state?.lockedProfitPct || 0),
    nextStepTriggerPct:
      state?.nextStepTriggerPct == null ? null : Number(state.nextStepTriggerPct),
    steps: Number(state?.steps || 0),
    lastProfitPct: Number(state?.lastProfitPct || 0),
    lock: {
      active: !!state?.lock?.active,
      lockedProfitPct: Number(state?.lock?.lockedProfitPct || 0),
      notifiedAt: state?.lock?.notifiedAt ?? null,
    },
  };
}

function getTrailingState(position, profitPct) {
  const mint = resolveMint(position);

  if (!mint) {
    const fallback = position?.trailing
      ? cloneState(position.trailing)
      : createInitialTrailingState(profitPct);

    fallback.lastProfitPct = profitPct;
    return fallback;
  }

  let state = TRAILING_STATE.get(mint);

  if (!state) {
    state = position?.trailing
      ? cloneState(position.trailing)
      : createInitialTrailingState(profitPct);

    TRAILING_STATE.set(mint, state);
  }

  if (!state.lock) {
    state.lock = {
      active: false,
      lockedProfitPct: 0,
      notifiedAt: null,
    };
  }

  state.lastProfitPct = profitPct;
  return state;
}

function persistTrailingState(position, state) {
  const mint = resolveMint(position);

  if (mint) {
    TRAILING_STATE.set(mint, state);
  }

  position.trailing = cloneState(state);
}

export function clearTrailingState(mintOrPosition) {
  const mint =
    typeof mintOrPosition === "string"
      ? mintOrPosition.trim()
      : resolveMint(mintOrPosition);

  if (!mint) return false;
  return TRAILING_STATE.delete(mint);
}

export function getTrailingStateSnapshot(mintOrPosition) {
  const mint =
    typeof mintOrPosition === "string"
      ? mintOrPosition.trim()
      : resolveMint(mintOrPosition);

  if (!mint) return null;

  const state = TRAILING_STATE.get(mint);
  return state ? cloneState(state) : null;
}

export function applyAdvancedGapTrailing(position, currentPrice, opts = {}) {
  const MARK_PCT = Number(opts.markPct ?? 25);
  const STEP_TRIGGER_DELTA_PCT = Number(opts.stepTriggerDeltaPct ?? 100);
  const LOCK_STEP_PCT = Number(opts.lockStepPct ?? 25);
  const START_LOCK_PCT = Number(opts.startLockPct ?? 10);

  // lock system config
  const LOCK_START_AT = Number(opts.lockStartAt ?? 350);
  const LOCK_INTERVAL = Number(opts.lockInterval ?? 100);

  if (!position) {
    return { shouldSell: false, reason: "no_position", position };
  }

  if (!position.entryPrice) {
    return { shouldSell: false, reason: "no_entryPrice", position };
  }

  const profitPct = computeProfitPct(position.entryPrice, currentPrice);
  const t = getTrailingState(position, profitPct);

  // DEBUG log
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
      persistTrailingState(position, t);

      return {
        shouldSell: true,
        reason: `lock_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${t.lock.lockedProfitPct.toFixed(2)}%`,
        position,
        signal: {
          type: "LOCK_SELL",
          lockedProfitPct: t.lock.lockedProfitPct,
          profitPct,
        },
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
      persistTrailingState(position, t);

      return {
        shouldSell: true,
        reason: `lock_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${lockPct.toFixed(2)}%`,
        position,
        signal: {
          type: "LOCK_SELL",
          lockedProfitPct: lockPct,
          profitPct,
        },
      };
    }

    // freeze trailing once lock is active
    t.active = false;
    t.lockedProfitPct = 0;
    t.steps = 0;
    t.nextStepTriggerPct = null;

    persistTrailingState(position, t);

    if (wasInactive || lockLevelChanged) {
      return {
        shouldSell: false,
        reason: `lock_active profit=${profitPct.toFixed(2)}% locked=${lockPct.toFixed(2)}%`,
        position,
        signal: {
          type: "LOCK_ON",
          lockedProfitPct: lockPct,
          profitPct,
        },
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

      persistTrailingState(position, t);

      return {
        shouldSell: false,
        reason: "trailing_activated",
        position,
      };
    }

    persistTrailingState(position, t);

    return { shouldSell: false, reason: "not_marked_yet", position };
  }

  while (t.nextStepTriggerPct != null && profitPct >= t.nextStepTriggerPct) {
    t.steps += 1;
    t.lockedProfitPct = START_LOCK_PCT + (t.steps - 1) * LOCK_STEP_PCT;
    t.nextStepTriggerPct = MARK_PCT + (t.steps + 1) * STEP_TRIGGER_DELTA_PCT;
  }

  if (profitPct <= t.lockedProfitPct) {
    persistTrailingState(position, t);

    return {
      shouldSell: true,
      reason: `gap_trailing_stop_hit profit=${profitPct.toFixed(2)}% <= locked=${t.lockedProfitPct.toFixed(2)}%`,
      position,
      signal: {
        type: "TRAIL_SELL",
        lockedProfitPct: t.lockedProfitPct,
        profitPct,
      },
    };
  }

  persistTrailingState(position, t);

  return { shouldSell: false, reason: "holding", position };
}