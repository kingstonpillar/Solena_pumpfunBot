// test_autosell_call_only.js (ESM)
import "dotenv/config";
import { executeAutoSellPumpfun } from "./autoSell_pumpfun.js";

function stripPumpSuffix(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("missing mint input");
  return s.endsWith("pump") ? s.slice(0, -4) : s;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("Usage: node test_autosell_call_only.js <mint|mintpump> [amount] [pool]");
    process.exit(1);
  }

  const mint = stripPumpSuffix(raw);
  const amount = process.argv[3] ?? "100%";
  const pool = process.argv[4] ?? (process.env.SELL_POOL || "pump");

  const res = await executeAutoSellPumpfun({ mint, amount, pool });

  console.log(JSON.stringify({
    ok: true,
    input: raw,
    mint,
    amount,
    pool,
    result: res
  }, null, 2));
}

main().catch((e) => {
  console.error("Test failed:", e?.message || e);
  process.exit(1);
});