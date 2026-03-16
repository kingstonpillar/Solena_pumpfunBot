
import { checkPumpMigration } from "./checkPumpMigration.js";

// Get the pair address from command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node testMigration.js <PAIR_ADDRESS>");
  process.exit(1);
}

const pairAddress = args[0];

(async () => {
  try {
    const migrated = await checkPumpMigration(pairAddress);

    if (migrated) {
      console.log(`✅ Pair ${pairAddress} is migrated via PumpSwap`);
    } else {
      console.log(`❌ Pair ${pairAddress} is NOT migrated`);
    }
  } catch (err) {
    console.error("Error checking migration:", err);
  }
})();