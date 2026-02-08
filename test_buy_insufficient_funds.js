// test_buy_insufficient_funds.js (ESM)
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { executePumpfunBuyFromBonding } from "./swapexecutor_pumpfun.js";

// canonicalize: allow passing "...pump"
function canonicalizeMint(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  return str.endsWith("pump") ? str.slice(0, -4) : str;
}

function pickSignerRpc() {
  const url = process.env.SIGNER_URL_1 || process.env.SOLANA_RPC_URL || process.env.RPC_URL_1;
  if (!url) throw new Error("Missing SIGNER_URL_1 (or fallback SOLANA_RPC_URL/RPC_URL_1) in env");
  return url;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node test_buy_insufficient_funds.js <mint|mintpump>");
    process.exit(1);
  }

  const mint = canonicalizeMint(arg);
  if (!mint) {
    console.error("❌ Invalid mint input");
    process.exit(1);
  }

  // validate mint format early
  try {
    new PublicKey(mint);
  } catch {
    console.error("❌ Mint is not a valid base58 public key:", mint);
    process.exit(1);
  }

  // show wallet + balance (same signer rpc)
  const rpc = pickSignerRpc();
  const conn = new Connection(rpc, process.env.COMMITMENT || "confirmed");

  const walletAddr = process.env.WALLET_ADDRESS;
  if (!walletAddr) {
    console.error("❌ WALLET_ADDRESS missing in .env");
    process.exit(1);
  }

  const walletPub = new PublicKey(walletAddr);
  const lamports = await conn.getBalance(walletPub, process.env.COMMITMENT || "confirmed");
  const sol = lamports / 1e9;

  console.log("=== TEST BUY (expect insufficient funds) ===");
  console.log("inputArg:", arg);
  console.log("canonicalMint:", mint);
  console.log("wallet:", walletPub.toBase58());
  console.log("balanceSOL:", sol);

  // Run executor
  const res = await executePumpfunBuyFromBonding({
    candidate: { mint }, // IMPORTANT: canonical mint only
  });

  console.log("=== EXEC RESULT ===");
  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error("❌ Test failed:", e?.message || e);
  process.exit(1);
});