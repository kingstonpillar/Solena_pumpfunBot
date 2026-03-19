// poolResolver.js
import { PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import { OnlinePumpAmmSdk, canonicalPumpPoolPda } from "./pumpAmmSdk.js"; // your SDK
import POOL_CACHE from "./poolCache.js"; // your cache map

/**
 * Resolve PumpSwap pool for a mint
 * Tries on-chain first, falls back to DexScreener off-chain lookup
 * @param {Connection} conn - Solana RPC connection
 * @param {PublicKey} mintPk - Token mint PublicKey
 * @returns {Promise<PublicKey>} pool PublicKey
 */
export async function resolvePumpSwapPool(conn, mintPk) {
  const mintKey = mintPk.toBase58();

  // Check cache first
  if (POOL_CACHE.has(mintKey)) {
    return POOL_CACHE.get(mintKey);
  }

  // ---------------- ON-CHAIN RESOLUTION ----------------
  try {
    console.log(`🔎 Attempting on-chain resolution for mint: ${mintKey}`);
    const onlineAmmSdk = new OnlinePumpAmmSdk(conn);
    const poolPk = canonicalPumpPoolPda(mintPk);

    const pool = await onlineAmmSdk.fetchPool(poolPk);
    if (pool && pool.baseMint && pool.baseMint.equals(mintPk)) {
      console.log(`✅ Found on-chain PumpSwap pool: ${poolPk.toBase58()}`);
      POOL_CACHE.set(mintKey, poolPk);
      return poolPk;
    }
    console.warn(`⚠️ On-chain pool validation failed for mint ${mintKey}`);
  } catch (err) {
    console.warn(`❌ On-chain resolution failed for mint ${mintKey}: ${err.message}`);
  }

  // ---------------- OFF-CHAIN (DEXSCREENER) RESOLUTION ----------------
  try {
    console.log(`🔎 Attempting DexScreener resolution for mint: ${mintKey}`);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintKey}`;
    const res = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": process.env.HTTP_UA || "Solena_pumpfunBot/1.0",
      },
    });

    if (!res.ok) {
      throw new Error(`DexScreener lookup failed: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

    const pumpSwapPair = pairs.find(
      (p) =>
        p?.chainId === "solana" &&
        (String(p?.dexId || "").toLowerCase() === "pumpswap" ||
          String(p?.dexId || "").toLowerCase().includes("pump")) &&
        p?.pairAddress
    );

    if (!pumpSwapPair) {
      throw new Error(`PumpSwap pool not found on DexScreener for mint ${mintKey}`);
    }

    const poolPk = new PublicKey(pumpSwapPair.pairAddress);
    console.log(`✅ Found PumpSwap pool via DexScreener: ${poolPk.toBase58()}`);

    POOL_CACHE.set(mintKey, poolPk);
    return poolPk;
  } catch (err) {
    throw new Error(`Failed to resolve PumpSwap pool for mint ${mintKey}: ${err.message}`);
  }
}