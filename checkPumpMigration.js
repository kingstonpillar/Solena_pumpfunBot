
import { Connection, PublicKey } from "@solana/web3.js";
import { withRpcLimit } from "./rpcLimiter.js";

const RPC_ENDPOINT = "https://wandering-delicate-borough.solana-mainnet.quiknode.pro/679caa472345eaabcc50f82d792dd3af6cc50df3/";

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
