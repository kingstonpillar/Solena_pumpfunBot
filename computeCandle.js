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
    // ---------- Get circulating supply ----------
    const supplyObj = await getCirculatingSupply(tokenMint);
    if (
      !supplyObj ||
      typeof supplyObj.totalSupply !== "number" ||
      isNaN(supplyObj.totalSupply)
    ) {
      throw new Error("Failed to fetch circulating supply");
    }

    // If totalSupply is already normalized in circulatingSupply.js, use it directly.
    // If not normalized there, change this to:
    // const supplyAmount = supplyObj.totalSupply / (10 ** supplyObj.decimals);
    const supplyAmount = supplyObj.totalSupply;

    // ---------- Get current price ----------
    const priceObj = await getPumpFunPriceOnce(tokenMint);
    if (
      !priceObj ||
      typeof priceObj.priceSOL !== "number" ||
      isNaN(priceObj.priceSOL)
    ) {
      throw new Error("Failed to fetch token price");
    }

    const price = priceObj.priceSOL;

    // ---------- Compute current market cap ----------
    const currentMarketCap = price * supplyAmount;

    const open = typeof lastClose === "number" && !isNaN(lastClose)
      ? lastClose
      : currentMarketCap;

    const close = currentMarketCap;

    const high = typeof highMarketCap === "number" && isFinite(highMarketCap)
      ? highMarketCap
      : currentMarketCap;

    const low = typeof lowMarketCap === "number" && isFinite(lowMarketCap)
      ? lowMarketCap
      : currentMarketCap;

    // ---------- Minimum momentum ----------
    const range = high - low;
    const safeRange = range > 0 ? range : 1;
    const minMovement = (minMomentumPercent / 100) * safeRange;
    const momentum = close - open;

    // Candle is green if close exceeds open by at least minMovement
    const color = momentum >= minMovement ? "green" : "red";

    console.log(
      `[CANDLE] Mint: ${tokenMint} | Open: ${open} | Close: ${close} | High: ${high} | Low: ${low} | MinMove: ${minMovement} | Momentum: ${momentum} | Color: ${color}`
    );

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
      open: typeof lastClose === "number" && !isNaN(lastClose) ? lastClose : 0,
      close: typeof lastClose === "number" && !isNaN(lastClose) ? lastClose : 0,
      high: typeof highMarketCap === "number" && isFinite(highMarketCap) ? highMarketCap : 0,
      low: typeof lowMarketCap === "number" && isFinite(lowMarketCap) ? lowMarketCap : 0,
      timestamp: Date.now(),
      color: "red",
      momentum: 0,
    };
  }
}