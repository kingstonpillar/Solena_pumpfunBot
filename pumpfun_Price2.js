// pumpfun_Price2.js
// ESM, single file
// Priority:
// 1) On-chain price first
//    - Pump bonding curve price if not migrated
//    - PumpSwap vault price if migrated
// 2) Jupiter fallback only
//
// Removed:
// - DexScreener
// - Jupiter Price V3
// - canonical mint resolver
// - extra fallback logic
//
// Keeps required export:
//   getPumpFunPriceOnce(recordOrMint)

import "dotenv/config";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { resolvePumpSwapPool } from "./poolResolver.js";
import { withRpcLimit } from "./rpcLimiter.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL2 || "https://api.mainnet-beta.solana.com";

const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const pumpAmmSdk = new OnlinePumpAmmSdk(connection);

const PUMP_PROGRAM_ID = new PublicKey(
  process.env.PUMPFUN_PROGRAM_ID ||
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const JUP_API_KEY = process.env.JUP_API_KEY || "";
const JUP_QUOTE_BASE = process.env.JUP_QUOTE_BASE || "https://api.jup.ag";

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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[TIMEOUT] ${label} after ${ms}ms`)), ms)
    ),
  ]);
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

// ---------------- On-chain helpers ----------------

export function decodePumpBondingCurve(data) {
  if (!Buffer.isBuffer(data)) {
    throw new Error("decodePumpBondingCurve: data must be a Buffer");
  }

  if (data.length < 49) {
    throw new Error(
      `decodePumpBondingCurve: account too small (${data.length} bytes)`
    );
  }

  let offset = 0;

  const readU64 = () => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };

  const discriminator = readU64();
  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = data.readUInt8(offset) !== 0;

  return {
    discriminator,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

export function calcPumpCurvePriceSol(curve, tokenDecimals = 6) {
  if (!curve) return null;
  if (curve.virtualTokenReserves === 0n) return null;
  if (curve.virtualSolReserves === 0n) return null;

  return (
    (Number(curve.virtualSolReserves) / 1e9) /
    (Number(curve.virtualTokenReserves) / 10 ** tokenDecimals)
  );
}

export async function calcPumpSwapPriceFromVaults(poolPk) {
  const poolData = await withRpcLimit(() => pumpAmmSdk.fetchPool(poolPk));

  const [baseBal, quoteBal] = await Promise.all([
    withRpcLimit(() =>
      connection.getTokenAccountBalance(poolData.poolBaseTokenAccount)
    ),
    withRpcLimit(() =>
      connection.getTokenAccountBalance(poolData.poolQuoteTokenAccount)
    ),
  ]);

  const baseAmount = Number(baseBal.value.amount);
  const quoteAmount = Number(quoteBal.value.amount);
  const baseDecimals = baseBal.value.decimals;
  const quoteDecimals = quoteBal.value.decimals;

  if (!baseAmount || !quoteAmount) return null;

  const priceInQuote =
    (quoteAmount / 10 ** quoteDecimals) /
    (baseAmount / 10 ** baseDecimals);

  return {
    priceInQuote,
    baseAmountRaw: baseAmount,
    quoteAmountRaw: quoteAmount,
    baseDecimals,
    quoteDecimals,
    poolData,
  };
}

async function getOnchainPumpPrice(mint) {
  const mintPk =
    mint instanceof PublicKey ? mint : new PublicKey(String(mint).trim());

  // 1. Bonding curve first
  const [bondingCurvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPk.toBuffer()],
    PUMP_PROGRAM_ID
  );

  const curveAcc = await withRpcLimit(() =>
    connection.getAccountInfo(bondingCurvePda)
  );

  if (curveAcc) {
    const curve = decodePumpBondingCurve(curveAcc.data);

    if (!curve.complete) {
      const priceSol = calcPumpCurvePriceSol(curve, 6);

      if (priceSol && priceSol > 0) {
        return {
          priceSOL: Number(priceSol.toPrecision(12)),
          source: "pumpfun_curve",
          migrated: false,
          curve,
        };
      }
    }
  }

  // 2. Migrated PumpSwap pool
  const poolPk = await resolvePumpSwapPool(mintPk);
  if (!poolPk) {
    return {
      error: "onchain_pool_not_resolved",
      source: "onchain",
      migrated: true,
    };
  }

  const amm = await calcPumpSwapPriceFromVaults(poolPk);
  if (!amm || !amm.priceInQuote || amm.priceInQuote <= 0) {
    return {
      error: "onchain_pool_price_unavailable",
      source: "onchain",
      migrated: true,
      pool: poolPk.toBase58(),
    };
  }

  return {
    priceSOL: Number(amm.priceInQuote.toPrecision(12)),
    source: "pumpswap_pool",
    migrated: true,
    pool: poolPk.toBase58(),
    baseVault: amm.poolData.poolBaseTokenAccount.toBase58(),
    quoteVault: amm.poolData.poolQuoteTokenAccount.toBase58(),
    reserves: {
      baseAmountRaw: amm.baseAmountRaw,
      quoteAmountRaw: amm.quoteAmountRaw,
      baseDecimals: amm.baseDecimals,
      quoteDecimals: amm.quoteDecimals,
    },
  };
}

// ---------------- Jupiter fallback only ----------------

const JUP_QUOTE_URL = (inputMint, outputMint, amountRawStr) =>
  `${JUP_QUOTE_BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRawStr}&slippageBps=50`;

export async function getMintDecimals(mint) {
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(String(mint).trim());

  const acc = await withRpcLimit(() => connection.getAccountInfo(mintPk));
  if (!acc?.data || acc.data.length < 45) {
    throw new Error(`decimals_unavailable: bad mint account for ${mintPk.toBase58()}`);
  }

  const decimals = acc.data[44];
  if (!isValidDecimals(decimals)) {
    throw new Error(
      `decimals_unavailable: invalid decimals ${decimals} for ${mintPk.toBase58()}`
    );
  }

  return decimals;
}

export async function getPriceSOLFromJupQuote(mint, amountRaw) {
  const amountRawStr =
    typeof amountRaw === "bigint" ? amountRaw.toString() : String(amountRaw);

  const headers = {
    accept: "application/json",
  };

  if (JUP_API_KEY) {
    headers["x-api-key"] = JUP_API_KEY;
  }

  const url = JUP_QUOTE_URL(mint, SOL_MINT, amountRawStr);

  const j = await fetchJson(url, {
    label: "jupiter_quote",
    timeoutMs: Number(process.env.JUP_TIMEOUT_MS || 12000),
    headers,
  });

  const outLamports = toBI(j?.outAmount);
  if (!outLamports || outLamports <= 0n) return null;

  const sol = Number(outLamports) / 1e9;
  return Number.isFinite(sol) ? sol : null;
}

async function getQuotePriceSOLPerToken(mint, decimals) {
  const probes = [1n, 5n, 10n, 25n, 50n];

  for (const tokens of probes) {
    const amountRaw = tokens * pow10BigInt(decimals);

    try {
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
    } catch {
      // keep probing
    }
  }

  return {
    error: "jupiter_quote_unavailable",
    source: "jupiter_quote",
    decimals,
  };
}

// ---------------- REQUIRED EXPORT ----------------

export async function getPumpFunPriceOnce(recordOrMint) {
  if (!recordOrMint) {
    return { error: "missing_input" };
  }

  const mint =
    typeof recordOrMint === "object" && recordOrMint
      ? String(recordOrMint.mint || "").trim()
      : String(recordOrMint).trim();

  if (!mint) {
    return { error: "missing_mint" };
  }

  let mintPk;
  try {
    mintPk = new PublicKey(mint);
  } catch {
    return {
      error: "invalid_mint",
      mint,
    };
  }

  // ---------------- ON-CHAIN FIRST ----------------
  try {
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPk.toBuffer()],
      PUMP_PROGRAM_ID
    );

    const curveAcc = await withRpcLimit(() =>
      connection.getAccountInfo(bondingCurvePda)
    );

    if (curveAcc) {
      const curve = decodePumpBondingCurve(curveAcc.data);

      if (!curve.complete) {
        const priceSOL = calcPumpCurvePriceSol(curve, 6);

        if (priceSOL && priceSOL > 0) {
          return {
            source: "pumpfun_curve",
            migrated: false,
            priceSOL,
            curve,
          };
        }
      }
    }

    // ---------------- MIGRATED → PUMPSWAP ----------------
    const poolPk = await resolvePumpSwapPool(mintPk);

    if (poolPk) {
      const amm = await calcPumpSwapPriceFromVaults(poolPk);

      if (amm && amm.priceInQuote > 0) {
        return {
          source: "pumpswap_pool",
          migrated: true,
          priceSOL: amm.priceInQuote,
          pool: poolPk.toBase58(),
          baseVault: amm.poolData?.poolBaseTokenAccount?.toBase58?.() ?? null,
          quoteVault: amm.poolData?.poolQuoteTokenAccount?.toBase58?.() ?? null,
          reserves: {
            baseAmountRaw: amm.baseAmountRaw,
            quoteAmountRaw: amm.quoteAmountRaw,
            baseDecimals: amm.baseDecimals,
            quoteDecimals: amm.quoteDecimals,
          },
        };
      }
    }
  } catch (e) {
    console.log(`[PRICE_ONCHAIN_FAIL] mint=${mint} err=${e?.message || e}`);
  }

  // ---------------- JUPITER FALLBACK ----------------
  try {
    let decimals =
      typeof recordOrMint === "object" &&
      recordOrMint &&
      Number.isInteger(Number(recordOrMint.decimals))
        ? Number(recordOrMint.decimals)
        : null;

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      decimals = await getMintDecimals(mint);
    }

    const probes = [1n, 5n, 10n];

    for (const tokens of probes) {
      const amountRaw = tokens * (10n ** BigInt(decimals));

      const outSol = await getPriceSOLFromJupQuote(mint, amountRaw);

      if (outSol && outSol > 0) {
        return {
          source: "jupiter_quote",
          migrated: true,
          priceSOL: outSol / Number(tokens),
          decimals,
          probeTokens: tokens.toString(),
          amountRaw: amountRaw.toString(),
        };
      }
    }
  } catch (e) {
    console.log(`[PRICE_JUP_FAIL] mint=${mint} err=${e?.message || e}`);
  }

  return {
    error: "price_unavailable",
    mint,
    priceSOL: null,
  };
}