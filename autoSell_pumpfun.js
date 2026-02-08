// autoSell_pumpfun.js (ESM)
// Pump.fun sell executor using PumpPortal trade-local (returns tx for your local signing).
// Adds:
// - PQueue rate limiting to reduce 429/rate limit bursts
// - RPC failover: RPC_URL_5 -> RPC_URL_6
// - Wallet decrypt + SOL balance read + token ATA balance read INSIDE main logic
// - If token balance is 0: return NO_TOKEN_FUND but still broadcast a proof tx (0-lamport self transfer)
// - Telegram alert on NO_TOKEN_FUND (with proof) and on confirmed sell
//
// Env:
// - RPC_URL_5
// - RPC_URL_6
// - ENCRYPTED_KEY
// - KEY_PASSPHRASE_FILE (optional, default /root/.wallet_pass)
// - DRY_RUN=true|false
// - SELL_SLIPPAGE_PCT (default 10)
// - SELL_PRIORITY_FEE (default 0.00001)
// - SELL_POOL (default "pump")
// - COMMITMENT (default "confirmed")
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID
// Optional tuning:
// - RPC_INTERVAL_CAP (default 8)
// - RPC_INTERVAL_MS (default 1000)

import fs from "fs";
import crypto from "crypto";
import bs58 from "bs58";
import dotenv from "dotenv";
import fetch from "node-fetch";
import PQueue from "p-queue";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";

import { getAssociatedTokenAddress } from "@solana/spl-token";

dotenv.config();

// ---------------- RPC FAILOVER + PQUEUE ----------------
const RPC_URL_5 = process.env.RPC_URL_5 || "";
const RPC_URL_6 = process.env.RPC_URL_6 || "";

function rpcCandidates() {
  const list = [RPC_URL_5, RPC_URL_6].filter(Boolean);
  return [...new Set(list)];
}

if (rpcCandidates().length === 0) {
  throw new Error("RPC_URL_5 or RPC_URL_6 is required");
}

const COMMITMENT = process.env.COMMITMENT || "confirmed";

let activeRpcUrl = rpcCandidates()[0];
let activeConn = new Connection(activeRpcUrl, COMMITMENT);

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
  activeConn = new Connection(activeRpcUrl, COMMITMENT);
}

async function withRpcFailover(opName, fn) {
  const urls = rpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      return await fn(activeConn);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
      continue;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed. last=${msg}`);
}

const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return q.add(() => withRpcFailover(opName, fn));
}

// ---------------- CONFIG ----------------
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const DEFAULT_SLIPPAGE_PCT = Number(process.env.SELL_SLIPPAGE_PCT || 10);
const DEFAULT_PRIORITY_FEE = Number(process.env.SELL_PRIORITY_FEE || 0.00001);
const DEFAULT_POOL = process.env.SELL_POOL || "pump";

// ---- Telegram ----
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch {}
}

// ---------------- Wallet decrypt ----------------
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
  if (!fs.existsSync(passphrasePath)) {
    throw new Error("Passphrase file missing: " + passphrasePath);
  }

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secret = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secret);
}

function mustMint(m) {
  if (!m || typeof m !== "string") throw new Error("mint is required (string)");
  const s = m.trim();
  // optional: accept "...pump" suffix
  return s.endsWith("pump") ? s.slice(0, -4) : s;
}

// ---------------- Added helpers (as you demanded) ----------------
async function getTokenUiBalance(owner, mint) {
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner);

  const bal = await rpcLimited("getTokenAccountBalance(ata)", (c) =>
    c.getTokenAccountBalance(ata)
  ).catch((e) => ({ __err: String(e?.message || e) }));

  const ui = Number(bal?.value?.uiAmount || 0);
  return {
    ui,
    ata: ata.toBase58(),
    err: bal?.__err || null,
    rpcUsed: activeRpcUrl,
  };
}

async function getSolBalance(walletPubkey) {
  const lamports = await rpcLimited("getBalance(wallet)", (c) =>
    c.getBalance(walletPubkey, COMMITMENT)
  ).catch(() => null);

  return {
    lamports,
    sol: lamports == null ? null : lamports / 1e9,
    rpcUsed: activeRpcUrl,
  };
}

// Harmless live broadcast proof (still costs fee, but proves send+confirm works)
async function broadcastProofTx(wallet) {
  const { blockhash } = await rpcLimited("getLatestBlockhash(proof)", (c) =>
    c.getLatestBlockhash(COMMITMENT)
  );

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 0,
    })
  );

  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(wallet);

  const sig = await rpcLimited("sendRawTransaction(proof)", (c) =>
    c.sendRawTransaction(tx.serialize(), { skipPreflight: false })
  );

  await rpcLimited("confirmTransaction(proof)", (c) =>
    c.confirmTransaction(sig, COMMITMENT)
  );

  return { ok: true, signature: sig, rpcUsed: activeRpcUrl };
}

// ---------------- PUBLIC API ----------------
export async function executeAutoSellPumpfun({
  mint,
  amount = "100%",
  slippagePct = DEFAULT_SLIPPAGE_PCT,
  priorityFee = DEFAULT_PRIORITY_FEE,
  pool = DEFAULT_POOL,
} = {}) {
  const m = mustMint(mint);

  // Validate mint early
  try {
    new PublicKey(m);
  } catch {
    throw new Error(`Invalid Solana mint (base58 PublicKey required): ${m}`);
  }

  const wallet = getWallet();
  const publicKey = wallet.publicKey.toBase58();

  // Always prove wallet decrypt + wallet read (inside main logic)
  const solBal = await getSolBalance(wallet.publicKey);

  // Token balance check (inside main logic)
  const tokenBal = await getTokenUiBalance(wallet.publicKey, m);

  // If no token fund: do NOT attempt sell, but DO prove live broadcast path
  if (tokenBal.ui <= 0) {
    const proof = await broadcastProofTx(wallet).catch((e) => ({
      ok: false,
      error: String(e?.message || e),
      rpcUsed: activeRpcUrl,
    }));

    await sendTelegram(
      `NO_TOKEN_FUND\nmint: ${m}\nwallet: ${publicKey}\nsol: ${solBal.sol}\nata: ${tokenBal.ata}\ntokenUi: ${tokenBal.ui}\nproofOk: ${proof.ok}\nproofSig: ${proof.signature || "null"}\nrpc: ${activeRpcUrl}`
    );

    return {
      ok: false,
      reason: "NO_TOKEN_FUND",
      mint: m,
      wallet: publicKey,
      solBalance: solBal.sol,
      tokenAta: tokenBal.ata,
      tokenUiBalance: tokenBal.ui,
      broadcastProof: proof,
      rpcUsed: activeRpcUrl,
    };
  }

  const body = {
    publicKey,
    action: "sell",
    mint: m,
    amount: String(amount),
    denominatedInSol: "false",
    slippage: Number(slippagePct),
    priorityFee: Number(priorityFee),
    pool: String(pool || "pump"),
  };

  // DRY RUN (NOTE: if DRY_RUN=true, you will NOT broadcast sell)
  if (DRY_RUN) {
    await sendTelegram(
      `DRY_RUN sell skipped\nmint: ${m}\namount: ${String(amount)}\nwallet: ${publicKey}\nsol: ${solBal.sol}\nata: ${tokenBal.ata}\npreTokenUi: ${tokenBal.ui}\npool: ${String(pool || "pump")}\nrpc: ${activeRpcUrl}`
    );

    return {
      ok: true,
      dryRun: true,
      wouldPostTo: "https://pumpportal.fun/api/trade-local",
      requestBody: body,
      wallet: publicKey,
      solBalance: solBal.sol,
      tokenAta: tokenBal.ata,
      preTokenUiBalance: tokenBal.ui,
      note: "DRY_RUN=true so no tx was requested/signed/sent",
      rpcUsed: activeRpcUrl,
    };
  }

  // 1) Request unsigned tx bytes from PumpPortal
  const resp = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    await sendTelegram(
      `SELL request failed\nmint: ${m}\nwallet: ${publicKey}\nstatus: ${resp.status}\nmsg: ${txt || resp.statusText}\nrpc: ${activeRpcUrl}`
    );
    throw new Error(`trade-local failed ${resp.status}: ${txt || resp.statusText}`);
  }

  const buf = await resp.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(buf));

  // 2) Sign locally (only when token exists)
  tx.sign([wallet]);

  // 3) Send via RPC with PQueue + failover
  const sig = await rpcLimited("sendTransaction", (c) =>
    c.sendTransaction(tx, { skipPreflight: false })
  );

  await rpcLimited("confirmTransaction", (c) =>
    c.confirmTransaction(sig, COMMITMENT)
  );

  await sendTelegram(
    `SELL CONFIRMED\nmint: ${m}\namount: ${String(amount)}\nwallet: ${publicKey}\nsol: ${solBal.sol}\nata: ${tokenBal.ata}\npreTokenUi: ${tokenBal.ui}\npool: ${String(pool)}\nslippage%: ${Number(slippagePct)}\npriorityFee: ${Number(priorityFee)}\nrpc: ${activeRpcUrl}\nsig: ${sig}`
  );

  return {
    ok: true,
    dryRun: false,
    signature: sig,
    mint: m,
    soldAmount: String(amount),
    slippagePct: Number(slippagePct),
    priorityFee: Number(priorityFee),
    pool: String(pool),
    wallet: publicKey,
    solBalance: solBal.sol,
    tokenAta: tokenBal.ata,
    preTokenUiBalance: tokenBal.ui,
    rpcUsed: activeRpcUrl,
  };
}
