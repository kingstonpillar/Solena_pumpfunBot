import { verifyTokenSecurity } from "./tokensecurities.js";

const MINT = process.argv[2];

if (!MINT) {
  console.error("❌ Usage: node test_token_security.js <MINT_ADDRESS>");
  process.exit(1);
}

(async () => {
  try {
    console.log("🔍 Testing token security for mint:", MINT);

    const res = await verifyTokenSecurity(MINT);

    console.log("RESULT:\n", JSON.stringify(res, null, 2));

    if (res?.safe) {
      console.log(`✅ SAFE (score=${res.score})`);
      process.exit(0);
    } else {
      console.log(`❌ NOT SAFE (score=${res?.score ?? 0})`);
      process.exit(2);
    }
  } catch (e) {
    console.error("ERROR:", e?.message || e);
    process.exit(1);
  }
})();