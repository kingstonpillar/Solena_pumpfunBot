// computeCandle.js
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { getCirculatingSupply } from "./circulatingSupply.js";

/**
 * Compute candle for a token using market cap derived from price and circulating supply
 * Minimum candle momentum: 15% of the high-low range
 *
 * @param {string} tokenMint
 * @param {number} highMarketCap
 * @param {number} lowMarketCap
 * @param {number} lastClose
 * @param {number} minMomentumPercent
 * @returns {Promise<{open:number, close:number, high:number, low:number, timestamp:number, color:"green"|"red", momentum:number}>}
 */
export async function computeCandle(
  tokenMint,
  highMarketCap,
  lowMarketCap,
  lastClose,
  minMomentumPercent = 15
) {
  if (!tokenMint) throw new Error("Missing token mint");

  try {
    const cleanMint = String(tokenMint).trim();

    // ---------- Get circulating supply ----------
    const supplyObj = await getCirculatingSupply(cleanMint);
    if (
      !supplyObj ||
      typeof supplyObj.totalSupply !== "number" ||
      isNaN(supplyObj.totalSupply)
    ) {
      throw new Error("Failed to fetch circulating supply");
    }

    // totalSupply is already normalized in circulatingSupply.js
    const supplyAmount = supplyObj.totalSupply;

    // ---------- Get current price ----------
    const priceObj = await getPumpFunPriceOnce(cleanMint);
    if (
      !priceObj ||
      typeof priceObj.priceSol !== "number" ||
      isNaN(priceObj.priceSol)
    ) {
      throw new Error("Failed to fetch token price");
    }

    const price = priceObj.priceSol;

    // ---------- Compute current market cap ----------
    const currentMarketCap = price * supplyAmount;

    const open =
      typeof lastClose === "number" && !isNaN(lastClose)
        ? lastClose
        : currentMarketCap;

    const close = currentMarketCap;

    const high =
      typeof highMarketCap === "number" && isFinite(highMarketCap)
        ? highMarketCap
        : currentMarketCap;

    const low =
      typeof lowMarketCap === "number" && isFinite(lowMarketCap)
        ? lowMarketCap
        : currentMarketCap;

    // ---------- Minimum momentum ----------
    const range = high - low;
    const safeRange = range > 0 ? range : 1;
    const minMovement = (minMomentumPercent / 100) * safeRange;
    const momentum = close - open;

    // % move from open
    const momentumPct = open > 0 ? (momentum / open) * 100 : 0;

    // Candle is green if close exceeds open by at least minMovement
    const color = momentum >= minMovement ? "green" : "red";

    if (color === "green") {
      console.log(
        `[CANDLE ✅ GREEN] ${cleanMint} | momentum=${momentum.toFixed(6)} | momentumPct=${momentumPct.toFixed(2)}% | required=${minMovement.toFixed(6)} | requiredPctOfRange=${minMomentumPercent}% | range=${range.toFixed(6)}`
      );
    } else {
      console.log(
        `[CANDLE ❌ NO GREEN] ${cleanMint} | momentum=${momentum.toFixed(6)} | momentumPct=${momentumPct.toFixed(2)}% | required=${minMovement.toFixed(6)} | requiredPctOfRange=${minMomentumPercent}% | range=${range.toFixed(6)}`
      );
    }

    console.log("[CANDLE_DEBUG]", {
      mint: cleanMint,
      open,
      close,
      high,
      low,
      range,
      minMovement,
      momentum,
      momentumPct,
      color,
      price,
      supplyAmount,
      currentMarketCap,
      source: priceObj?.source ?? null,
      migrated: priceObj?.migrated ?? null,
    });

    return {
      open,
      close,
      high,
      low,
      timestamp: Date.now(),
      color,
      momentum,
    };
  } catch (err) {
    console.error(`[CANDLE] ERROR for ${tokenMint}: ${err.message}`);
    return {
      open:
        typeof lastClose === "number" && !isNaN(lastClose) ? lastClose : 0,
      close:
        typeof lastClose === "number" && !isNaN(lastClose) ? lastClose : 0,
      high:
        typeof highMarketCap === "number" && isFinite(highMarketCap)
          ? highMarketCap
          : 0,
      low:
        typeof lowMarketCap === "number" && isFinite(lowMarketCap)
          ? lowMarketCap
          : 0,
      timestamp: Date.now(),
      color: "red",
      momentum: 0,
    };
  }
}