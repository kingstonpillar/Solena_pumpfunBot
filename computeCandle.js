// computeCandle.js
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { getCirculatingSupply } from "./circulatingSupply.js";
import { fetchSolPriceUSD } from "./solPriceFetcher.js";

/**
 * Compute candle for a token using USD market cap
 * Minimum candle momentum: 15% of the high-low range
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

    // ---------- Supply ----------
    const supplyObj = await getCirculatingSupply(cleanMint);
    if (
      !supplyObj ||
      typeof supplyObj.totalSupply !== "number" ||
      isNaN(supplyObj.totalSupply)
    ) {
      throw new Error("Failed to fetch circulating supply");
    }

    const supplyAmount = supplyObj.totalSupply;

    // ---------- Token price (SOL) ----------
    const priceObj = await getPumpFunPriceOnce(cleanMint);
    if (
      !priceObj ||
      typeof priceObj.priceSol !== "number" ||
      isNaN(priceObj.priceSol)
    ) {
      throw new Error("Failed to fetch token price");
    }

    const priceSol = priceObj.priceSol;

    // ---------- SOL → USD ----------
    const solUsd = await fetchSolPriceUSD();
    if (typeof solUsd !== "number" || isNaN(solUsd) || solUsd <= 0) {
      throw new Error("SOL price unavailable");
    }

    const priceUsd = priceSol * solUsd;

    // ---------- Market Cap (USD) ----------
    const currentMarketCap = priceUsd * supplyAmount;

    // ---------- Candle structure ----------
    const open =
      typeof lastClose === "number" && !isNaN(lastClose)
        ? lastClose
        : currentMarketCap;

    const close = currentMarketCap;

    const rawHigh =
      typeof highMarketCap === "number" && isFinite(highMarketCap)
        ? highMarketCap
        : currentMarketCap;

    const rawLow =
      typeof lowMarketCap === "number" && isFinite(lowMarketCap)
        ? lowMarketCap
        : currentMarketCap;

    const high = Math.max(rawHigh, rawLow, open, close);
    const low = Math.min(rawHigh, rawLow, open, close);

    const range = high - low;
    const minMovement = (minMomentumPercent / 100) * range;

    const momentum = close - open;
    const momentumPct = open > 0 ? (momentum / open) * 100 : 0;

    const color = momentum >= minMovement ? "green" : "red";

    // ---------- Logs ----------
    if (color === "green") {
      console.log(
        `[CANDLE ✅ GREEN] ${cleanMint} | momentum=${momentum.toFixed(6)} | momentumPct=${momentumPct.toFixed(2)}% | required=${minMovement.toFixed(6)} | range=${range.toFixed(6)}`
      );
    } else {
      console.log(
        `[CANDLE ❌ NO GREEN] ${cleanMint} | momentum=${momentum.toFixed(6)} | momentumPct=${momentumPct.toFixed(2)}% | required=${minMovement.toFixed(6)} | range=${range.toFixed(6)}`
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
      priceSol,
      priceUsd,
      solUsd,
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