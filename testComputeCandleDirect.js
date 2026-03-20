  //  testComputeCandleDirect.js
   
import { computeCandle } from "./computeCandle.js";

async function runTest() {
  const tokenMint = "8J69rbLTzWWgUJziFY8jeu5tDwEPBwUz4pKBMr5rpump"; // replace with your mint

  try {
    const candle = await computeCandle(tokenMint, 0, Infinity, undefined);
    console.log("Candle result:", candle);
  } catch (err) {
    console.error("Error computing candle:", err);
  }
}

runTest();
