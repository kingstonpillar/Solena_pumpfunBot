import { Transaction, sendAndConfirmTransaction, Keypair, Connection } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';
import crypto from 'crypto';
import bs58 from 'bs58';
import { getPumpFunPriceOnce } from './pumpfun_Price.js'; // Import your function to get Pumpfun price in SOL
import PQueue from 'p-queue'; // Import PQueue for rate-limiting

// Path to the active positions file
const ACTIVE_POSITIONS_FILE = './active_positions.json';

// Helper function to load positions from active_positions.json
function loadActivePositions() {
  return safeReadJson(ACTIVE_POSITIONS_FILE, []);
}

// Helper function to write data to active_positions.json
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); // Write to temp file first
  fs.renameSync(tmp, file); // Rename to the original file
}

// Helper function to read JSON safely
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

// Add new active position to JSON
function addActivePosition(position) {
  const positions = loadActivePositions(); // Load current positions
  positions.push(position); // Add new position to array
  atomicWrite(ACTIVE_POSITIONS_FILE, positions); // Write back to the JSON file
  return positions.length; // Return the new count
}

// Decrypting the private key and loading the wallet
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWallet() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("❌ ENCRYPTED_KEY missing in .env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("❌ Passphrase file missing.");

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

// RPC Queue for Rate-Limiting
const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

// Use SIGNER_URL_1 and SIGNER_URL_2 from environment variables
const SIGNER_URL_1 = process.env.SIGNER_URL_1 || "";
const SIGNER_URL_2 = process.env.SIGNER_URL_2 || "";

// Function to pick RPC candidates (failover)
function pickRpcCandidates() {
  const candidates = [SIGNER_URL_1, SIGNER_URL_2].filter(Boolean);  // Filters out any undefined or null URLs

  if (candidates.length === 0) {
    throw new Error("❌ Missing SIGNER URLs in environment variables");
  }

  return candidates;
}

// Switch RPC URL
let candidates = pickRpcCandidates();
let activeRpcUrl = candidates[0];
let conn = new Connection(activeRpcUrl, 'confirmed');

// Function to handle RPC failover
async function withRpcFailover(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      return await rpcQueue.add(() => fn(conn));  // Add function to queue
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
      continue;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed on all RPCs. last=${msg}`);
}

// Check if the error is retryable
function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("node is behind") ||
    msg.includes("block height exceeded")
  );
}

// Switch RPC URL based on the passed URL
function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, 'confirmed');
}

// Main function to execute the Pumpfun buy
export async function executePumpfunBuyFromBonding({
  candidate,          // Candidate object with mint information
  slippageBps = 300, // Slippage tolerance (default is 3%)
  trackVolume = true, // Optionally track volume
  buyMethod = 'buy_exact_sol_in' // Default to buying exact SOL in
} = {}) {
  if (!candidate?.mint) throw new Error("❌ candidate.mint missing");

  // Step 1: Get the wallet (Keypair) from the decrypted private key
  const userKeypair = getWallet(); // Returns the user's Keypair

  // Step 2: Derive the Associated Token Account (ATA) address for the candidate's token
  const ataAddress = await getAssociatedTokenAddress(
    candidate.mint,      // The mint address for the Pumpfun token
    userKeypair.publicKey // The wallet address that will own the token account
  );

  // Step 3: Get the amount of SOL to spend from the environment variable (SOL_TO_SPEND in lamports)
  const amountSol = process.env.SOL_TO_SPEND ? BigInt(process.env.SOL_TO_SPEND) : 1_000_000n; // Default to 0.001 SOL if not set

  // Step 4: Dynamically fetch price of Pumpfun token in SOL
  const priceRes = await getPumpFunPriceOnce(candidate).catch((e) => ({
    priceSOL: null,
    source: "pumpfun_price_error",
    error: String(e?.message || e || "pumpfun_price_failed"),
  }));

  const pumpPriceSOL = Number(priceRes?.priceSOL);
  let buyPriceSOL = Number.isFinite(pumpPriceSOL) && pumpPriceSOL > 0 ? pumpPriceSOL : null;

  // Track where entry price came from
  let buyPriceSource = buyPriceSOL ? (priceRes?.source || "pumpfun_price") : "jupiter_quote";

  if (!buyPriceSOL) {
    throw new Error("❌ Failed to get valid price for Pumpfun token");
  }

  // Step 5: Calculate the amount of Pumpfun tokens to buy
  const amountTokens = amountSol / BigInt(buyPriceSOL * 1_000_000_000); // Convert SOL to lamports and calculate token amount
  console.log(`Buying ${amountTokens} Pumpfun tokens for ${amountSol} lamports`);

  // Step 6: Create a transaction object
  const transaction = new Transaction();

  // Step 7: Check if the ATA exists, and create it if necessary
  try {
    await conn.getAccountInfo(ataAddress); // Ensure to use 'conn' here
  } catch (error) {
    // If the ATA doesn't exist, create it
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        userKeypair.publicKey, // The wallet paying for the transaction
        ataAddress,            // The derived ATA address for the Pumpfun token
        userKeypair.publicKey, // The wallet address that will own the token account
        candidate.mint         // The Pumpfun token mint address
      )
    );
  }

  // Step 8: Create the buy instruction
  const data = Buffer.from(Uint8Array.of(
    1,                   // Operation type: 1 could represent "buy" (adjust as necessary)
    slippageBps,         // Slippage tolerance
    trackVolume ? 1 : 0, // Whether to track volume
    ...amountSol.toBytes()  // The amount of SOL to spend in lamports
  ));

  const buyInstruction = new TransactionInstruction({
    keys: [
      { pubkey: userKeypair.publicKey, isSigner: true, isWritable: true },   // Payer's wallet (signer)
      { pubkey: ataAddress, isSigner: false, isWritable: true },             // The ATA to receive the token
      { pubkey: candidate.mint, isSigner: false, isWritable: false },       // Mint address for Pumpfun
    ],
    programId: TOKEN_PROGRAM_ID,  // This is the standard token program ID for Solana
    data,  // The transaction data (includes the buy action)
  });

  // Add the buy instruction to the transaction
  transaction.add(buyInstruction);

  // Step 9: Send the transaction and confirm it
  try {
    const sig = await sendAndConfirmTransaction(conn, transaction, [userKeypair]);
    console.log(`Buy confirmed: https://solscan.io/tx/${sig}`);

    // After the transaction is confirmed, add the new active position to the JSON file
    const position = {
      mint: candidate.mint.toString(), // Use `mint` here instead of `mintAddress`
      owner: userKeypair.publicKey.toString(), // Convert to string for storage
      tokenAccount: ataAddress.toString(), // Store the token account (ATA) address
      amount: amountSol.toString(), // Store the amount in string format (SOL spent in lamports)
      amountTokens: amountTokens.toString(), // Log the amount of Pumpfun tokens bought
      buyPriceSOL: buyPriceSOL.toString(), // Log the buy price in SOL
      buyPriceSource, // Track the source of the price (e.g., "pumpfun_price" or "jupiter_quote")
      transactionSignature: sig, // Store the transaction signature
      dateAdded: new Date().toISOString() // Timestamp when the position was added
    };

    const newCount = addActivePosition(position);
    console.log(`Position added successfully! Total positions: ${newCount}`);

    return sig;  // Return the transaction signature for further use
  } catch (error) {
    console.error("❌ Error executing Pumpfun buy transaction:", error);
    throw new Error("❌ Transaction failed");
  }
}