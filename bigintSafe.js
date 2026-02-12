/* ===========================================================
    BIGINT SAFE UTILITIES (NO THROW / NO ASSERT)
    Fully ESM, compatible with import { biMin } ...
=========================================================== */

/* ---------- NORMALIZE ---------- */
export function BI(value, fallback = 0n) {
  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fallback;
    return BigInt(Math.trunc(value));
  }

  if (typeof value === "string") {
    if (!value.trim()) return fallback;
    try { return BigInt(value); } catch { return fallback; }
  }

  if (value && typeof value === "object") {
    try { return BigInt(value.toString()); } catch {}
  }

  return fallback;
}

/* ---------- MATH ---------- */
export function biAdd(a, b) {
  return BI(a) + BI(b);
}

export function biSub(a, b) {
  const r = BI(a) - BI(b);
  return r < 0n ? 0n : r;
}

export function biMul(a, b) {
  return BI(a) * BI(b);
}

export function biDiv(a, b) {
  const d = BI(b);
  return d === 0n ? 0n : BI(a) / d;
}

/* ---------- PERCENT ---------- */
export function biPct(diff, base) {
  const b = BI(base);
  if (b === 0n) return 0n;
  return (BI(diff) * 100n) / b;
}

/* ---------- COMPARE ---------- */
export function biGt(a, b) { return BI(a) > BI(b); }
export function biGte(a, b) { return BI(a) >= BI(b); }
export function biLt(a, b) { return BI(a) < BI(b); }
export function biLte(a, b) { return BI(a) <= BI(b); }

/* ---------- MIN / MAX ---------- */
export function biMin(a, b) {
  return BI(a) < BI(b) ? BI(a) : BI(b);
}

export function biMax(a, b) {
  return BI(a) > BI(b) ? BI(a) : BI(b);
}

/* ---------- EQUALITY ---------- */
export function biEq(a, b) {
  return BI(a) === BI(b);
}

/* ---------- OUTPUT ---------- */
export function biStr(v) {
  return BI(v).toString();
}