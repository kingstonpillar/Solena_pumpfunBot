// pumpfun_price.js (ESM, single file)
// General price (no curve/migration, no pump.fun API).
// Keeps your required export: getPumpFunPriceOnce(record)
//
// Priority:
// 1) Jupiter QUOTE (executable) via YOUR export function getPriceSOLFromJupQuote()
// 2) Jupiter Price V3 (USD -> SOL)
// 3) DexScreener (USD -> SOL using Jupiter SOL/USD)
//
// Fix decimals via on-chain SPL Mint decimals (byte offset 44) + BigInt probes.

import "dotenv/config";
import fetch from "node-fetch";
import PQueue from "p-queue";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const JUP_QUOTE_BASE = process.env.JUP_QUOTE_BASE || "https://api.jup.ag";
const JUP_PRICE_V3_BASE = process.env.JUP_PRICE_V3_BASE || "https://lite-api.jup.ag/price/v3";
const DEX_TOKEN_URL = (mint) => `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

const JUP_QUOTE_URL = (inputMint, outputMint, amountRawStr) =>
  `${JUP_QUOTE_BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRawStr}&slippageBps=50`;

// ---------------- Queues ----------------
const qQuote = new PQueue({
  intervalCap: Number(process.env.JUP_QUOTE_INTERVAL_CAP || 8),
  interval: Number(process.env.JUP_QUOTE_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

const qJup = new PQueue({
  intervalCap: Number(process.env.JUP_INTERVAL_CAP || 8),
  interval: Number(process.env.JUP_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

const qDex = new PQueue({
  intervalCap: Number(process.env.DEX_INTERVAL_CAP || 8),
  interval: Number(process.env.DEX_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

const qRpc = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

// ---------------- Utils ----------------
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[TIMEOUT] ${label} after ${ms}ms`)), ms)
    ),
  ]);
}

function isValidDecimals(d) {
  return Number.isInteger(d) && d >= 0 && d <= 18;
}

function pow10BigInt(decimals) {
  return 10n ** BigInt(decimals);
}

function toBI(x) {
  try {
    return BigInt(String(x));
  } catch {
    return null;
  }
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, { label, timeoutMs = 12000, headers = {} } = {}) {
  const res = await withTimeout(fetch(url, { headers }), timeoutMs, label || url);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = json?.message || json?.error || text;
    const err = new Error(`[HTTP ${res.status}] ${label || url} ${msg}`.trim());
    err.status = res.status;
    throw err;
  }
  return json;
}

async function postJson(url, body, { label, timeoutMs = 12000, headers = {} } = {}) {
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    timeoutMs,
    label || url
  );

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = json?.message || json?.error || text;
    const err = new Error(`[HTTP ${res.status}] ${label || url} ${msg}`.trim());
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---------------- Decimals (on-chain) ----------------
// SPL Mint decimals at byte offset 44 of base mint data.
export async function getMintDecimals(mint) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [mint, { encoding: "base64", commitment: "processed" }],
  };

  const json = await qRpc.add(() =>
    postJson(SOLANA_RPC_URL, payload, {
      label: "rpc_getAccountInfo",
      timeoutMs: Number(process.env.RPC_TIMEOUT_MS || 12000),
      headers: { "user-agent": process.env.HTTP_UA || "sol-bot/1.0" },
    })
  );

  const v = json?.result?.value;
  const dataArr = v?.data;
  if (!v || !Array.isArray(dataArr) || typeof dataArr[0] !== "string") {
    throw new Error(`decimals_unavailable: bad RPC response for ${mint}`);
  }

  const buf = Buffer.from(dataArr[0], "base64");
  if (buf.length < 45) throw new Error(`decimals_unavailable: mint data too short for ${mint}`);

  const decimals = buf[44];
  if (!isValidDecimals(decimals)) throw new Error(`decimals_unavailable: invalid decimals ${decimals} for ${mint}`);
  return decimals;
}

// ---------------- YOUR EXPORT FUNCTION (keep it) ----------------
export async function getPriceSOLFromJupQuote(mint, amountRaw) {
  const amountRawStr = typeof amountRaw === "bigint" ? amountRaw.toString() : String(amountRaw);

  const headers = { accept: "application/json" };
  if (process.env.JUP_API_KEY) headers["x-api-key"] = process.env.JUP_API_KEY;

  const url = JUP_QUOTE_URL(mint, SOL_MINT, amountRawStr);

  const j = await qQuote.add(() =>
    fetchJson(url, {
      label: "jupiter_quote",
      timeoutMs: Number(process.env.JUP_TIMEOUT_MS || 12000),
      headers,
    })
  );

  const outLamports = toBI(j?.outAmount);
  if (!outLamports || outLamports <= 0n) return null;

  // safe enough for our probe sizes; avoids decimals bugs
  const sol = Number(outLamports) / 1e9;
  return Number.isFinite(sol) ? sol : null;
}

// ---------------- Quote-driven SOL/token price ----------------
async function getQuotePriceSOLPerToken(mint, decimals) {
  // probe sizes to avoid min-route + rounding issues
  const probes = [1n, 5n, 10n, 25n, 50n];

  for (const tokens of probes) {
    const amountRaw = tokens * pow10BigInt(decimals);
    const outSol = await getPriceSOLFromJupQuote(mint, amountRaw);

    if (outSol && outSol > 0) {
      const priceSOL = outSol / Number(tokens);
      return {
        priceSOL: Number(priceSOL.toPrecision(12)),
        source: "jupiter_quote",
        decimals,
        probeTokens: tokens.toString(),
        amountRaw: amountRaw.toString(),
        outSol,
      };
    }
  }

  return { error: "jupiter_quote_unavailable", source: "jupiter_quote", decimals };
}

// ---------------- Jupiter Price V3 fallback (USD -> SOL) ----------------
export async function getJupiterPriceSOLFallback(mint) {
  const ids = `${mint},${SOL_MINT}`;
  const url = `${JUP_PRICE_V3_BASE}?ids=${encodeURIComponent(ids)}`;

  const headers = { accept: "application/json" };
  if (process.env.JUP_API_KEY) headers["x-api-key"] = process.env.JUP_API_KEY;

  const json = await qJup.add(() =>
    fetchJson(url, {
      label: "jupiter_price_v3",
      timeoutMs: Number(process.env.JUP_TIMEOUT_MS || 12000),
      headers,
    })
  );

  const tokenUsd = num(json?.data?.[mint]?.price);
  const solUsd = num(json?.data?.[SOL_MINT]?.price);
  if (!tokenUsd || !solUsd || tokenUsd <= 0 || solUsd <= 0) {
    return { error: "jupiter_price_unavailable", source: "jupiter_price_v3", raw: json };
  }

  return {
    priceSOL: Number((tokenUsd / solUsd).toPrecision(12)),
    source: "jupiter_price_v3",
    tokenUsd,
    solUsd,
  };
}

// ---------------- DexScreener fallback (USD -> SOL) ----------------
export async function getDexScreenerPriceSOLFallback(mint) {
  const json = await qDex.add(() =>
    fetchJson(DEX_TOKEN_URL(mint), {
      label: "dexscreener_token",
      timeoutMs: Number(process.env.DEX_TIMEOUT_MS || 12000),
      headers: { accept: "application/json" },
    })
  );

  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!pairs.length) return { error: "dexscreener_no_pairs", source: "dexscreener" };

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
  if (!priceUsd || priceUsd <= 0) return { error: "dexscreener_no_price", source: "dexscreener", pair: best };

  const sol = await getJupiterPriceSOLFallback(SOL_MINT);
  const solUsd = num(sol?.solUsd || sol?.tokenUsd);
  if (!solUsd || solUsd <= 0) return { error: "no_sol_usd", source: "dexscreener", tokenUsd: priceUsd };

  return {
    priceSOL: Number((priceUsd / solUsd).toPrecision(12)),
    source: "dexscreener",
    tokenUsd: priceUsd,
    solUsd,
    pairUrl: best?.url,
    dexId: best?.dexId,
    liquidityUsd: Number(best?.liquidity?.usd || 0),
  };
}

// ---------------- Optional one-call helper ----------------
export async function getPriceSOL(mint, decimalsMaybe) {
  // 1) Quote
  try {
    let decimals = Number(decimalsMaybe);
    if (!isValidDecimals(decimals)) decimals = await getMintDecimals(mint);
    const q = await getQuotePriceSOLPerToken(mint, decimals);
    if (q?.priceSOL && q.priceSOL > 0) return q;
  } catch {}

  // 2) Jupiter price v3
  try {
    const p = await getJupiterPriceSOLFallback(mint);
    if (p?.priceSOL && p.priceSOL > 0) return p;
  } catch {}

  // 3) DexScreener
  try {
    const d = await getDexScreenerPriceSOLFallback(mint);
    if (d?.priceSOL && d.priceSOL > 0) return d;
  } catch {}

  return { error: "price_unavailable", mint };
}

// ---------------- REQUIRED EXPORT: do not rename ----------------
export async function getPumpFunPriceOnce(record) {
  if (!record?.mint) return { error: "missing_mint" };

  const mint = String(record.mint).trim();
  let decimals = Number(record.decimals);

  // decimals fix: if missing/invalid, fetch on-chain
  if (!isValidDecimals(decimals)) {
    try {
      decimals = await getMintDecimals(mint);
    } catch {
      decimals = null;
    }
  }

  // 1) Jupiter Quote using YOUR export function
  if (isValidDecimals(decimals)) {
    const q = await getQuotePriceSOLPerToken(mint, decimals);
    if (q?.priceSOL && q.priceSOL > 0) return q;
  }

  // 2) Jupiter Price V3
  const p = await getJupiterPriceSOLFallback(mint);
  if (p?.priceSOL && p.priceSOL > 0) return { ...p, decimals: isValidDecimals(decimals) ? decimals : null };

  // 3) DexScreener
  const d = await getDexScreenerPriceSOLFallback(mint);
  if (d?.priceSOL && d.priceSOL > 0) return { ...d, decimals: isValidDecimals(decimals) ? decimals : null };

  return {
    error: "price_unavailable",
    mint,
    decimals: isValidDecimals(decimals) ? decimals : null,
  };
}

// ---------------- CLI test ----------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const mint = process.argv[2];
  if (!mint) {
    console.log("Usage: node pumpfun_price.js <mint>");
    process.exit(1);
  }
  const out = await getPumpFunPriceOnce({ mint });
  console.log(JSON.stringify(out, null, 2));
}