import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { verifyTokenSecurity } from "./tokensecurities.js"; // whatever your file is named

const mint = process.argv[2];
if (!mint) {
  console.log("Usage: node testTokensecurities.js <MINT>");
  process.exit(1);
}

const RPC = process.env.RPC_URL_11 || process.env.RPC_URL_12 || process.env.SOLANA_RPC_URL;
if (!RPC) {
  console.log("Missing RPC in env (RPC_URL_11 / RPC_URL_12 / SOLANA_RPC_URL)");
  process.exit(1);
}

const connection = new Connection(RPC, "confirmed");

const out = await verifyTokenSecurity(mint, connection);
console.log(JSON.stringify(out, null, 2));