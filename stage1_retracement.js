// stage1_retracement.js

import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { getCirculatingSupply } from "./circulatingSupply.js";
import { fetchSolPriceUSD } from "./solPriceFetcher.js";
import { saveMapToFile, loadMapFromFile } from "./memoryHelper.js";

const RETRACEMENT_FILE = "./retracement_state.json";
const MARKET_CAP_MEMORY = loadMapFromFile(RETRACEMENT_FILE);

// ------------------ Target Levels ------------------
const LOW_CAP_MIN = 50_000;
const LOW_CAP_MAX = 199_999;
const LOW_CAP_LEVELS = [60, 70, 80];

const HIGH_CAP_MIN = 200_000;
const HIGH_CAP_MAX = 800_000;
const HIGH_CAP_LEVELS = [50, 60];

function createInitialMemory(supplyAmount) {
  return {
    newHighMcap: 0,
    newLowMcap: Infinity,
    lastCirculatingSupply: supplyAmount,
    retracementLevels: {},
    lastUpdated: Date.now(),
  };
}

function cloneMemory(mem) {
  return {
    newHighMcap: Number(mem?.newHighMcap || 0),
    newLowMcap:
      mem?.newLowMcap === Infinity
        ? Infinity
        : Number.isFinite(Number(mem?.newLowMcap))
        ? Number(mem.newLowMcap)
        : Infinity,
    lastCirculatingSupply: Number(mem?.lastCirculatingSupply || 0),
    retracementLevels: Object.fromEntries(
      Object.entries(mem?.retracementLevels || {}).map(([k, v]) => [
        k,
        {
          crossedDown: !!v?.crossedDown,
          crossedUp: !!v?.crossedUp,
        },
      ])
    ),
    lastUpdated: Number(mem?.lastUpdated || Date.now()),
  };
}

function persistMarketCapMemory(mint, mem) {
  if (!mint) return;
  MARKET_CAP_MEMORY.set(mint, mem);
  saveMapToFile(MARKET_CAP_MEMORY, RETRACEMENT_FILE);
}

export function clearMarketCapMemory(mintOrPosition) {
  const mint =
    typeof mintOrPosition === "string"
      ? mintOrPosition.trim()
      : String(mintOrPosition?.mint || mintOrPosition?.mintAddress || "").trim();

  if (!mint) return false;

  const deleted = MARKET_CAP_MEMORY.delete(mint);
  saveMapToFile(MARKET_CAP_MEMORY, RETRACEMENT_FILE);
  return deleted;
}

export function getMarketCapMemory(mint) {
  const cleanMint = String(mint || "").trim();
  if (!cleanMint) return null;

  const mem = MARKET_CAP_MEMORY.get(cleanMint);
  return mem ? cloneMemory(mem) : null;
}

export async function updateMarketCapAndCheckRetracement(mint) {
  if (!mint) throw new Error("Missing mint for Stage 1");

  try {
    const cleanMint = String(mint).trim();

    // Fetch circulating supply
    const circulatingSupply = await getCirculatingSupply(cleanMint);
    if (!circulatingSupply || typeof circulatingSupply.totalSupply !== "number") {
      throw new Error("Failed to fetch circulating supply");
    }

    const supplyAmount = circulatingSupply.totalSupply;

    // Initialize memory
    let mem = MARKET_CAP_MEMORY.get(cleanMint);
    if (!mem) {
      mem = createInitialMemory(supplyAmount);
      MARKET_CAP_MEMORY.set(cleanMint, mem);
    }

    mem.lastCirculatingSupply = supplyAmount;
    mem.lastUpdated = Date.now();

    // Fetch token price
    const priceObj = await getPumpFunPriceOnce(cleanMint);
    if (!priceObj || typeof priceObj.priceSol !== "number" || isNaN(priceObj.priceSol)) {
      throw new Error("Price fetch failed or returned NaN");
    }

    const priceSol = priceObj.priceSol;

    // Fetch SOL/USD
    const solUsd = await fetchSolPriceUSD();
    if (typeof solUsd !== "number" || isNaN(solUsd) || solUsd <= 0) {
      throw new Error("SOL price unavailable");
    }

    // Convert token price to USD and compute market cap in USD
    const priceUsd = priceSol * solUsd;
    const currentCap = priceUsd * supplyAmount;

    if (currentCap > mem.newHighMcap) mem.newHighMcap = currentCap;
    if (currentCap < mem.newLowMcap) mem.newLowMcap = currentCap;

    // Determine level set based on newHighMcap
    let levels;
    if (mem.newHighMcap >= LOW_CAP_MIN && mem.newHighMcap <= LOW_CAP_MAX) {
      levels = LOW_CAP_LEVELS;
    } else if (mem.newHighMcap >= HIGH_CAP_MIN && mem.newHighMcap <= HIGH_CAP_MAX) {
      levels = HIGH_CAP_LEVELS;
    } else {
      persistMarketCapMemory(cleanMint, mem);

      return {
        pass: false,
        details: {
          mint: cleanMint,
          currentCap,
          newHighMcap: mem.newHighMcap,
          reason: "outside meaningful cap ranges",
          priceSol,
          priceUsd,
          solUsd,
        },
      };
    }

    // Initialize retracementLevels
    levels.forEach((lvl) => {
      if (!mem.retracementLevels[lvl]) {
        mem.retracementLevels[lvl] = {
          crossedDown: false,
          crossedUp: false,
        };
      }
    });

    const retracement = mem.newHighMcap
      ? ((mem.newHighMcap - currentCap) / mem.newHighMcap) * 100
      : 0;

    // Track cross-down and cross-up
    levels.forEach((level) => {
      const lvlMemory = mem.retracementLevels[level];

      if (!lvlMemory.crossedDown && retracement >= level) {
        lvlMemory.crossedDown = true;
        console.log(`[STAGE1] Level ${level}% crossed DOWN for ${cleanMint}`);
      }

      if (lvlMemory.crossedDown && !lvlMemory.crossedUp && retracement < level) {
        lvlMemory.crossedUp = true;
        console.log(`[STAGE1] Level ${level}% crossed UP for ${cleanMint}`);
      }
    });

    const levelsCrossedUp = levels.filter((lvl) => mem.retracementLevels[lvl].crossedUp);
    const currentLevelCrossedUp = levelsCrossedUp.length
      ? Math.max(...levelsCrossedUp)
      : null;

    persistMarketCapMemory(cleanMint, mem);

    return {
      pass: !!currentLevelCrossedUp,
      details: {
        mint: cleanMint,
        currentCap,
        newHighMcap: mem.newHighMcap,
        newLowMcap: mem.newLowMcap,
        retracement,
        circulatingSupply,
        priceSol,
        priceUsd,
        solUsd,
        priceSource: priceObj.source,
        migrated: priceObj.migrated,
        retracementLevels: { ...mem.retracementLevels },
        currentLevelCrossedUp,
        levelsUsed: levels,
      },
    };
  } catch (err) {
    console.error(`[STAGE1] ERROR for ${mint}: ${err.message}`);
    return {
      pass: false,
      details: {
        mint: String(mint).trim(),
        error: err.message,
      },
    };
  }
}