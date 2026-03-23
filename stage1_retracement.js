// stage1_retracement.js
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { getCirculatingSupply } from "./circulatingSupply.js";

const MARKET_CAP_MEMORY = {};

// ------------------ Target Levels ------------------
const LOW_CAP_MIN = 26_000;
const LOW_CAP_MAX = 199_999;
const LOW_CAP_LEVELS = [50, 60, 70, 80];

const HIGH_CAP_MIN = 200_000;
const HIGH_CAP_MAX = 800_000;
const HIGH_CAP_LEVELS = [50, 60];

export async function updateMarketCapAndCheckRetracement(mint) {
  if (!mint) throw new Error("Missing mint for Stage 1");

  try {
    const cleanMint = String(mint).trim();

    // Fetch circulating supply
    const circulatingSupply = await getCirculatingSupply(cleanMint);
    if (!circulatingSupply || typeof circulatingSupply.totalSupply !== "number") {
      throw new Error("Failed to fetch circulating supply");
    }

    // Convert to numeric amount
    const supplyAmount = circulatingSupply.totalSupply;

    // Initialize memory
    if (!MARKET_CAP_MEMORY[cleanMint]) {
      MARKET_CAP_MEMORY[cleanMint] = {
        newHighMcap: 0,
        newLowMcap: Infinity,
        lastCirculatingSupply: supplyAmount,
        retracementLevels: {},
        lastUpdated: Date.now(),
      };
    }

    const mem = MARKET_CAP_MEMORY[cleanMint];
    mem.lastCirculatingSupply = supplyAmount;
    mem.lastUpdated = Date.now();

    // Fetch price object
    const priceObj = await getPumpFunPriceOnce(cleanMint);

    if (!priceObj || typeof priceObj.priceSol !== "number" || isNaN(priceObj.priceSol)) {
      throw new Error("Price fetch failed or returned NaN");
    }

    const price = priceObj.priceSol;

    // Calculate market cap
    const currentCap = price * supplyAmount;

    if (currentCap > mem.newHighMcap) mem.newHighMcap = currentCap;
    if (currentCap < mem.newLowMcap) mem.newLowMcap = currentCap;

    // Determine level set based on newHighMcap
    let levels;
    if (mem.newHighMcap >= LOW_CAP_MIN && mem.newHighMcap <= LOW_CAP_MAX) {
      levels = LOW_CAP_LEVELS;
    } else if (mem.newHighMcap >= HIGH_CAP_MIN && mem.newHighMcap <= HIGH_CAP_MAX) {
      levels = HIGH_CAP_LEVELS;
    } else {
      return {
        pass: false,
        details: {
          mint: cleanMint,
          currentCap,
          newHighMcap: mem.newHighMcap,
          reason: "outside meaningful cap ranges",
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

    // Determine highest level crossed up
    const levelsCrossedUp = levels.filter((lvl) => mem.retracementLevels[lvl].crossedUp);
    const currentLevelCrossedUp = levelsCrossedUp.length
      ? Math.max(...levelsCrossedUp)
      : null;

    return {
      pass: !!currentLevelCrossedUp,
      details: {
        mint: cleanMint,
        currentCap,
        newHighMcap: mem.newHighMcap,
        newLowMcap: mem.newLowMcap,
        retracement,
        circulatingSupply,
        priceSource: priceObj.source,
        migrated: priceObj.migrated,
        retracementLevels: { ...mem.retracementLevels },
        currentLevelCrossedUp,
        levelsUsed: levels,
      },
    };
  } catch (err) {
    console.error(`[STAGE1] ERROR for ${mint}: ${err.message}`);
    return { pass: false, details: { mint, error: err.message } };
  }
}

export function getMarketCapMemory(mint) {
  return MARKET_CAP_MEMORY[mint] || null;
}