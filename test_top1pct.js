// test_top1pct.js (ESM)
import "dotenv/config";
import { Top1pct } from "./heliusTop10.js"; // change path if your file name differs

const MINT = process.argv[2];

if (!MINT) {
  console.error("❌ Usage: node test_top1pct.js <MINT>");
  process.exit(1);
}

(async () => {
  try {
    console.log("🔍 Testing Top1pct for mint:", MINT);

    const top1 = await Top1pct(MINT);

    console.log("\n================ RESULT ================");
    console.log(`Top 1 holder owns: ${Number(top1).toFixed(2)}%`);

    // Optional: exit codes similar to your style
    if (Number(top1) >= 30) {
      console.log("❌ FAIL: top1 >= 30%");
      process.exit(2);
    } else {
      console.log("✅ OK: top1 < 30%");
      process.exit(0);
    }
  } catch (e) {
    console.error("❌ ERROR:", e?.message || e);
    process.exit(1);
  }
})();