import { verifyCreatorSafetyPumpfun } from "./verifyCreatorSafetyPumpfun.js";

const MINT = process.argv[2];
if (!MINT) {
  console.error("❌ Usage: node test_creator_scanner.js <MINT>");
  process.exit(1);
}

console.log("🔍 Testing mint:", MINT);
const res = await verifyCreatorSafetyPumpfun(MINT);
console.log(JSON.stringify(res, null, 2));