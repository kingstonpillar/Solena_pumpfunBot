import {
  Connection,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import bs58 from "bs58";
import PQueue from "p-queue";
import BN from "bn.js";

import { OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import { PumpAmmSdk } from "@pump-fun/pump-swap-sdk";

// ---------------- RPC FAILOVER + PQUEUE ----------------
const RPC_URL_5 = process.env.RPC_URL_5 || "";
const RPC_URL_6 = process.env.RPC_URL_6 || "";
const COMMITMENT = process.env.COMMITMENT || "confirmed";

const RPC_CANDIDATES = [...new Set([RPC_URL_5, RPC_URL_6].filter(Boolean))];
if (!RPC_CANDIDATES.length) throw new Error("RPC_URL_5 or RPC_URL_6 is required");

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
    msg.includes("timeout") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable")
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
  throw new Error(`[RPC_FAILOVER] ${opName} failed. last=${String(lastErr?.message || lastErr)}`);
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
async function sendTelegram(message) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: String(message), disable_web_page_preview: true }),
    });
  } catch (error) {
    console.error("Error sending Telegram message:", error?.message || error);
  }
}

// ---------------- TX SENDERS ----------------
async function sendV0TxWithConn(conn, instructions, signers) {
  const { blockhash } = await conn.getLatestBlockhash(COMMITMENT);

  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign(signers);

  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, COMMITMENT);
  if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);

  return sig;
}

// ---------------- PUMP CURVE SELL ----------------
async function buildCurveSellIxs({ conn, mint, user, slippageBps, amountRaw }) {
  const onlineSdk = new OnlinePumpSdk(conn);
  const global = await onlineSdk.fetchGlobal();

  let sellState;
  if (typeof onlineSdk.fetchSellState === "function") {
    sellState = await onlineSdk.fetchSellState(mint, user);
  } else if (typeof onlineSdk.fetchBuyState === "function") {
    sellState = await onlineSdk.fetchBuyState(mint, user);
  } else {
    throw new Error("OnlinePumpSdk missing fetchSellState/fetchBuyState");
  }

  const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = sellState;

  const sellIxs = await PUMP_SDK.sellInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    amount: new BN(String(amountRaw)),
    slippage: Math.max(1, Math.floor(slippageBps / 100)),
  });

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...sellIxs,
  ];
}

// ---------------- AMM SELL ----------------
async function buildAmmSell({ conn, ammPool, userTokenAccount, amountRaw, slippageFrac }) {
  const ammSdk = new PumpAmmSdk({ connection: conn });
  const swapState = await ammSdk.swapSolanaState(ammPool, userTokenAccount);
  const built = await ammSdk.sellBaseInput(swapState, BigInt(amountRaw), slippageFrac);
  if (built.instructions) return { instructions: built.instructions };
  if (built.tx) return { tx: built.tx };
  return { instructions: null, tx: null };
}

// ---------------- MIGRATION DETECTION ----------------
async function detectMode({ conn, ammPool, userTokenAccount }) {
  try {
    const ammSdk = new PumpAmmSdk({ connection: conn });
    await ammSdk.swapSolanaState(ammPool, userTokenAccount);
    return "amm";
  } catch {
    return "curve";
  }
}

// ------------------ AUTO SELL ----------------
export async function executeAutoSellPumpfun({ mint, tokenAccount, amountRaw, slippageBps = 300, ammPoolPublicKey }) {
  if (!mint || !tokenAccount || !amountRaw || !ammPoolPublicKey)
    throw new Error("Missing required params");

  const wallet = getWallet();
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const tokenAccPk = tokenAccount instanceof PublicKey ? tokenAccount : new PublicKey(tokenAccount);
  const poolPk = ammPoolPublicKey instanceof PublicKey ? ammPoolPublicKey : new PublicKey(ammPoolPublicKey);

  return rpcLimited("autoSellPumpfun", async (conn) => {
    const mode = await detectMode({ conn, ammPool: poolPk, userTokenAccount: tokenAccPk });

    console.log(`AutoSell mode=${mode} mint=${mintPk.toBase58()} amountRaw=${String(amountRaw)}`);

    let signature;
    if (mode === "curve") {
      const ixs = await buildCurveSellIxs({ conn, mint: mintPk, user: wallet.publicKey, slippageBps, amountRaw });
      signature = await sendV0TxWithConn(conn, ixs, [wallet]);

      await sendTelegram(`✅ AutoSell Success (CURVE)\nMint: ${mintPk.toBase58()}\nAmount(raw): ${String(amountRaw)}\nTx: https://solscan.io/tx/${signature}`);
      return { mode, signature };
    }

    // AMM mode
    const slippageFrac = Math.max(0.001, Number(slippageBps) / 10_000);
    const built = await buildAmmSell({ conn, ammPool: poolPk, userTokenAccount: tokenAccPk, amountRaw, slippageFrac });

    if (built.instructions) {
      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ...built.instructions,
      ];
      signature = await sendV0TxWithConn(conn, ixs, [wallet]);
    } else if (built.tx) {
      signature = await sendV0TxWithConn(conn, [built.tx], [wallet]);
    } else {
      throw new Error("AMM sell build returned unknown shape");
    }

    await sendTelegram(`✅ AutoSell Success (AMM)\nMint: ${mintPk.toBase58()}\nAmount(raw): ${String(amountRaw)}\nTx: https://solscan.io/tx/${signature}`);
    return { mode, signature };
  });
}