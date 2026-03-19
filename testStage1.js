
// testStage1.js

import { updateMarketCapAndCheckRetracement, getMarketCapMemory } from "./stage1_retracement.js";

// -------------------- Get token mint from CLI --------------------
const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node testStage1.js <TOKEN_MINT>");
  process.exit(1);
}

const mint = args[0];

(async () => {
  try {
    console.log(`\n=== Testing Stage 1 for token mint: ${mint} ===`);

    // Call your Stage 1 function
    const result = await updateMarketCapAndCheckRetracement(mint);

    console.log("\n[RESULT]");
    console.log(result);

    // Optional: show memory for this mint
    const mem = getMarketCapMemory(mint);
    console.log("\n[MEMORY]");
    console.log(mem);

    console.log("\n=== Stage 1 Test Completed ===\n");
  } catch (err) {
    console.error("[ERROR]", err.message);
  }
})();