
import { PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import { executeAmmMigrationBuy } from "./swapexecutorAMM_pumpswap.js";

dotenv.config();

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node testAmmMigrationBuy.js <AMM_POOL_PUBLIC_KEY> <MINT> [<AMOUNT_RAW>]");
    process.exit(1);
  }

  const [ammPoolStr, mintStr, amountRawStr] = args;
  const ammPoolPublicKey = new PublicKey(ammPoolStr);
  const mint = new PublicKey(mintStr);

  // Convert SOL amount to lamports if not provided
  const amountRaw = amountRawStr
    ? BigInt(amountRawStr)
    : BigInt(Math.floor((Number(process.env.SOL_TO_SPEND) || 0.01) * 1e9));

  try {
    const result = await executeAmmMigrationBuy({
      ammPoolPublicKey,
      mint,
      amountRaw,
      slippageFrac: 0.005 // default 0.5%, can adjust if needed
    });

    console.log("✅ AMM Migration Buy Result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("❌ Failed AMM migration buy:", err?.message || err);
    process.exit(1);
  }
}

main();