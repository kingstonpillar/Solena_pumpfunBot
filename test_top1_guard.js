// test_top1_guard.js (ESM)
import { runTop1GuardFromActivePositions } from "./top1_guard.js";

async function onSignal({ mint, action, reason, context }) {
  console.log("\n=== TOP1 GUARD SIGNAL ===");
  console.log({ mint, action, reason });
  console.log({
    top1Pct: context.top1Pct,
    profitPct: context.profitPct,
    entryPriceSOL: context.entryPriceSOL,
    currentPriceSOL: context.currentPriceSOL,
  });
}

runTop1GuardFromActivePositions({
  onSignal,
  scanMs: 3_000, // faster test (3s)
}).catch((e) => console.error("guard crashed:", e?.message || e));