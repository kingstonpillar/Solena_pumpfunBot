// testTokensecurities.js (ESM)
import "dotenv/config";
import { checkTokenSecurity } from "./tokensecurities.js"; // update path if different

const mintOrId = process.argv[2];
if (!mintOrId) {
  console.log("Usage: node testTokensecurities.js <MINT|TOKEN_ACCOUNT|BONDING_CURVE|...pump>");
  process.exit(1);
}

// checkTokenSecurity() builds/uses its own RPC logic (via your module + canonical resolver),
// so no Connection is required here.
const out = await checkTokenSecurity(mintOrId);
console.log(JSON.stringify(out, null, 2));