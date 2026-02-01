import { PublicKey } from "@solana/web3.js";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";

// ---------------- CLI ----------------
const mintArg = process.argv[2];

if (!mintArg) {
  console.error("❌ Usage: node pumpfun_price_test.js <MINT_ADDRESS>");
  process.exit(1);
}

let mint;
try {
  mint = new PublicKey(mintArg).toBase58();
} catch {
  console.error("❌ Invalid mint address");
  process.exit(1);
}

// ---------------- run ----------------
(async () => {
  console.log("🔎 Pump.fun price test");
  console.log("Mint:", mint);

  const record = { mint };

  const res = await getPumpFunPriceOnce(record);

  console.log("\n================ RESULT ================");
  console.log(JSON.stringify(res, null, 2));

  if (res?.priceSOL) {
    console.log("\n✅ PRICE FOUND");
    console.log("Price (SOL):", res.priceSOL);
    console.log("Source:", res.source);
  } else {
    console.log("\n❌ PRICE UNAVAILABLE");
    console.log("Reason:", res?.error || "unknown");
  }
})();