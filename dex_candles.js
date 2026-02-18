// dex_candles.js (ESM)
// Birdeye-backed candle fetcher with request throttling + lightweight caching

import "dotenv/config";

const BIRDEYE_BASE = "https://public-api.birdeye.so";
const API_KEY = process.env.BIRDEYE_API_KEY;

const CHAIN = process.env.BIRDEYE_CHAIN || "solana";

// Rate control (global)
const MIN_INTERVAL_MS = Number(process.env.BIRDEYE_MIN_INTERVAL_MS || 800);
let lastRequestTs = 0;

// Simple in-memory cache per mint+tf
const cache = new Map(); // key -> { ts, data }
const CACHE_TTL_MS = Number(process.env.BIRDEYE_CACHE_TTL_MS || 10_000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle() {
  const now = Date.now();
  const diff = now - lastRequestTs;
  if (diff < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - diff);
  }
  lastRequestTs = Date.now();
}

function tfToBirdeye(timeframe) {
  const map = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
  return map[String(timeframe).toLowerCase()] || "5m";
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

export async function getCandles({
  pairAddress, // here: token mint
  timeframe = "5m",
  limit = 120,
} = {}) {
  if (!API_KEY) {
    console.log("[BIRDEYE] Missing API key");
    return null;
  }
  if (!pairAddress) return null;

  const tf = tfToBirdeye(timeframe);
  const key = `${CHAIN}:${pairAddress}_${tf}_${Number(limit)}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  await throttle();

  const url =
    `${BIRDEYE_BASE}/defi/ohlcv` +
    `?address=${encodeURIComponent(pairAddress)}` +
    `&type=${encodeURIComponent(tf)}` +
    `&limit=${Number(limit)}` +
    `&chain=${encodeURIComponent(CHAIN)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-API-KEY": API_KEY,
      accept: "application/json",
    },
  }).catch(() => null);

  if (!res || !res.ok) {
    console.log("[BIRDEYE] fetch failed", res?.status);
    return null;
  }

  const json = await res.json().catch(() => null);
  const items = json?.data?.items;
  if (!Array.isArray(items) || !items.length) return null;

  // Normalize: [{ t, o, h, l, c, v }]
  const candles = items
    .map((x) => {
      const o = num(x.o);
      const h = num(x.h);
      const l = num(x.l);
      const c = num(x.c);

      // volume field variations
      const v = num(x.v ?? x.volume ?? x.vol);

      const unix = Number(x.unixTime);
      const t = Number.isFinite(unix) ? unix * 1000 : NaN;

      if (![t, o, h, l, c, v].every(Number.isFinite)) return null;

      return { t, o, h, l, c, v };
    })
    .filter(Boolean);

  if (!candles.length) return null;

  cache.set(key, { ts: Date.now(), data: candles });
  return candles;
}