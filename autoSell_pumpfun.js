import { PumpAmmSdk, PumpAmmInternalSdk } from "@pump-fun/pump-swap-sdk";
import { Connection, PublicKey, Transaction, Keypair, TransactionInstruction } from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import bs58 from "bs58";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import PQueue from "p-queue";

// ---------------- RPC FAILOVER + PQUEUE ----------------
const RPC_URL_5 = process.env.RPC_URL_5 || "";
const RPC_URL_6 = process.env.RPC_URL_6 || "";
const COMMITMENT = process.env.COMMITMENT || "confirmed";

const RPC_CANDIDATES = [...new Set([RPC_URL_5, RPC_URL_6].filter(Boolean))];

if (RPC_CANDIDATES.length === 0) throw new Error("RPC_URL_5 or RPC_URL_6 is required");

const rpcQueue = new PQueue({
  concurrency: Number(process.env.RPC_CONCURRENCY || 4),
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  const code = e?.code;
  return (
    code === 429 ||
    code === -32005 ||
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

async function withRpcFailover(opName, fn) {
  let lastErr = null;
  for (const url of RPC_CANDIDATES) {
    const conn = new Connection(url, COMMITMENT);
    try {
      return await fn(conn, url);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed. last=${msg}`);
}

function rpcLimited(opName, fn) {
  return rpcQueue.add(() => withRpcFailover(opName, fn));
}

// ---------------- DECRYPTION AND WALLET LOADING ----------------
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
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("Passphrase file missing: " + passphrasePath);

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secret = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secret);
}

// ------------------ TELEGRAM NOTIFICATION ------------------
async function sendTelegram(message: string) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Missing Telegram bot token or chat ID in environment variables");
  }

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
  } catch (error) {
    console.error("Error sending Telegram message:", error);
  }
}

// Function to fetch bonding curve status
async function fetchBondingCurveStatus(bondingCurvePublicKey: PublicKey): Promise<string> {
  try {
    const accountInfo = await connection.getAccountInfo(bondingCurvePublicKey, "confirmed");

    if (!accountInfo) {
      throw new Error("Bonding curve account not found");
    }

    const data = accountInfo.data;
    const isComplete = decodeBondingCurveData(data);

    return isComplete ? "completed" : "in_progress";
  } catch (error) {
    console.error("Error fetching bonding curve status:", error);
    return "error";
  }
}

function decodeBondingCurveData(data: Buffer): boolean {
  return data[0] === 1;
}

// ------------------ AUTO SELL ------------------
export async function executeAutoSellPumpfun({ mint, tokenAccount, amount }) {
  const ammSdk = new PumpAmmSdk({ connection });
  const bondingCurvePublicKey = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"); // Bonding curve public key inserted here
  const ammPoolPublicKey = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"); // AMM pool public key inserted here

  const wallet = getWallet(); // Decrypt wallet using the private key

  async function checkBondingCurveStatus(bondingCurvePublicKey: PublicKey): Promise<boolean> {
    const status = await fetchBondingCurveStatus(bondingCurvePublicKey);
    return status === "completed";
  }

  try {
    const isBondingComplete = await checkBondingCurveStatus(bondingCurvePublicKey);
    let swapState;

    console.log(`Proceeding with the sell of ${amount} tokens.`);

    if (!isBondingComplete) {
      // Token is still in the bonding curve, handle bonding curve sell logic
      console.log("Token is still in the bonding curve stage.");
      const sellTx = await executeBondingCurveSell(mint, tokenAccount, amount, bondingCurvePublicKey, wallet);
      console.log(`Successfully executed sell of ${amount} tokens on bonding curve.`);
      // Send a success message to Telegram
      await sendTelegram(`Successfully executed sell of ${amount} tokens on bonding curve.`);
      return sellTx;
    } else {
      // Token has migrated to AMM, execute AMM sell logic
      console.log("Token has migrated to AMM.");
      swapState = await ammSdk.swapSolanaState(ammPoolPublicKey, tokenAccount);

      const result = await executeAmmSell(swapState, amount, wallet);
      console.log(`Successfully executed sell of ${amount} tokens on AMM.`);
      // Send a success message to Telegram
      await sendTelegram(`Successfully executed sell of ${amount} tokens on AMM.`);
      return result;
    }
  } catch (error) {
    console.error("Error executing auto sell on PumpSwap:", error);
  }
}

// Function to sell on the bonding curve directly
async function executeBondingCurveSell(mint, tokenAccount, amount, bondingCurvePublicKey: PublicKey, wallet: Keypair) {
  try {
    console.log(`Selling ${amount} tokens through bonding curve for mint ${mint.toBase58()}`);

    const instruction = new TransactionInstruction({
      programId: bondingCurvePublicKey,
      data: Buffer.from([]),
      keys: [
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
      ],
    });

    const transaction = new Transaction().add(instruction);
    transaction.sign(wallet); // Sign the transaction with the decrypted wallet

    const signature = await rpcLimited("sendTransaction", async (conn) => {
      return await conn.sendTransaction(transaction, [wallet]);
    });
    await connection.confirmTransaction(signature);
    console.log("Transaction confirmed:", signature);

    return signature;
  } catch (error) {
    console.error("Error executing sell on bonding curve:", error);
    throw new Error("Bonding curve sell failed");
  }
}

// Function to execute the AMM sell with robust slippage handling and confirmation
async function executeAmmSell(swapState, amount, wallet: Keypair) {
  try {
    const slippage = 0.005; // 0.5% slippage tolerance
    const ammSdkInternal = new PumpAmmInternalSdk({ connection });

    const sellTx = await ammSdkInternal.sellBaseInput(
      swapState,
      BigInt(amount),  // Amount to sell (in smallest token unit)
      slippage         // Slippage tolerance
    );

    // Sign the transaction with the decrypted wallet
    const transaction = new Transaction().add(sellTx);
    transaction.sign(wallet);

    const confirmation = await connection.confirmTransaction(sellTx.signature);
    if (confirmation.value.err) {
      throw new Error("Transaction failed: " + confirmation.value.err);
    }

    console.log(`AMM transaction successful. Signature: ${sellTx.signature}`);
    return sellTx;

  } catch (error) {
    console.error("Error executing AMM sell:", error);
    throw new Error("AMM sell failed");
  }
}