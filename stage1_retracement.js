// stage1_retracement.js
import fetch from "node-fetch";

// -------------------- In-memory storage --------------------
const MARKET_CAP_MEMORY = {};

/**
 * Update market cap for a mint and check Stage 1 conditions
 * @param {string} mint - token mint in base58
 * @returns {Promise<{pass: boolean, details: object}>}
 */
export async function updateMarketCapAndCheckRetracement(mint) {
  if (!mint) throw new Error("Missing mint for Stage 1");

  try {
    // ---------- Fetch market cap and liquidity from DexScreener ----------
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url, { headers: { "accept": "application/json" } });
    if (!res.ok) throw new Error(`DexScreener API failed: ${res.status}`);

    const data = await res.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    if (!pairs.length) throw new Error("No pairs found for token");

    const pair = pairs[0]; // take first pair
    const currentCap = Number(pair?.liquidity?.marketCap) || 0;
    const liquidity = Number(pair?.liquidity?.baseLiquidity) || 0;

    console.log(`[STAGE1] Fetched market cap for ${mint}: ${currentCap}`);
    console.log(`[STAGE1] Fetched liquidity for ${mint}: ${liquidity}`);

    // ---------- Update memory ----------
    if (!MARKET_CAP_MEMORY[mint]) {
      MARKET_CAP_MEMORY[mint] = {
        newHighMcap: currentCap,
        newLowMcap: currentCap,
        liquidity,
        lastUpdated: Date.now(),
      };
      console.log(`[STAGE1] Memory initialized for ${mint}`);
    } else {
      const mem = MARKET_CAP_MEMORY[mint];
      if (currentCap > mem.newHighMcap) {
        mem.newHighMcap = currentCap;
        console.log(`[STAGE1] Updated newHighMcap for ${mint}: ${mem.newHighMcap}`);
      }
      if (currentCap < mem.newLowMcap) {
        mem.newLowMcap = currentCap;
        console.log(`[STAGE1] Updated newLowMcap for ${mint}: ${mem.newLowMcap}`);
      }
      mem.liquidity = liquidity;
      mem.lastUpdated = Date.now();
    }

    const { newHighMcap, newLowMcap } = MARKET_CAP_MEMORY[mint];

    // ---------- Compute retracement ----------
    const retracement = ((newHighMcap - currentCap) / newHighMcap) * 100;
    console.log(`[STAGE1] Retracement for ${mint}: ${retracement.toFixed(2)}%`);

    // ---------- Check Stage 1 conditions ----------
    const MIN_MARKET_CAP = 26000; // 26k
    const MIN_LIQUIDITY = 7000;

    const minMarketCapCheck = newHighMcap >= MIN_MARKET_CAP;
    const liquidityCheck = liquidity >= MIN_LIQUIDITY;

    const pass =
      retracement >= 70 &&
      retracement <= 80 &&
      minMarketCapCheck &&
      liquidityCheck;

    if (pass) {
      console.log(`[STAGE1] PASS for ${mint}`);
    } else {
      console.log(
        `[STAGE1] FAIL for ${mint} - retracement=${retracement.toFixed(
          2
        )}%, minMarketCapCheck=${minMarketCapCheck}, liquidityCheck=${liquidityCheck}`
      );
    }

    return {
      pass,
      details: {
        mint,
        currentCap,
        newHighMcap,
        newLowMcap,
        retracement,
        minMarketCapCheck,
        liquidity,
        liquidityCheck,
      },
    };
  } catch (err) {
    console.error(`[STAGE1] ERROR for ${mint}: ${err.message}`);
    return {
      pass: false,
      details: {
        mint,
        error: err.message,
      },
    };
  }
}

/**
 * Access market cap memory for a mint
 * @param {string} mint
 * @returns {object|null}
 */
export function getMarketCapMemory(mint) {
  return MARKET_CAP_MEMORY[mint] || null;
}