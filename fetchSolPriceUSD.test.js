// fetchSolPriceUSD.test.js
import dotenv from "dotenv";
import { fetchSolPriceUSD } from "./solPriceFetcher.js";

dotenv.config();

try {
  const price = await fetchSolPriceUSD();
  console.log("SOL price USD =", Number(price).toFixed(4));
  process.exit(0);
} catch (err) {
  console.error("TEST FAILED:", err?.message || err);
  process.exit(1);
}