import { getPumpFunPriceOnce } from "./pumpfun_Price2.js";

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error("❌ Usage: node test_price.js <mint>");
    process.exit(1);
  }

  console.log("[TEST] Fetching price for:", input);

  try {
    const res = await getPumpFunPriceOnce(input);

    console.log("\n=== RESULT ===");
    console.dir(res, { depth: null });

    if (res?.priceSOL) {
      console.log("\n✅ Price (SOL):", res.priceSOL);
      console.log("Source:", res.source);
    } else {
      console.log("\n⚠️ No price found:", res?.error);
    }

  } catch (err) {
    console.error("\n❌ ERROR:", err?.message || err);
  }
}

main();