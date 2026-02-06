
import "dotenv/config";
import { verifyCreatorSafetyPumpfun } from "./tokenCreatorScanner.js";

const MINT = process.argv[2];

if (!MINT) {
  console.error("❌ Usage: node test_creator_scanner.js <MINT>");
  process.exit(1);
}

(async () => {
  try {
    console.log("🔍 Testing creator safety for mint:", MINT);

    const res = await verifyCreatorSafetyPumpfun(MINT);

    console.log("\n================ RESULT ================");
    console.log(JSON.stringify(res, null, 2));

    if (res?.safe) {
      console.log(`\n✅ SAFE (score=${res.score}) creator=${res.creator || "n/a"}`);
      process.exit(0);
    } else {
      console.log(`\n❌ NOT SAFE (score=${res?.score ?? 0}) reason=${(res?.reasons || []).join(" | ")}`);
      process.exit(2);
    }
  } catch (e) {
    console.error("❌ ERROR:", e?.message || e);
    process.exit(1);
  }
})();
