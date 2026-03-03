import { PublicKey, Keypair, Connection, Transaction, sendAndConfirmTransaction, SystemProgram } from '@solana/web3.js';  // Correct import for SystemProgram
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';  // Correct imports
import fs from 'fs';  // For storing data in a JSON file
import crypto from 'crypto';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { PumpAmmSdk } from '@pump-fun/pump-swap-sdk';  // Import PumpAmmSdk for transactions
import { getPumpFunPriceOnce } from './pumpfun_price.js'; // Import your function to fetch Pumpfun price in SOL
import PQueue from 'p-queue';  // Import PQueue for RPC rate-limiting
import { BI, biAdd, biSub, biMul, biDiv, biMin, biMax, biStr } from './bigintSafe.js'; // Import BigInt utilities

dotenv.config();  // Load environment variables from .env file

const ProgramID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");  // Correct Pumpfun Program ID

// Ensure that environment variables are loaded correctly
const SIGNER_URL_1 = process.env.SIGNER_URL_1 || '';
const SIGNER_URL_2 = process.env.SIGNER_URL_2 || '';

// Ensure the SIGNER_URL variables are correctly initialized
if (!SIGNER_URL_1 || !SIGNER_URL_2) {
  throw new Error('❌ SIGNER_URL_1 or SIGNER_URL_2 is missing in the environment variables.');
}

// Function to pick RPC candidates (failover)
function pickRpcCandidates() {
  const candidates = [SIGNER_URL_1, SIGNER_URL_2].filter(Boolean);  // Filters out any undefined or null URLs

  if (candidates.length === 0) {
    throw new Error("❌ Missing SIGNER URLs in environment variables");
  }

  return candidates;
}

// Pick the first RPC URL from the candidates
let candidates = pickRpcCandidates();
let activeRpcUrl = candidates[0];
let connection = new Connection(activeRpcUrl, 'confirmed');  // Create the Solana connection

// RPC Queue for Rate-Limiting
const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

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
  connection = new Connection(activeRpcUrl, 'confirmed');  // Create the connection again with the new URL
}

console.log("RPC URLs initialized:", SIGNER_URL_1, SIGNER_URL_2);  // Debug log to check if URLs are correctly loaded

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

// Function to check and create ATA (Associated Token Account) for the user's wallet
async function getOrCreateATA(connection, wallet, mint) {
  // Step 1: Get the associated token address (ATA) for the mint (Pumpfun token) and wallet
  const associatedTokenAddress = await getAssociatedTokenAddress(
    mint,  // Token mint address
    wallet.publicKey  // The wallet public key (owner of the account)
  );

  // Step 2: Check if the ATA exists
  const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

  if (!accountInfo) {
    // Step 3: If the ATA doesn't exist, create it
    console.log('ATA does not exist. Creating ATA for mint:', mint.toString());

    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,  // Payer's wallet (signer)
        associatedTokenAddress,  // The derived ATA address
        wallet.publicKey,  // The wallet public key that will own the token
        mint  // The token mint address
      )
    );

    // Step 4: Send and confirm the transaction to create the ATA
    await sendAndConfirmTransaction(connection, transaction, [wallet]);
    console.log('Token account successfully created:', associatedTokenAddress.toString());
  } else {
    // Step 5: If the ATA exists
    console.log('ATA already exists:', associatedTokenAddress.toString());
  }

  return associatedTokenAddress;
}

// Convert BigInt to a byte array
function bigIntToBytes(bigInt) {
  const hex = bigInt.toString(16);
  const paddedHex = hex.padStart(Math.ceil(hex.length / 2) * 2, '0');
  const byteArray = new Uint8Array(paddedHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
  return byteArray;
}

// Function to add active position to the JSON file
function addActivePosition(position) {
  const positions = loadActivePositions();
  positions.push(position);  // Add new position to the list
  atomicWrite(ACTIVE_POSITIONS_FILE, positions);  // Write updated positions back to file
  return positions.length;  // Return the total count of positions
}

// Helper function to load positions from active_positions.json
function loadActivePositions() {
  return safeReadJson(ACTIVE_POSITIONS_FILE, []);
}

// Helper function to write data to active_positions.json
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));  // Write to temp file first
  fs.renameSync(tmp, file);  // Rename to the original file
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

// Main function to execute the Pumpfun buy from bonding (using dynamic mint)
export async function executePumpfunBuyFromBonding({
  candidate,          // Candidate object with mint information
  slippageBps = 300, // Slippage tolerance (default is 3%)
  trackVolume = true, // Optionally track volume
  buyMethod = 'buy_exact_sol_in' // Default to buying exact SOL in
} = {}) {
  if (!candidate?.mint) throw new Error("❌ candidate.mint missing");

  const mintAddress = candidate.mint instanceof PublicKey ? candidate.mint : new PublicKey(candidate.mint);

  const userKeypair = getWallet();  // Returns the user's Keypair
  
 // Ensure the ATA is created first
  const ataAddress = await getOrCreateATA(connection, userKeypair, mintAddress);
  console.log('ATA Address:', ataAddress.toString());
  
  const priceRes = await getPumpFunPriceOnce(candidate).catch((e) => ({
    priceSOL: null,
    source: "pumpfun_price_error",
    error: String(e?.message || e || "pumpfun_price_failed"),
  }));

  const pumpPriceSOL = Number(priceRes?.priceSOL);
  let buyPriceSOL = Number.isFinite(pumpPriceSOL) && pumpPriceSOL > 0 ? pumpPriceSOL : null;
  let buyPriceSource = buyPriceSOL ? (priceRes?.source || "pumpfun_price") : "jupiter_quote";

  if (!buyPriceSOL) {
    throw new Error("❌ Failed to get valid price for Pumpfun token");
  }

  const amountSol = process.env.SOL_TO_SPEND        
    ? BI(process.env.SOL_TO_SPEND) // Using BI function for safe BigInt conversion        
    : 1_000_000_000n; // Default to 1 SOL        

  const amountSolBytes = bigIntToBytes(amountSol);
  console.log(amountSolBytes);

  const amountTokens = biDiv(amountSol, buyPriceSOL);  // Safe division to calculate tokens
  console.log(`Buying ${biStr(amountTokens)} Pumpfun tokens for ${biStr(amountSol)} lamports`);

  const { instructions } = await pumpAmmSdk.buildPumpFunBuy(
    mintAddress,
    userKeypair,
    amountSol,
    slippageBps,
    buyMethod,
    trackVolume
  );

  const tx = new Transaction().add(...instructions);

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
    console.log(`Buy confirmed: https://solscan.io/tx/${sig}`);
    
    await sendTelegram(
      `✅ Pump.fun BUY SUCCESS\n\n` + 
      `Mint: ${mintAddress.toString()}\n` + 
      `Token Account: ${ataAddress.toString()}\n` + 
      `Buy Token Amount: ${biStr(amountTokens)}\n` + 
      `Tx: https://solscan.io/tx/${sig}`
    );

    const position = {
      mint: mintAddress.toString(), 
      owner: userKeypair.publicKey.toString(), 
      tokenAccount: ataAddress.toString(),
      amount: biStr(amountSol),
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