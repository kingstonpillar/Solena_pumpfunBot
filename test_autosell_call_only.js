// test_autosell_call_only.js (ESM)
//
// ONLY calls executeAutoSellPumpfun().
// All wallet decrypt, SOL read, token ATA read, broadcast-proof, and NO_TOKEN_FUND logic
// happens INSIDE autoSell_pumpfun.js (as you demanded).
//
// Usage:
//   node test_autosell_call_only.js <mintOrMintpump> [amount] [pool]
//
// Examples:
//   node test_autosell_call_only.js 4jmiayubs4GpVrd1EMs1FMP8YBRJyDitWDKJAkv5r8p7pump
//   node test_autosell_call_only.js 4jmiayubs4GpVrd1EMs1FMP8YBRJyDitWDKJAkv5r8p7 100% pump

import "dotenv/config";
import { executeAutoSellPumpfun } from "./autoSell_pumpfun.js";

async function main() {
  const mintOrPump = process.argv[2];
  const amount = process.argv[3] ?? "100%";
  const pool = process.argv[4] ?? (process.env.SELL_POOL || "pump");

  if (!mintOrPump) {
    console.error("Usage: node test_autosell_call_only.js <mintOrMintpump> [amount] [pool]");
    process.exit(1);
  }

  // no wallet reads, no balance reads, no proof tx here
  // autoSell_pumpfun.js handles everything internally
  const res = await executeAutoSellPumpfun({
    mint: mintOrPump,
    amount,
    pool,
  });

  console.log(JSON.stringify(res, null, 2));

  // optional: make it obvious in terminal when you're testing the NO_TOKEN_FUND path
  if (res?.reason === "NO_TOKEN_FUND") {
    console.log("NO_TOKEN_FUND (expected for mints you don't hold).");
    process.exit(0);
  }

  process.exit(res?.ok ? 0 : 2);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
  process.exit(1);
});
