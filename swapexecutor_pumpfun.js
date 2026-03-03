import { PublicKey, Keypair, Connection, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { Token, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram } from '@solana/spl-token';
import fs from 'fs';  // For storing data in a JSON file
import crypto from 'crypto';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { PumpAmmSdk } from '@pump-fun/pump-swap-sdk';  // Import PumpAmmSdk for transactions
import { getPumpFunPriceOnce } from './pumpfun_price.js'; // Import your function to fetch Pumpfun price in SOL
import PQueue from 'p-queue';  // Import PQueue for RPC rate-limiting
import { BI, biAdd, biSub, biMul, biDiv, biMin, biMax, biStr } from './bigintSafe.js'; // Import BigInt utilities

dotenv.config();  // Load environment variables from .env file

// Define the Pumpfun Program ID (Curve Program ID)
const ProgramID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");  // Correct Pumpfun Program ID

// Solana connection setup
let candidates = pickRpcCandidates();
let activeRpcUrl = candidates[0];
let connection = new Connection(activeRpcUrl, 'confirmed');  // Consistent usage of `connection`

// Initialize PumpAmmSdk
const pumpAmmSdk = new PumpAmmSdk(connection);

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

// Function to handle RPC failover
async function withRpcFailover(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      return await rpcQueue.add(() => fn(connection));  // Use `connection` here
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
  connection = new Connection(activeRpcUrl, 'confirmed');  // Use `connection` for switching
}

// Function to decrypt the private key and load the wallet
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// Function to load the wallet's Keypair (decrypt private key)
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

// Function to create Associated Token Account (ATA) if it doesn't exist
async function getOrCreateATA(connection, wallet, mint) {
  // Use mint (PublicKey) directly, no need for mintAddress variable
  const associatedTokenAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,  // Use `SystemProgram.programId` for ATA creation
    mint,  // Directly use mint here
    wallet.publicKey
  );

  // Check if the ATA already exists
  const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

  if (accountInfo === null) {
    // If the ATA doesn't exist, create it
    const transaction = new Transaction().add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SystemProgram.programId, // Correct use of SystemProgram for account creation
        wallet.publicKey,
        associatedTokenAddress,
        wallet.publicKey,
        mint // Use mint here as well
      )
    );

    await sendAndConfirmTransaction(connection, transaction, [wallet]);
    console.log('Token account created for mint: ', mint.toString());
  }

  return associatedTokenAddress;
}

// Function to send a Telegram message
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

// Convert BigInt to a byte array
function bigIntToBytes(bigInt) {
  const hex = bigInt.toString(16);
  const paddedHex = hex.padStart(Math.ceil(hex.length / 2) * 2, '0');
  const byteArray = new Uint8Array(paddedHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
  return byteArray;
}

// Main function to execute the Pumpfun buy from bonding (using dynamic mint)
export async function executePumpfunBuyFromBonding({
  candidate,          // Candidate object with mint information
  slippageBps = 300, // Slippage tolerance (default is 3%)
  trackVolume = true, // Optionally track volume
  buyMethod = 'buy_exact_sol_in' // Default to buying exact SOL in
} = {}) {
  if (!candidate?.mint) throw new Error("❌ candidate.mint missing");

  // Dynamically fetch the mint address from the candidate
  const mintAddress = candidate.mint instanceof PublicKey ? candidate.mint : new PublicKey(candidate.mint);

  // Step 1: Get the wallet (Keypair) from the decrypted private key
  const userKeypair = getWallet(); // Returns the user's Keypair

  // Step 2: Derive the Associated Token Account (ATA) address for the candidate's token
  const ataAddress = await getOrCreateATA(connection, userKeypair, mintAddress);

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

  // Step 4: Calculate the amount of SOL to spend (based on environment variable or default)
  const amountSol = process.env.SOL_TO_SPEND        
    ? BI(process.env.SOL_TO_SPEND) // Using BI function for safe BigInt conversion        
    : 1_000_000_000n; // Default to 1 SOL        

  // Convert amountSol to a byte array      
  const amountSolBytes = bigIntToBytes(amountSol);

  console.log(amountSolBytes); // Log the byte array

  // Step 5: Calculate the amount of Pumpfun tokens to buy      
  const amountTokens = biDiv(amountSol, buyPriceSOL); // Use biDiv for safe division      
  console.log(`Buying ${biStr(amountTokens)} Pumpfun tokens for ${biStr(amountSol)} lamports`);

  // Step 6: Use PumpAmmSdk to build the buy transaction
  const { instructions } = await pumpAmmSdk.buildPumpFunBuy(
    mintAddress,  // Token mint address passed dynamically
    userKeypair,  // User's keypair
    amountSol,    // Amount in SOL to spend
    slippageBps,  // Slippage tolerance
    buyMethod,    // Buy method (default: 'buy_exact_sol_in')
    trackVolume   // Track volume flag
  );

  // Step 7: Create a transaction object and add instructions
  const tx = new Transaction().add(...instructions);

  // Step 8: Send and confirm the transaction
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
    console.log(`Buy confirmed: https://solscan.io/tx/${sig}`);
    
    // Send Telegram alert
    await sendTelegram(
      `✅ Pump.fun BUY SUCCESS\n\n` + 
      `Mint: ${mintAddress.toString()}\n` + 
      `Token Account: ${ataAddress.toString()}\n` + 
      `Buy Token Amount: ${biStr(amountTokens)}\n` + 
      `Tx: https://solscan.io/tx/${sig}`
    );

    // After the transaction is confirmed, add the new active position to the JSON file
    const position = {
      mint: mintAddress.toString(), 
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