// circulatingSupply.js
import { Connection, PublicKey } from "@solana/web3.js";
import { withRpcLimit } from "./rpcLimiter.js"; // import your rate limiter

// Use QuikNode RPC directly here
const connection = new Connection(
  "https://wandering-delicate-borough.solana-mainnet.quiknode.pro/679caa472345eaabcc50f82d792dd3af6cc50df3/",
  "confirmed"
);

/**
 * Get circulating supply of a Solana token (rate-limited)
 * @param {string} tokenMint - base58 mint address
 * @returns {Promise<{totalSupply: number, decimals: number}>}
 */
export async function getCirculatingSupply(tokenMint) {
  try {
    const mintPubkey = new PublicKey(tokenMint);

    // Use rate-limited RPC call
    const mintInfo = await withRpcLimit(() => connection.getTokenSupply(mintPubkey));

    const totalSupply = Number(mintInfo.value.amount) / 10 ** mintInfo.value.decimals;
    return { totalSupply, decimals: mintInfo.value.decimals };
  } catch (err) {
    console.error(`Error fetching circulating supply for ${tokenMint}:`, err);
    return { totalSupply: 0, decimals: 0 };
  }
}