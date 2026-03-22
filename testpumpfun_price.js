import { getPumpFunPriceOnce } from "./pumpfun_price.js";

const mint = process.argv[2];

if (!mint) {
  console.error("Usage: node testpumpfun_price.js <MINT>");
  process.exit(1);
}

(async () => {
  try {
    console.log("🔎 Pump.fun price test");
    console.log("Input:", mint);

    const result = await getPumpFunPriceOnce(mint);
    console.dir(result, { depth: null });
  } catch (err) {
    console.error("Error:", err?.message || err);
    process.exit(1);
  }
})();