// raydiumSdk.js
import dotenv from "dotenv";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair } from "@solana/web3.js";

dotenv.config();

const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.RPC_URL_1;

if (!RPC_URL) {
  throw new Error("Missing RPC URL");
}

export const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
});

let raydium;

function makeDummyOwner() {
  // Read-only price fetch path.
  // Raydium.load wants an owner/public key context in many setups.
  return Keypair.generate();
}

export async function initRaydiumSdk() {
  if (raydium) return raydium;

  const owner = makeDummyOwner();

  raydium = await Raydium.load({
    connection,
    owner,
    cluster: "mainnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "finalized",
  });

  return raydium;
}