// pumpfun_price.js (ESM)
// Price source priority:
// 1) Pump.fun API (bonding curve phase / canonical for pump)
// 2) Jupiter Price V3 (post-migration / any DEX with Jup price coverage)
//
// Notes:
// - Pump.fun tokens typically have total supply = 1e9 tokens (decimals=6, raw supply=1e15).
// - Pump.fun API often returns sol_market_cap; we compute priceSOL = sol_market_cap / totalSupplyTokens.
// - Jupiter Price V3 returns USD; we convert token->SOL via tokenUSD / solUSD.
// - You cannot "avoid" rate limits completely. You reduce them via batching, caching, throttling, and optionally an API key.

import "dotenv/config";
import PQueue from "p-queue";

const PUMPFUN_TOKEN_URL = (mint) => `https://pump.fun/api/token/${mint}`;

// Jupiter docs: https://lite-api.jup.ag/price/v3?ids=...
// We'll query token + SOL in one request to reduce calls.
const JUP_PRICE_V3_BASE =
  process.env.JUP_PRICE_V3_BASE || "https://lite-api.jup.ag/price/v3";

// ---------------- Rate control ----------------
const pumpQ = new PQueue({
  intervalCap: Number(process.env.PUMPFUN_INTERVAL_CAP || 6),
  interval: Number(process.env.PUMPFUN_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

const jupQ = new PQueue({
  intervalCap: Number(process.env.JUP_INTERVAL_CAP || 8),
  interval: Number(process.env.JUP_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

// Basic timeouts
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[TIMEOUT] ${label} after ${ms}ms`)), ms)
    ),
  ]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableHttp(status) {
  return status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchJson(url, { label, timeoutMs = 12000, headers = {}, retries = 3 } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(
        fetch(url, { headers }),
        timeoutMs,
        label || "fetch"
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`[HTTP ${res.status}] ${label || url} ${body}`.trim());
        err.status = res.status;

        if (isRetryableHttp(res.status) && attempt < retries) {
          const backoff = 300 * Math.pow(2, attempt);
          await sleep(backoff);
          continue;
        }
        throw err;
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      const status = e?.status;

      // network errors or retryable statuses
      if ((status == null || isRetryableHttp(status)) && attempt < retries) {
        const backoff = 300 * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      break;
    }
  }

  throw lastErr || new Error(`fetchJson failed: ${label || url}`);
}

// ---------------- Caches ----------------
const PUMPFUN_CACHE_TTL_MS = Number(process.env.PUMPFUN_CACHE_TTL_MS || 2500);
const JUP_CACHE_TTL_MS = Number(process.env.JUP_CACHE_TTL_MS || 2500);

const pumpCache = new Map(); // mint -> { ts, data }
const jupCache = new Map(); // mint -> { ts, priceSOL, raw }

// ---------------- Helpers ----------------
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Pump.fun tokens are usually 1,000,000,000 supply (decimals=6 => raw=1e15).
function inferTotalSupplyTokens(pumpApiRecord) {
  // If pump.fun API ever adds supply fields, use them.
  const supplyCandidates = [
    pumpApiRecord?.total_supply,
    pumpApiRecord?.totalSupply,
    pumpApiRecord?.supply,
    pumpApiRecord?.token_total_supply,
  ];

  for (const v of supplyCandidates) {
    const n = num(v);
    if (n && n > 0) return n;
  }

  // Default for Pump.fun mints
  return 1_000_000_000;
}

async function getPumpfunCurvePriceSOL(mint) {
  const now = Date.now();
  const cached = pumpCache.get(mint);
  if (cached && now - cached.ts <= PUMPFUN_CACHE_TTL_MS) return cached.data;

  const data = await pumpQ.add(() =>
    fetchJson(PUMPFUN_TOKEN_URL(mint), {
      label: "pumpfun_api_token",
      timeoutMs: Number(process.env.PUMPFUN_TIMEOUT_MS || 12000),
      retries: Number(process.env.PUMPFUN_RETRIES || 2),
      headers: {
        "accept": "application/json",
        "user-agent": process.env.HTTP_UA || "sol-bot/1.0",
      },
    })
  );

  // Expected fields (based on what you pasted):
  // { mint, name, symbol, complete, sol_market_cap, curve_address, created_timestamp, ... }
  const solMcap = num(data?.sol_market_cap);
  if (!solMcap || solMcap <= 0) {
    const out = {
      error: "pumpfun_missing_sol_market_cap",
      source: "pumpfun_api",
      raw: data,
    };
    pumpCache.set(mint, { ts: now, data: out });
    return out;
  }

  const totalSupplyTokens = inferTotalSupplyTokens(data);

  // price in SOL per token
  const priceSOL = solMcap / totalSupplyTokens;

  const out = {
    priceSOL: Number(priceSOL.toPrecision(12)),
    source: "pumpfun_api",
    phase: data?.complete ? "complete_or_migrated" : "bonding_curve",
    mint: data?.mint || mint,
    name: data?.name || null,
    symbol: data?.symbol || null,
    complete: Boolean(data?.complete),
    curveAddress: data?.curve_address || null,
    solMarketCap: solMcap,
    totalSupplyTokens,
    createdTimestamp: typeof data?.created_timestamp === "number" ? data.created_timestamp : null,
  };

  pumpCache.set(mint, { ts: now, data: out });
  return out;
}

async function getJupiterPriceSOL(mint) {
  const now = Date.now();
  const cached = jupCache.get(mint);
  if (cached && now - cached.ts <= JUP_CACHE_TTL_MS) return cached;

  // Jupiter Price V3 returns USD for tokens.
  // We fetch both token and SOL in one call, then do tokenUSD / solUSD.
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const ids = `${mint},${SOL_MINT}`;

  const url = `${JUP_PRICE_V3_BASE}?ids=${encodeURIComponent(ids)}`;

  // Optional Jupiter API key (higher limits). If you have one, set JUP_API_KEY.
  const headers = {
    "accept": "application/json",
    "user-agent": process.env.HTTP_UA || "sol-bot/1.0",
  };
  if (process.env.JUP_API_KEY) headers["x-api-key"] = process.env.JUP_API_KEY;

  const json = await jupQ.add(() =>
    fetchJson(url, {
      label: "jupiter_price_v3",
      timeoutMs: Number(process.env.JUP_TIMEOUT_MS || 12000),
      retries: Number(process.env.JUP_RETRIES || 2),
      headers,
    })
  );

  // Typical structure: { data: { <mint>: { price: <usd>, ... }, <SOL_MINT>: { price: <usd> } } }
  const tokenUsd = num(json?.data?.[mint]?.price);
  const solUsd = num(json?.data?.[SOL_MINT]?.price);

  if (!tokenUsd || !solUsd || tokenUsd <= 0 || solUsd <= 0) {
    const out = {
      error: "jupiter_price_unavailable",
      source: "jupiter_price_v3",
      tokenUsd: tokenUsd ?? null,
      solUsd: solUsd ?? null,
      raw: json,
    };
    jupCache.set(mint, { ts: now, ...out });
    return out;
  }

  const priceSOL = tokenUsd / solUsd;

  const out = {
    priceSOL: Number(priceSOL.toPrecision(12)),
    source: "jupiter_price_v3",
    tokenUsd,
    solUsd,
  };

  jupCache.set(mint, { ts: now, ...out });
  return out;
}

// ---------------- PUBLIC API ----------------
// Keep your signature exactly:
export async function getPumpFunPriceOnce(record) {
  if (!record?.mint) return { error: "missing_mint" };

  const mint = record.mint;

  // 1) Pump.fun API first (covers bonding curve, and often still reports even after complete)
  const pump = await getPumpfunCurvePriceSOL(mint);

  // If pump.fun returns a usable price, take it.
  if (pump?.priceSOL && pump.priceSOL > 0) {
    return pump;
  }

  // 2) Fallback: Jupiter (useful after migration, any DEX Jup indexes)
  const jup = await getJupiterPriceSOL(mint);
  if (jup?.priceSOL && jup.priceSOL > 0) {
    return {
      priceSOL: jup.priceSOL,
      source: jup.source,
      tokenUsd: jup.tokenUsd,
      solUsd: jup.solUsd,
    };
  }

  return {
    error: "price_unavailable",
    mint,
    pumpfunError: pump?.error || null,
    jupiterError: jup?.error || null,
  };
}