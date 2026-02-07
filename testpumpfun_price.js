import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";

const mintArg = process.argv[2];

if (!mintArg) {
  console.error("❌ Usage: node testpumpfun_price.js <MINT_OR_IDENTIFIER>");
  process.exit(1);
}

// If your getPumpFunPriceOnce needs a connection, create it here.
// If your getPumpFunPriceOnce creates its own connection, you can remove these 2 lines.
const RPC = process.env.SOLANA_RPC_URL || process.env.RPC_URL_11 || process.env.RPC_URL_12;
if (!RPC) {
  console.error("❌ Missing RPC in env (SOLANA_RPC_URL or RPC_URL_11/RPC_URL_12)");
  process.exit(1);
}
const connection = new Connection(RPC, { commitment: "confirmed" });

(async () => {
  console.log("🔎 Pump.fun price test");
  console.log("Input:", mintArg);

  const record = { mint: mintArg };

  // If your function signature is (record, connection)
  const res = await getPumpFunPriceOnce(record, connection);

  // If your function signature is (record) and it creates its own conn, use:
  // const res = await getPumpFunPriceOnce(record);

  console.log("\n================ RESULT ================");
  console.log(JSON.stringify(res, null, 2));

  if (res?.priceSOL) {
    console.log("\n✅ PRICE FOUND");
    console.log("Resolved Mint:", res.mint);
    console.log("Price (SOL):", res.priceSOL);
    console.log("Source:", res.source);
  } else {
    console.log("\n❌ PRICE UNAVAILABLE");
    console.log("Reason:", res?.error || "unknown");
  }
})();