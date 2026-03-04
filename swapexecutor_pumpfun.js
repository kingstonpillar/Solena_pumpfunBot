
import { PublicKey, Keypair, Connection, Transaction, sendAndConfirmTransaction, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import fs from 'fs';
import crypto from 'crypto';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { PumpAmmSdk } from '@pump-fun/pump-swap-sdk'; 
import { getPumpFunPriceOnce } from './pumpfun_price.js'; 
import PQueue from 'p-queue'; 
import { BI, biAdd, biSub, biMul, biDiv, biMin, biMax, biStr } from './bigintSafe.js'; 

dotenv.config(); 

const ProgramID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"); 

// Ensure that environment variables are loaded correctly
const SIGNER_URL_1 = process.env.SIGNER_URL_1 || '';
const SIGNER_URL_2 = process.env.SIGNER_URL_2 || '';

// Ensure the SIGNER_URL variables are correctly initialized
if (!SIGNER_URL_1 || !SIGNER_URL_2) {
  throw new Error('❌ SIGNER_URL_1 or SIGNER_URL_2 is missing in the environment variables.');
}

// Function to pick RPC candidates (failover)
function pickRpcCandidates() {
  const candidates = [SIGNER_URL_1, SIGNER_URL_2].filter(Boolean);

  if (candidates.length === 0) {
    throw new Error("❌ Missing SIGNER URLs in environment variables");
  }

  return candidates;
}

// Pick the first RPC URL from the candidates
let candidates = pickRpcCandidates();
let activeRpcUrl = candidates[0];

// Initialize connection AFTER picking the RPC URL
let connection = new Connection(activeRpcUrl, 'confirmed'); 

// Initialize PumpAmmSdk AFTER connection is initialized
let pumpAmmSdk;
try {
  pumpAmmSdk = new PumpAmmSdk(connection);  
} catch (e) {
  console.error('❌ Failed to initialize PumpAmmSdk:', e.message);
  process.exit(1);  
}

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
      console.log(`Attempting ${opName} using RPC URL: ${url}`);
      return await rpcQueue.add(() => fn(connection));  
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
      console.warn(`[Retryable RPC error] Retrying ${opName}...`);
      continue;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  console.error(`[RPC_FAILOVER] ${opName} failed on all RPCs. Last error: ${msg}`);
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
  connection = new Connection(activeRpcUrl, 'confirmed');  
}

console.log("RPC URLs initialized:", SIGNER_URL_1, SIGNER_URL_2); 

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

/**
 * Returns { ata, tokenProgramId, created }
 * - created=true means we ADDED a create-ATA instruction (or sent create tx if you choose)
 */
export async function getOrCreateATAIx(connection, walletPubkey, mintPubkey) {
  // 1) Detect mint program (Tokenkeg vs Token-2022)
  const mintInfo = await connection.getAccountInfo(mintPubkey);
  if (!mintInfo) throw new Error(`❌ Mint account not found: ${mintPubkey.toBase58()}`);

  const tokenProgramId =
    mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  // 2) Derive ATA using the correct token program id
  const ata = await getAssociatedTokenAddress(
    mintPubkey,
    walletPubkey,
    false, // allowOwnerOffCurve
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // 3) Check existence
  const ataInfo = await connection.getAccountInfo(ata);

  if (ataInfo) {
    console.log(`✅ ATA already exists: ${ata.toBase58()} (tokenProgram=${tokenProgramId.toBase58()})`);
    return { ata, tokenProgramId, created: false, ix: null };
  }

  console.log(
    `🧾 ATA missing. Will create: ${ata.toBase58()} (tokenProgram=${tokenProgramId.toBase58()})`
  );

  const ix = createAssociatedTokenAccountInstruction(
    walletPubkey,          // payer
    ata,                   // ata address
    walletPubkey,          // owner
    mintPubkey,            // mint
    tokenProgramId,        // IMPORTANT: Token-2022 vs Tokenkeg
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return { ata, tokenProgramId, created: true, ix };
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

export async function executePumpfunBuyFromBonding({
  candidate,
  slippageBps = 300,
  trackVolume = true,
  buyMethod = "buy_exact_sol_in",
} = {}) {
  if (!candidate?.mint) throw new Error("❌ candidate.mint missing");

  const userKeypair = getWallet();
  const mint = candidate.mint instanceof PublicKey ? candidate.mint : new PublicKey(candidate.mint);

  // 1) Build ATA ix (if needed) and LOG it
  const { ata, ix: createAtaIx, created } = await getOrCreateATAIx(
    connection,
    userKeypair.publicKey,
    mint
  );

  if (created) console.log(`✅ ATA create instruction prepared for: ${ata.toBase58()}`);
  else console.log(`✅ Using existing ATA: ${ata.toBase58()}`);

  // 2) Amount, price, bigint math etc (your existing logic)
  const priceRes = await getPumpFunPriceOnce(candidate).catch((e) => ({
    priceSOL: null,
    source: "pumpfun_price_error",
    error: String(e?.message || e || "pumpfun_price_failed"),
  }));

  const pumpPriceSOL = Number(priceRes?.priceSOL);
  const buyPriceSOL = Number.isFinite(pumpPriceSOL) && pumpPriceSOL > 0 ? pumpPriceSOL : null;
  const buyPriceSource = buyPriceSOL ? (priceRes?.source || "pumpfun_price") : "jupiter_quote";
  if (!buyPriceSOL) throw new Error("❌ Failed to get valid price for Pumpfun token");

  const amountSol = process.env.SOL_TO_SPEND ? BI(process.env.SOL_TO_SPEND) : 1_000_000_000n;
  const amountTokens = biDiv(amountSol, buyPriceSOL);

  // 3) Build Pump instructions (SDK)
  const { instructions } = await pumpAmmSdk.buildPumpFunBuy(
    mint,
    userKeypair,
    amountSol,
    slippageBps,
    buyMethod,
    trackVolume
  );

  // 4) ONE tx: [optional ATA ix] + [...swap instructions]
  const tx = new Transaction();
  if (createAtaIx) tx.add(createAtaIx);
  tx.add(...instructions);

  const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
  console.log(`✅ Buy confirmed: https://solscan.io/tx/${sig}`);

  await sendTelegram(
    `✅ Pump.fun BUY SUCCESS\n\n` +
      `Mint: ${mint.toBase58()}\n` +
      `Token Account: ${ata.toBase58()}\n` +
      `Buy Token Amount: ${biStr(amountTokens)}\n` +
      `Buy Price SOL: ${biStr(buyPriceSOL)} (${buyPriceSource})\n` +
      `Tx: https://solscan.io/tx/${sig}`
  );

  const position = {
    mint: mint.toBase58(),
    owner: userKeypair.publicKey.toBase58(),
    tokenAccount: ata.toBase58(),
    amount: biStr(amountSol),
    amountTokens: biStr(amountTokens),
    buyPriceSOL: biStr(buyPriceSOL),
    buyPriceSource,
    transactionSignature: sig,
    dateAdded: new Date().toISOString(),
  };

  const newCount = addActivePosition(position);
  console.log(`✅ Position saved. Total positions: ${newCount}`);

  return sig;
}