
import { Connection, PublicKey } from "@solana/web3.js";
import { withRpcLimit } from "./rpcLimiter.js";

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=3d3070cd-74df-4a20-a48b-abe1533174e0";

const MIGRATION_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const connection = new Connection(RPC_ENDPOINT, "confirmed");

/**
 * Check if a PumpSwap pair account is migrated
 * @param {string} pairAddress
 * @returns {Promise<boolean>}
 */
export async function checkPumpMigration(pairAddress) {
  try {
    const pairPubkey = new PublicKey(pairAddress);

    const accountInfo = await withRpcLimit(() =>
      connection.getAccountInfo(pairPubkey)
    );

    if (!accountInfo) return false;

    return accountInfo.owner.equals(MIGRATION_PROGRAM_ID);

  } catch (err) {
    console.error("Pump migration check failed:", err);
    return false;
  }
}
