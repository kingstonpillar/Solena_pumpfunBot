import { PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import { executeAmmMigrationBuy } from "./swapexecutorAMM_pumpswap.js";

dotenv.config();

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 1) {
    console.error("Usage: node testAmmMigrationBuy.js <MINT>");
    process.exit(1);
  }

  const [mintStr] = args;

  let mint;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    console.error("❌ Invalid mint address");
    process.exit(1);
  }

  try {
    const result = await executeAmmMigrationBuy({
      mint,
      slippageFrac: 0.005,
    });

    console.log("✅ AMM Migration Buy Result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("❌ Failed AMM migration buy:", err?.message || err);
    process.exit(1);
  }
}

main();