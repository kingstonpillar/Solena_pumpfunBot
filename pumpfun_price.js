// pumpfun_price.js (ESM, single file)
// Price priority (general, irrespective of curve/migration):
// 0) Jupiter QUOTE (executable price, best general truth when routable)
// 1) Pump.fun API (curve canonical when available)
// 2) Jupiter Price V3 (USD coverage)
// 3) DexScreener fallback (USD -> SOL)
//
// Decimal handling (fix):
// - If record.decimals missing, resolve decimals on-chain from SPL Mint account.
// - SPL Mint layout: decimals is at byte offset 44 (after 4 + 32 + 8).
//
// Env (optional):
// SOLANA_RPC_URL
// HTTP_UA
// JUP_API_KEY
// JUP_PRICE_V3_BASE
// PUMPFUN_INTERVAL_CAP, PUMPFUN_INTERVAL_MS, PUMPFUN_TIMEOUT_MS, PUMPFUN_RETRIES, PUMPFUN_CACHE_TTL_MS
// JUP_INTERVAL_CAP, JUP_INTERVAL_MS, JUP_TIMEOUT_MS, JUP_RETRIES, JUP_CACHE_TTL_MS
// DEX_INTERVAL_CAP, DEX_INTERVAL_MS, DEX_CACHE_TTL_MS
// JUP_QUOTE_INTERVAL_CAP, JUP_QUOTE_INTERVAL_MS, JUP_QUOTE_CACHE_TTL_MS

import "dotenv/config";
import fetch from "node-fetch";
import PQueue from "p-queue";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1_000_000_000;

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const PUMPFUN_TOKEN_URL = (mint) => `https://pump.fun/api/token/${mint}`;
const JUP_QUOTE_URL = (inputMint, outputMint, amountRaw) =>
  `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=50`;

const JUP_PRICE_V3_BASE =
  process.env.JUP_PRICE_V3_BASE || "https://lite-api.jup.ag/price/v3";

const DEX_TOKEN_URL = (mint) => `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

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

const jupQuoteQ = new PQueue({
  intervalCap: Number(process.env.JUP_QUOTE_INTERVAL_CAP || 8),
  interval: Number(process.env.JUP_QUOTE_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

const dexQ = new PQueue({
  intervalCap: Number(process.env.DEX_INTERVAL_CAP || 8),
  interval: Number(process.env.DEX_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

const rpcQ = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

// ---------------- Timeouts / retries ----------------
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
  return (
    status === 429 ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function fetchJson(
  url,
  { label, timeoutMs = 12000, headers = {}, retries = 2 } = {}
) {
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
          await sleep(300 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      const status = e?.status;

      if ((status == null || isRetryableHttp(status)) && attempt < retries) {
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }

  throw lastErr || new Error(`fetchJson failed: ${label || url}`);
}

async function postJson(
  url,
  body,
  { label, timeoutMs = 12000, headers = {}, retries = 2 } = {}
) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
        timeoutMs,
        label || "post"
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`[HTTP ${res.status}] ${label || url} ${text}`.trim());
        err.status = res.status;

        if (isRetryableHttp(res.status) && attempt < retries) {
          await sleep(300 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      const status = e?.status;

      if ((status == null || isRetryableHttp(status)) && attempt < retries) {
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }

  throw lastErr || new Error(`postJson failed: ${label || url}`);
}

// ---------------- Caches ----------------
const PUMPFUN_CACHE_TTL_MS = Number(process.env.PUMPFUN_CACHE_TTL_MS || 2500);
const JUP_CACHE_TTL_MS = Number(process.env.JUP_CACHE_TTL_MS || 2500);
const DEX_CACHE_TTL_MS = Number(process.env.DEX_CACHE_TTL_MS || 2500);
const JUP_QUOTE_CACHE_TTL_MS = Number(process.env.JUP_QUOTE_CACHE_TTL_MS || 2500);

// decimals barely change, so cache long
const DECIMALS_CACHE_TTL_MS = Number(process.env.DECIMALS_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

const pumpCache = new Map();    // mint -> { ts, data }
const jupCache = new Map();     // mint -> { ts, ...data }
const dexCache = new Map();     // mint -> { ts, data }
const quoteCache = new Map();   // mint:decimals -> { ts, data }
const decimalsCache = new Map();// mint -> { ts, decimals }

// ---------------- Helpers ----------------
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pow10(n) {
  return 10 ** n;
}

function isValidDecimals(d) {
  return Number.isInteger(d) && d >= 0 && d <= 18;
}

// ---------------- DECIMALS (ON-CHAIN) ----------------
// SPL Mint layout base part is at least 82 bytes. decimals is at offset 44.
// Works for SPL Token and Token-2022 since base mint fields are at front.
export async function getMintDecimals(mint) {
  const now = Date.now();
  const cached = decimalsCache.get(mint);
  if (cached && now - cached.ts <= DECIMALS_CACHE_TTL_MS) return cached.decimals;

  const headers = { "user-agent": process.env.HTTP_UA || "sol-bot/1.0" };

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [
      mint,
      { encoding: "base64", commitment: "processed" },
    ],
  };

  const json = await rpcQ.add(() =>
    postJson(
      SOLANA_RPC_URL,
      payload,
      {
        label: "solana_rpc_getAccountInfo",
        timeoutMs: Number(process.env.RPC_TIMEOUT_MS || 12000),
        retries: Number(process.env.RPC_RETRIES || 2),
        headers,
      }
    )
  );

  const value = json?.result?.value;
  const dataArr = value?.data;

  if (!value || !Array.isArray(dataArr) || typeof dataArr[0] !== "string") {
    throw new Error(`decimals_unavailable: invalid RPC response for mint ${mint}`);
  }

  const b64 = dataArr[0];
  const buf = Buffer.from(b64, "base64");

  // needs at least offset 44 readable
  if (!buf || buf.length < 45) {
    throw new Error(`decimals_unavailable: mint data too short (${buf?.length}) for ${mint}`);
  }

  const decimals = buf[44];

  if (!isValidDecimals(decimals)) {
    throw new Error(`decimals_unavailable: invalid decimals byte ${decimals} for ${mint}`);
  }

  decimalsCache.set(mint, { ts: now, decimals });
  return decimals;
}

// ---------------- YOUR EXPORT FUNCTION (kept) ----------------
export async function getPriceSOLFromJupQuote(mint, amountRaw) {
  const url = JUP_QUOTE_URL(mint, SOL_MINT, amountRaw);
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j?.outAmount) return null;
  return Number(j.outAmount) / LAMPORTS;
}

// ---------------- Robust Jupiter Quote Price (general) ----------------
export async function getRobustJupQuotePriceSOL(
  mint,
  decimals,
  probeTokens = [1, 5, 10, 25, 50]
) {
  // Resolve decimals if missing
  if (!isValidDecimals(decimals)) {
    decimals = await getMintDecimals(mint);
  }

  const now = Date.now();
  const cacheKey = `${mint}:${decimals}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && now - cached.ts <= JUP_QUOTE_CACHE_TTL_MS) return cached.data;

  for (const amtTokens of probeTokens) {
    const amountRaw = Math.floor(amtTokens * pow10(decimals));
    if (amountRaw <= 0) continue;

    const outSol = await jupQuoteQ.add(() =>
      getPriceSOLFromJupQuote(mint, amountRaw)
    );

    if (outSol && outSol > 0) {
      const priceSOL = outSol / amtTokens;

      const out = {
        priceSOL: Number(priceSOL.toPrecision(12)),
        source: "jupiter_quote",
        probeTokens: amtTokens,
        amountRaw,
        outSol,
        decimals,
      };

      quoteCache.set(cacheKey, { ts: now, data: out });
      return out;
    }
  }

  const out = { error: "jupiter_quote_unavailable", source: "jupiter_quote", decimals };
  quoteCache.set(cacheKey, { ts: now, data: out });
  return out;
}

// ---------------- Pump.fun curve price (secondary) ----------------
function inferTotalSupplyTokens(pumpApiRecord) {
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

  return 1_000_000_000;
}

export async function getPumpfunCurvePriceSOL(mint) {
  const now = Date.now();
  const cached = pumpCache.get(mint);
  if (cached && now - cached.ts <= PUMPFUN_CACHE_TTL_MS) return cached.data;

  const data = await pumpQ.add(() =>
    fetchJson(PUMPFUN_TOKEN_URL(mint), {
      label: "pumpfun_api_token",
      timeoutMs: Number(process.env.PUMPFUN_TIMEOUT_MS || 12000),
      retries: Number(process.env.PUMPFUN_RETRIES || 2),
      headers: {
        accept: "application/json",
        "user-agent": process.env.HTTP_UA || "sol-bot/1.0",
      },
    })
  );

  const solMcap = num(data?.sol_market_cap);
  if (!solMcap || solMcap <= 0) {
    const out = { error: "pumpfun_missing_sol_market_cap", source: "pumpfun_api", raw: data };
    pumpCache.set(mint, { ts: now, data: out });
    return out;
  }

  const totalSupplyTokens = inferTotalSupplyTokens(data);
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

// ---------------- Jupiter Price V3 (USD) ----------------
export async function getJupiterPriceSOL(mint) {
  const now = Date.now();
  const cached = jupCache.get(mint);
  if (cached && now - cached.ts <= JUP_CACHE_TTL_MS) return cached;

  const ids = `${mint},${SOL_MINT}`;
  const url = `${JUP_PRICE_V3_BASE}?ids=${encodeURIComponent(ids)}`;

  const headers = {
    accept: "application/json",
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

// ---------------- DexScreener (USD) ----------------
export async function getPriceUsdFromDexscreener(mint) {
  const json = await dexQ.add(() =>
    fetchJson(DEX_TOKEN_URL(mint), {
      label: "dexscreener_token",
      timeoutMs: Number(process.env.DEX_TIMEOUT_MS || 12000),
      retries: Number(process.env.DEX_RETRIES || 2),
      headers: {
        accept: "application/json",
        "user-agent": process.env.HTTP_UA || "sol-bot/1.0",
      },
    })
  );

  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!pairs.length) return { priceUsd: null, pair: null };

  let best = null;
  let bestLiq = 0;

  for (const p of pairs) {
    const liq = Number(p?.liquidity?.usd || 0);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p;
    }
  }

  const priceUsd = num(best?.priceUsd);
  return { priceUsd: priceUsd ?? null, pair: best };
}

export async function getDexScreenerPriceSOL(mint) {
  const now = Date.now();
  const cached = dexCache.get(mint);
  if (cached && now - cached.ts <= DEX_CACHE_TTL_MS) return cached.data;

  const { priceUsd, pair } = await getPriceUsdFromDexscreener(mint);
  if (!priceUsd || priceUsd <= 0) {
    const out = { error: "dexscreener_no_price", source: "dexscreener", rawPair: pair };
    dexCache.set(mint, { ts: now, data: out });
    return out;
  }

  const sol = await getJupiterPriceSOL(SOL_MINT);
  const solUsd = num(sol?.tokenUsd || sol?.solUsd);

  if (!solUsd || solUsd <= 0) {
    const out = {
      error: "dexscreener_no_sol_usd",
      source: "dexscreener",
      tokenUsd: priceUsd,
      rawPair: pair,
    };
    dexCache.set(mint, { ts: now, data: out });
    return out;
  }

  const priceSOL = priceUsd / solUsd;

  const out = {
    priceSOL: Number(priceSOL.toPrecision(12)),
    source: "dexscreener",
    tokenUsd: priceUsd,
    solUsd,
    pairUrl: pair?.url,
    dexId: pair?.dexId,
    liquidityUsd: Number(pair?.liquidity?.usd || 0),
  };

  dexCache.set(mint, { ts: now, data: out });
  return out;
}

// ---------------- PUBLIC API ----------------
// This returns a price irrespective of "level".
export async function getPumpFunPriceOnce(record) {
  if (!record?.mint) return { error: "missing_mint" };

  const mint = record.mint;

  // Always resolve decimals safely:
  // - If record.decimals provided, trust only if valid.
  // - Otherwise fetch from chain.
  let decimals = Number(record.decimals);
  if (!isValidDecimals(decimals)) {
    try {
      decimals = await getMintDecimals(mint);
    } catch (e) {
      // If decimals fetch fails, we still attempt other sources,
      // but quote-based price will likely fail or be wrong without decimals.
      decimals = null;
    }
  }

  // 0) Jupiter quote executable price (general truth when routable)
  if (isValidDecimals(decimals)) {
    const q = await getRobustJupQuotePriceSOL(mint, decimals);
    if (q?.priceSOL && q.priceSOL > 0) return q;
  }

  // 1) Pump.fun API (curve canonical)
  const pump = await getPumpfunCurvePriceSOL(mint);
  if (pump?.priceSOL && pump.priceSOL > 0) return pump;

  // 2) Jupiter price v3
  const jup = await getJupiterPriceSOL(mint);
  if (jup?.priceSOL && jup.priceSOL > 0) {
    return {
      priceSOL: jup.priceSOL,
      source: jup.source,
      tokenUsd: jup.tokenUsd,
      solUsd: jup.solUsd,
      decimals: isValidDecimals(decimals) ? decimals : null,
    };
  }

  // 3) DexScreener fallback
  const dex = await getDexScreenerPriceSOL(mint);
  if (dex?.priceSOL && dex.priceSOL > 0) {
    return { ...dex, decimals: isValidDecimals(decimals) ? decimals : null };
  }

  return {
    error: "price_unavailable",
    mint,
    decimals: isValidDecimals(decimals) ? decimals : null,
    note: isValidDecimals(decimals)
      ? null
      : "decimals_unavailable_from_chain_so_quote_price_skipped",
  };
}

// Optional helper if you still want USD for other parts
export async function getPumpfunPriceUsd(mint) {
  const { priceUsd, pair } = await getPriceUsdFromDexscreener(mint);
  return {
    mint,
    priceUsd,
    source: "dexscreener",
    pairUrl: pair?.url,
    dexId: pair?.dexId,
    liquidityUsd: Number(pair?.liquidity?.usd || 0),
  };
}