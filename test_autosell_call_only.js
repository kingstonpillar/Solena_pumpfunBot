// test_autosell_call_only.js (ESM)
import "dotenv/config";
import { executeAutoSellPumpfun } from "./autoSell_pumpfun.js";

async function main() {
  const mint = process.argv[2];
  if (!mint) {
    console.error("Usage: node test_autosell_call_only.js <mint> [amount]");
    process.exit(1);
  }

  const amount = process.argv[3] ?? "100%";

  const res = await executeAutoSellPumpfun({ mint, amount });
  console.log(JSON.stringify({ input: mint, amount, result: res }, null, 2));
}

main().catch((e) => {
  console.error("Test failed:", e?.message || e);
  process.exit(1);
});