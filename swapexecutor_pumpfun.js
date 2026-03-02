import { PublicKey, Transaction, sendAndConfirmTransaction, Keypair, Connection } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';
import crypto from 'crypto';
import bs58 from 'bs58';
import { getPumpFunPriceOnce } from './pumpfun_price.js'; // Import your function to fetch Pumpfun price in SOL
import PQueue from 'p-queue'; // Import PQueue for rate-limiting
import dotenv from 'dotenv';
import { BI, biAdd, biSub, biMul, biDiv, biMin, biMax, biStr } from './bigintSafe.js'; // Import BigInt utilities from bigintSafe.js

dotenv.config();  // Load environment variables from .env file

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

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn("Telegram not configured.");
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(message),
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.warn("Telegram error:", err?.message || err);
  }
}

function bigIntToBytes(bigInt) {
  // Convert BigInt to hex string
  const hex = bigInt.toString(16);

  // Ensure the hex string has an even length (by padding with a leading 0 if necessary)
  const paddedHex = hex.padStart(Math.ceil(hex.length / 2) * 2, '0');

  // Convert hex string to an array of bytes (Uint8Array)
  const byteArray = new Uint8Array(paddedHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));

  return byteArray;
}

// Main function to execute the Pumpfun buy
export async function executePumpfunBuyFromBonding({
  candidate,          // Candidate object with mint information
  slippageBps = 300, // Slippage tolerance (default is 3%)
  trackVolume = true, // Optionally track volume
  buyMethod = 'buy_exact_sol_in' // Default to buying exact SOL in
} = {}) {
  if (!candidate?.mint) throw new Error("❌ candidate.mint missing");

  // Ensure mint is a PublicKey
  const mint = candidate.mint instanceof PublicKey ? candidate.mint : new PublicKey(candidate.mint);

  // Step 1: Get the wallet (Keypair) from the decrypted private key
  const userKeypair = getWallet(); // Returns the user's Keypair

  // Step 2: Derive the Associated Token Account (ATA) address for the candidate's token
  const ataAddress = await getAssociatedTokenAddress(
    mint,      // Use PublicKey here
    userKeypair.publicKey // The wallet address that will own the token account
  );

  // Step 3: Fetch dynamic price for Pumpfun token in SOL
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

  
  // Convert SOL to lamports by multiplying by 1e9 (1 SOL = 1,000,000,000 lamports)
// Example usage:
const amountSol = process.env.SOL_TO_SPEND
  ? BI(process.env.SOL_TO_SPEND) // Using BI function for safe BigInt conversion
  : 1_000_000_000n; // Default to 1 SOL

// Convert amountSol to a byte array      
const amountSolBytes = bigIntToBytes(amountSol);

console.log(amountSolBytes); // Log the byte array

  // Step 5: Calculate the amount of Pumpfun tokens to buy      
  const amountTokens = biDiv(amountSol, buyPriceSOL); // Use biDiv for safe division      
  console.log(`Buying ${biStr(amountTokens)} Pumpfun tokens for ${biStr(amountSol)} lamports`);      

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
        mint                   // The Pumpfun token mint address (as PublicKey)
      )
    );
  }

  // Step 8: Create the buy instruction      
  const data = Buffer.from(Uint8Array.of(
    1,                   // Operation type: 1 could represent "buy" (adjust as necessary)
    slippageBps,         // Slippage tolerance
    trackVolume ? 1 : 0, // Whether to track volume
    ...amountSolBytes     // The amount of SOL to spend in lamports (using safe conversion)
  ));

  const buyInstruction = new TransactionInstruction({
    keys: [
      { pubkey: userKeypair.publicKey, isSigner: true, isWritable: true },   // Payer's wallet (signer)
      { pubkey: ataAddress, isSigner: false, isWritable: true },             // The ATA to receive the token
      { pubkey: mint, isSigner: false, isWritable: false },                 // Mint address for Pumpfun
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
    
    // Send Telegram alert
    await sendTelegram(
      `✅ Pump.fun BUY SUCCESS\n\n` + 
      `Mint: ${mint.toString()}\n` + 
      `Token Account: ${ataAddress.toString()}\n` + 
      `Buy Token Amount: ${biStr(amountTokens)}\n` + 
      `Tx: https://solscan.io/tx/${sig}`
    );

    // After the transaction is confirmed, add the new active position to the JSON file
    const position = {
      mint: mint.toString(), 
      owner: userKeypair.publicKey.toString(), 
      tokenAccount: ataAddress.toString(),
      amount: biStr(amountSol), // Convert to string for consistency
      amountTokens: biStr(amountTokens),
      buyPriceSOL: biStr(buyPriceSOL),
      buyPriceSource,
      transactionSignature: sig,
      dateAdded: new Date().toISOString()
    };

    const newCount = addActivePosition(position);
    console.log(`Position added successfully! Total positions: ${newCount}`);

    return sig;
  } catch (error) {
    console.error("❌ Error executing Pumpfun buy transaction:", error);
    throw new Error("❌ Transaction failed");
  }
}