// stage1_retracement.js
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { getCirculatingSupply } from "./circulatingSupply.js";

const MARKET_CAP_MEMORY = {};
const LEVELS = [50, 60, 70, 80];
const MIN_MARKET_CAP = 26_000; // <-- new minimum market cap

export async function updateMarketCapAndCheckRetracement(mint) {
  if (!mint) throw new Error("Missing mint for Stage 1");

  try {
    const circulatingSupply = await getCirculatingSupply(mint);
    if (!circulatingSupply) throw new Error("Failed to fetch circulating supply");

    const MAX_SAFE_SUPPLY = 1_000_000_000;
    if (circulatingSupply > MAX_SAFE_SUPPLY) {
      return { pass: false, details: { mint, circulatingSupply, reason: "Supply > 1B" } };
    }

    if (!MARKET_CAP_MEMORY[mint]) {
      MARKET_CAP_MEMORY[mint] = {
        newHighMcap: 0,
        newLowMcap: Infinity,
        lastCirculatingSupply: circulatingSupply,
        retracementLevels: LEVELS.reduce((acc, lvl) => {
          acc[lvl] = { crossedDown: false, crossedUp: false };
          return acc;
        }, {}),
        lastUpdated: Date.now(),
      };
    }

    const mem = MARKET_CAP_MEMORY[mint];
    mem.lastCirculatingSupply = circulatingSupply;
    mem.lastUpdated = Date.now();

    const price = await getPumpFunPriceOnce(mint);
    const currentCap = price * circulatingSupply;

    if (currentCap > mem.newHighMcap) mem.newHighMcap = currentCap;
    if (currentCap < mem.newLowMcap) mem.newLowMcap = currentCap;

    const { newHighMcap } = mem;

    // Check minimum market cap requirement
    if (newHighMcap < MIN_MARKET_CAP) {
      return { pass: false, details: { mint, currentCap, newHighMcap, reason: `newHighMcap < MinMCap (${MIN_MARKET_CAP})` } };
    }

    const retracement = newHighMcap ? ((newHighMcap - currentCap) / newHighMcap) * 100 : 0;

    // Track level crossed down first, then crossed up
    LEVELS.forEach(level => {
      const lvlMemory = mem.retracementLevels[level];

      // Cross down
      if (!lvlMemory.crossedDown && retracement >= level) {
        lvlMemory.crossedDown = true;
        console.log(`[STAGE1] Level ${level}% crossed DOWN for ${mint}`);
      }

      // Cross up (only if previously crossed down)
      if (lvlMemory.crossedDown && !lvlMemory.crossedUp && retracement < level) {
        lvlMemory.crossedUp = true;
        console.log(`[STAGE1] Level ${level}% crossed UP for ${mint}`);
      }
    });

    // Determine highest level currently crossed up
    const levelsCrossedUp = LEVELS.filter(lvl => mem.retracementLevels[lvl].crossedUp);
    const currentLevelCrossedUp = levelsCrossedUp.length ? Math.max(...levelsCrossedUp) : null;

    return {
      pass: !!currentLevelCrossedUp, // Stage1 passes if any level has crossed up
      details: {
        mint,
        currentCap,
        newHighMcap: mem.newHighMcap,
        newLowMcap: mem.newLowMcap,
        retracement,
        circulatingSupply,
        retracementLevels: { ...mem.retracementLevels },
        currentLevelCrossedUp, // <-- highest level crossed up
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