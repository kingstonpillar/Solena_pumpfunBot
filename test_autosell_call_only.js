import { PublicKey } from "@solana/web3.js";
import { executeAutoSellPumpfun } from "./autoSell_pumpfun.js";

async function main() {
  const rawInput = process.argv[2];
  if (!rawInput) {
    console.error("Usage: node test_autosell.js <mint|mintpump>");
    process.exit(1);
  }

  const mint = stripPumpSuffix(rawInput);

  // early validation (test-only)
  try {
    new PublicKey(mint);
  } catch {
    console.error("Invalid mint after stripping suffix:", mint);
    process.exit(1);
  }

  // ðŸ”‘ TEST DOES ONLY THIS
  // autosell handles wallet read, balance check, broadcast proof, etc
  const res = await executeAutoSellPumpfun({ mint });

  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error("Test failed:", e?.message || e);
  process.exit(1);
});