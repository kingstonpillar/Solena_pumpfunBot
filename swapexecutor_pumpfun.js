import {
  Connection,
  PublicKey,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";


import fs from 'fs';
import crypto from 'crypto';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import BN from "bn.js";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { getPumpFunPriceOnce } from './pumpfun_price.js'; // Import getPumpFunPriceOnce for price fetching
import PQueue from 'p-queue'; 
import { BI, biAdd, biSub, biMul, biDiv, biMin, biMax, biStr } from './bigintSafe.js'; 

dotenv.config(); 

const ACTIVE_POSITIONS_FILE =
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json";



// Setup RPC URLs from environment
const SIGNER_URL_1 = process.env.SIGNER_URL_1 || '';
const SIGNER_URL_2 = process.env.SIGNER_URL_2 || '';

if (!SIGNER_URL_1 || !SIGNER_URL_2) {
  throw new Error('❌ SIGNER_URL_1 or SIGNER_URL_2 is missing in the environment variables.');
}

// Picking RPC URL
function pickRpcCandidates() {
  const candidates = [SIGNER_URL_1, SIGNER_URL_2].filter(Boolean);
  if (candidates.length === 0) {
    throw new Error("❌ Missing SIGNER URLs in environment variables");
  }
  return candidates;
}

let candidates = pickRpcCandidates();
let activeRpcUrl = candidates[0];
let connection = new Connection(activeRpcUrl, 'confirmed'); 

const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

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

function switchRpc(url) {
  activeRpcUrl = url;
  connection = new Connection(activeRpcUrl, 'confirmed');  
}

console.log("RPC URLs initialized:", SIGNER_URL_1, SIGNER_URL_2); 

// Send Telegram notification function
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

async function sendV0Tx(instructions, signers) {
  return withRpcFailover("sendV0Tx", async (conn) => {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");

    const msg = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign(signers);

    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);

    return sig;
  });
}

// Function to decrypt private key and load the wallet
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

/**
 * Returns { ata, tokenProgramId, created }
 * - created=true means we ADDED a create-ATA instruction (or sent create tx if you choose)
 */
export async function getOrCreateATAIx(connection, walletPubkey, mintPubkey) {
  const mintInfo = await connection.getAccountInfo(mintPubkey);
  if (!mintInfo) throw new Error(`❌ Mint account not found: ${mintPubkey.toBase58()}`);

  const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const ata = await getAssociatedTokenAddress(
    mintPubkey,
    walletPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const ataInfo = await connection.getAccountInfo(ata);

  if (ataInfo) {
    console.log(
      `✅ ATA already exists: ${ata.toBase58()} (tokenProgram=${tokenProgramId.toBase58()})`
    );
    return { ata, tokenProgramId, created: false, ix: null };
  }

  console.log(
    `🧾 ATA missing. Will create (idempotent): ${ata.toBase58()} (tokenProgram=${tokenProgramId.toBase58()})`
  );

  const ix = createAssociatedTokenAccountIdempotentInstruction(
    walletPubkey,                 // payer
    ata,                          // ata
    walletPubkey,                 // owner
    mintPubkey,                   // mint
    tokenProgramId,               // Token-2022 OR Tokenkeg
    ASSOCIATED_TOKEN_PROGRAM_ID   // ATA program
  );

  return { ata, tokenProgramId, created: true, ix };
}

function bigIntToBytes(bigInt) {
  const hex = bigInt.toString(16);
  const paddedHex = hex.padStart(Math.ceil(hex.length / 2) * 2, '0');
  const byteArray = new Uint8Array(paddedHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
  return byteArray;
}

function addActivePosition(position) {
  const positions = loadActivePositions();
  positions.push(position);
  atomicWrite(ACTIVE_POSITIONS_FILE, positions);
  return positions.length;
}

function loadActivePositions() {
  return safeReadJson(ACTIVE_POSITIONS_FILE, []);
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

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
}) {
  if (!candidate?.mint) throw new Error("❌ candidate.mint missing");

  const userKeypair = getWallet();
  const mint =
    candidate.mint instanceof PublicKey
      ? candidate.mint
      : new PublicKey(candidate.mint);

  // ATA (Tokenkeg or Token-2022) + optional create ix
  const { ata, tokenProgramId, ix: createAtaIx, created } =
    await getOrCreateATAIx(connection, userKeypair.publicKey, mint);

  console.log(created ? `✅ ATA will be created in-tx` : `✅ Using existing ATA`);

  // External price fetch (keep only for position fields)
  const priceRes = await getPumpFunPriceOnce(candidate).catch((e) => ({
    priceSOL: null,
    source: "pumpfun_price_error",
    error: String(e?.message || e || "pumpfun_price_failed"),
  }));

  const pumpPriceSOL = Number(priceRes?.priceSOL);
  const buyPriceSOL =
    Number.isFinite(pumpPriceSOL) && pumpPriceSOL > 0 ? pumpPriceSOL : null;

  if (!buyPriceSOL) throw new Error("❌ Failed to get valid price for Pumpfun token");

  // Build Pump curve buy, optionally include ATA creation ix in SAME tx
  try {
    const onlineSdk = new OnlinePumpSdk(connection);

    const solToSpend = Number(process.env.SOL_TO_SPEND || "0.01"); // SOL
const solAmountLamports = BigInt(Math.floor(solToSpend * 1e9)); // lamports
const solAmount = new BN(solAmountLamports.toString());

    // Fetch Pump state needed to build buy ix
    const global = await onlineSdk.fetchGlobal();
    const feeConfig = await onlineSdk.fetchFeeConfig();

    // Fetch buy state (includes bonding curve + user ATA info)
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
      await onlineSdk.fetchBuyState(mint, userKeypair.publicKey);

    // Compute token out (raw)
    const tokenOut = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: bondingCurve.tokenTotalSupply,
      bondingCurve,
      amount: solAmount,
      isNewBondingCurve: true,
    });

    console.log(
      `Buying on curve | SOL in: ${solAmountLamports} lamports | tokenOut(raw): ${tokenOut.toString()} | buyPriceSOL(ext): ${buyPriceSOL}`
    );

    // Build bonding-curve buy instructions
    const buyIxs = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      associatedUserAccountInfo,
      mint,
      user: userKeypair.publicKey,
      amount: tokenOut,
      solAmount,
      slippage: Math.max(1, Math.floor(slippageBps / 100)), // bps -> %
    });

    // Final instruction list
    const ixs = [];

    // Optional: priority + compute
    ixs.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
    );

    // Create ATA first if missing
    if (createAtaIx) ixs.push(createAtaIx);

    // Then Pump buy
    ixs.push(...buyIxs);

    // Submit as one v0 tx
    const signature = await sendV0Tx(ixs, [userKeypair]);
    console.log(`✅ Transaction confirmed: https://solscan.io/tx/${signature}`);

    await sendTelegram(
      `✅ Bonding Curve Buy Success\n\nMint: ${mint.toBase58()}\nATA: ${ata.toBase58()}\nTokenOut(raw): ${tokenOut.toString()}\nBuyPriceSOL(ext): ${buyPriceSOL}\nTx: https://solscan.io/tx/${signature}`
    );

    // ONLY JSON we store: position
    const position = {
      mint: mint.toBase58(),
      owner: userKeypair.publicKey.toBase58(),
      tokenAccount: ata.toBase58(),
      tokenProgram: tokenProgramId.toBase58(),

      amountTokens: tokenOut.toString(), // raw units
      pumpPriceSOL: String(buyPriceSOL),
      buyPriceSOL: String(buyPriceSOL),

      solSpentLamports: solAmountLamports.toString(),
      slippageBps,

      transactionSignature: signature,
      dateAdded: new Date().toISOString(),

      // optional debug fields (still part of position, remove if you don't want them)
      priceSource: String(priceRes?.source || "pumpfun_price"),
      priceError: priceRes?.error ? String(priceRes.error) : null,
    };

    console.log("Position:", JSON.stringify(position, null, 2));

    const newCount = addActivePosition(position);
    console.log(`✅ Position saved. Total positions: ${newCount}`);

    return { ata: ata.toBase58(), signature, buyPriceSOL };
  } catch (e) {
    console.error("❌ Failed to execute buy:", e?.message || e);
    throw new Error("Bonding curve buy failed");
  }
}