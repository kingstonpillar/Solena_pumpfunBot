// poolResolver2.js
import dotenv from 'dotenv';
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import POOL_CACHE from "./poolCache.js";
import { withRpcLimit } from "./rpcLimiter.js";

dotenv.config();

const RPC_URLS = [
  process.env.RPC_URL_14,
  process.env.RPC_URL_15,
].filter(Boolean);

let rpcIndex = 0;
function getNextConnection() {
  const url = RPC_URLS[rpcIndex % RPC_URLS.length];
  rpcIndex++;
  return new Connection(url, { commitment: "confirmed" });
}

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = process.env.USDT_MINT || null;

/**
 * Resolve best PumpSwap stable pool for WSOL
 * Priority:
 * 1. WSOL/USDC
 * 2. WSOL/USDT
 * 3. Highest liquidity
 */
export async function resolveSolStablePool() {
  const cacheKey = "sol_stable_pool";

  if (POOL_CACHE.has(cacheKey)) {
    return POOL_CACHE.get(cacheKey);
  }

  return await withRpcLimit(async () => {
    console.log(`🔎 Resolving PumpSwap stable pool for WSOL`);

    const url = `https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`;
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": process.env.HTTP_UA || "Solena_pumpfunBot/1.0",
      },
    });

    if (!res.ok) {
      throw new Error(`DexScreener lookup failed: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

    const stablePairs = pairs
      .filter((p) => {
        if (p?.chainId !== "solana") return false;

        const dexId = String(p?.dexId || "").toLowerCase();
        if (!(dexId === "pumpswap" || dexId.includes("pump"))) return false;

        if (!p?.pairAddress) return false;

        const baseMint = String(p?.baseToken?.address || "");
        const quoteMint = String(p?.quoteToken?.address || "");

        const hasWsol = baseMint === WSOL_MINT || quoteMint === WSOL_MINT;
        if (!hasWsol) return false;

        const otherMint = baseMint === WSOL_MINT ? quoteMint : baseMint;

        return otherMint === USDC_MINT || (USDT_MINT && otherMint === USDT_MINT);
      })
      .map((p) => {
        const baseMint = String(p?.baseToken?.address || "");
        const quoteMint = String(p?.quoteToken?.address || "");
        const otherMint = baseMint === WSOL_MINT ? quoteMint : baseMint;

        let priority = 99;
        if (otherMint === USDC_MINT) priority = 1;
        else if (USDT_MINT && otherMint === USDT_MINT) priority = 2;

        return {
          pairAddress: p.pairAddress,
          liquidityUsd: Number(p?.liquidity?.usd || 0),
          priority,
        };
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.liquidityUsd - a.liquidityUsd;
      });

    if (!stablePairs.length) {
      throw new Error("No WSOL/USDC or WSOL/USDT PumpSwap pool found");
    }

    const bestPoolPk = new PublicKey(stablePairs[0].pairAddress);

    // optional validation
    try {
      const conn = getNextConnection();
      const onlineAmmSdk = new OnlinePumpAmmSdk(conn);
      const pool = await onlineAmmSdk.fetchPool(bestPoolPk);

      if (!pool) {
        throw new Error("Pool fetch returned null");
      }

      console.log(`✅ Selected PumpSwap stable pool: ${bestPoolPk.toBase58()}`);
    } catch (err) {
      throw new Error(`Stable pool validation failed: ${err.message}`);
    }

    POOL_CACHE.set(cacheKey, bestPoolPk);
    return bestPoolPk;
  });
}