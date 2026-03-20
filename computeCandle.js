// computeCandle.js
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { getCirculatingSupply } from "./circulatingSupply.js";

/**
 * Compute candle for a token using market cap derived from price and circulating supply
 * Minimum candle momentum: 15% of the high-low range
 * 
 * @param {string} tokenMint - Token mint in base58
 * @param {number} highMarketCap - High market cap from memory
 * @param {number} lowMarketCap - Low market cap from memory
 * @param {number} lastClose - Last candle close market cap
 * @param {number} minMomentumPercent - Minimum momentum percent (default 15)
 * @returns {Promise<{open: number, close: number, high: number, low: number, timestamp: number, color: "green"|"red"}>}
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
    const circulatingSupply = await getCirculatingSupply(tokenMint);
    if (!circulatingSupply) throw new Error("Failed to fetch circulating supply");

    // ---------- Get current price ----------
    const price = await getPumpFunPriceOnce(tokenMint);
    if (!price) throw new Error("Failed to fetch token price");

    // ---------- Compute current market cap ----------
    const currentMarketCap = price * circulatingSupply;

    const open = lastClose ?? currentMarketCap;
    const close = currentMarketCap;
    const high = highMarketCap;
    const low = lowMarketCap;

    // ---------- Minimum momentum ----------
    const range = high - low || 1; // avoid divide by zero
    const minMovement = (minMomentumPercent / 100) * range;

    // Candle is green if close exceeds open by at least minMovement
    const color = (close - open) >= minMovement ? "green" : "red";

    console.log(
      `[CANDLE] Mint: ${tokenMint} | Open: ${open} | Close: ${close} | High: ${high} | Low: ${low} | MinMove: ${minMovement} | Color: ${color}`
    );

    return {
      open,
      close,
      high,
      low,
      timestamp: Date.now(),
      color,
    };
  } catch (err) {
    console.error(`[CANDLE] ERROR for ${tokenMint}: ${err.message}`);
    return {
      open: lastClose ?? 0,
      close: lastClose ?? 0,
      high: highMarketCap,
      low: lowMarketCap,
      timestamp: Date.now(),
      color: "red",
    };
  }
}