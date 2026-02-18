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
const COMMITMENT = process.env.COMMITMENT || "confirmed";

const RPC_CANDIDATES = [...new Set([RPC_URL_5, RPC_URL_6].filter(Boolean))];
if (RPC_CANDIDATES.length === 0) throw new Error("RPC_URL_5 or RPC_URL_6 is required");

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
      const res = await fn(conn, url);
      return res;
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed. last=${msg}`);
}

const q = new PQueue({
  concurrency: Number(process.env.RPC_CONCURRENCY || 4),
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return q.add(() => withRpcFailover(opName, fn));
}

function isRetryableJupError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("jup_http_429") ||
    msg.includes("http_429") ||
    msg.includes("rate") ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("service unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("gateway")
  );
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withJupRetry(opName, fn, { retries = 4, baseMs = 350 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryableJupError(e) || i === retries) break;

      const jitter = Math.floor(Math.random() * 150);
      const backoff = baseMs * Math.pow(2, i) + jitter;
      await sleep(backoff);
    }
  }
  throw new Error(`[JUP_RETRY] ${opName} failed: ${String(lastErr?.message || lastErr)}`);
}


// must exist above:
const jupQueue = new PQueue({
  concurrency: Number(process.env.JUP_CONCURRENCY || 4),
  intervalCap: Number(process.env.JUP_QUOTE_INTERVAL_CAP || 6),
  interval: Number(process.env.JUP_QUOTE_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function jupLimited(opName, fn) {
  return jupQueue.add(() => withJupRetry(opName, fn));
}



// Jupiter API base URL
const JUP_SWAP_BASE =
  process.env.JUP_QUOTE_BASE?.trim() || "https://api.jup.ag";

// Wrapped SOL mint address (used as output token for sells)
const WSOL_MINT =
  process.env.WSOL_MINT?.trim() ||
  "So11111111111111111111111111111111111111112";


// ---------------- CONFIG ----------------
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const DEFAULT_SLIPPAGE_PCT = Number(process.env.SELL_SLIPPAGE_PCT || 10);
const DEFAULT_PRIORITY_FEE = Number(process.env.SELL_PRIORITY_FEE || 0.00001);


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

// Convert priority fee in SOL to lamports (uint64)
function lamportsFromSol(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 1e9);
}

function pctToBps(slippagePct) {
  const pct = Number(slippagePct);
  if (!Number.isFinite(pct) || pct <= 0) return 50; // fallback 0.50%
  return Math.max(1, Math.floor(pct * 100)); // 1% => 100 bps
}

// ===== Replace your getTokenUiBalance with raw+decimals (keep ui too) =====
async function getTokenBalanceDetails(owner, mint) {
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner);

  const out = await rpcLimited("getTokenAccountBalance(ata)", async (c, url) => {
    const res = await c.getTokenAccountBalance(ata);
    return { res, rpcUsed: url };
  }).catch((e) => ({ __err: String(e?.message || e), res: null, rpcUsed: null }));

  const res = out?.res;
  const ui = Number(res?.value?.uiAmount || 0);
  const rawAmount = res?.value?.amount ? String(res.value.amount) : "0";
  const decimals = Number.isFinite(Number(res?.value?.decimals)) ? Number(res.value.decimals) : null;

  return {
    ui,
    rawAmount,
    decimals,
    ata: ata.toBase58(),
    err: out?.__err || null,
    rpcUsed: out?.rpcUsed || null,
  };
}

// Decide how much to sell in raw units.
// - "100%" => full raw balance
// - "25%"  => percent of raw balance
// - "123.45" => UI units, converted using decimals
function resolveSellRawAmount(amount, tokenBal) {
  const rawBal = BigInt(tokenBal.rawAmount || "0");
  const amt = String(amount).trim();

  if (amt.endsWith("%")) {
    const p = Number(amt.slice(0, -1));
    if (!Number.isFinite(p) || p <= 0) return 0n;
    if (p >= 100) return rawBal;
    // floor
    return (rawBal * BigInt(Math.floor(p * 1000))) / 100000n; // 3dp percent precision
  }

  // numeric UI amount
  const ui = Number(amt);
  if (!Number.isFinite(ui) || ui <= 0) return 0n;
  if (!Number.isFinite(tokenBal.decimals)) {
    throw new Error("Token decimals unavailable; cannot convert UI amount to raw.");
  }
  const scale = 10n ** BigInt(tokenBal.decimals);
  // avoid float rounding surprises: parse as string
  const [whole, frac = ""] = amt.split(".");
  const fracPadded = (frac + "0".repeat(tokenBal.decimals)).slice(0, tokenBal.decimals);
  return BigInt(whole || "0") * scale + BigInt(fracPadded || "0");
}

// ===== Jupiter HTTP helpers (use your existing fetchJupJson + jupQueue) =====




async function jupGetQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
  const url =
    `${JUP_SWAP_BASE}/swap/v1/quote` +
    `?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}` +
    `&amount=${encodeURIComponent(String(amountRaw))}` +
    `&slippageBps=${encodeURIComponent(String(slippageBps))}` +
    `&swapMode=ExactIn`;

  return jupLimited("quote", () => fetchJupJson(url));
}

async function jupBuildSwapTx({
  quoteResponse,
  userPublicKey,
  prioritizationFeeLamports = 0,
}) {
  const url = `${JUP_SWAP_BASE}/swap/v1/swap`;
  const body = {
    userPublicKey,
    quoteResponse,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: Number(prioritizationFeeLamports || 0),
  };

  return jupLimited("swap", () => fetchJupJson(url, body));
}


// ---------------- PUBLIC API ----------------
// ===== Then modify executeAutoSellPumpfun =====

export async function executeAutoSellPumpfun({
  mint,
  amount = "100%",
  slippagePct = DEFAULT_SLIPPAGE_PCT,
  priorityFee = DEFAULT_PRIORITY_FEE,
} = {}) {
  const m = mustMint(mint);

  try {
    new PublicKey(m);
  } catch {
    throw new Error(`Invalid Solana mint (base58 PublicKey required): ${m}`);
  }

  const wallet = getWallet();
  const publicKey = wallet.publicKey.toBase58();

  const solBal = await getSolBalance(wallet.publicKey);
  const tokenBal = await getTokenBalanceDetails(wallet.publicKey, m);

  // ---------------- NO TOKEN ----------------
  if (tokenBal.ui <= 0 || BigInt(tokenBal.rawAmount || "0") <= 0n) {
    const proof = await broadcastProofTx(wallet).catch((e) => ({
      ok: false,
      error: String(e?.message || e),
    }));

    await sendTelegram(
      `NO_TOKEN_FUND\nmint: ${m}\nwallet: ${publicKey}\nsol: ${solBal.sol}\nata: ${tokenBal.ata}\ntokenUi: ${tokenBal.ui}\nproofOk: ${proof.ok}\nproofSig: ${proof.signature || "null"}`
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
    };
  }

  // ---------------- AMOUNT ----------------
  const sellRaw = resolveSellRawAmount(amount, tokenBal);

  if (sellRaw <= 0n) {
    return {
      ok: false,
      reason: "INVALID_AMOUNT",
      mint: m,
      wallet: publicKey,
      tokenAta: tokenBal.ata,
      tokenUiBalance: tokenBal.ui,
      tokenRawBalance: tokenBal.rawAmount,
      note: `Could not resolve sell amount from: ${String(amount)}`,
    };
  }

  const slippageBps = pctToBps(slippagePct);
  const prioLamports = lamportsFromSol(priorityFee);

  // ---------------- DRY RUN ----------------
  if (DRY_RUN) {
    await sendTelegram(
      `DRY_RUN sell skipped (Jupiter)\nmint: ${m}\namount: ${String(amount)}\nraw: ${sellRaw}\nwallet: ${publicKey}\nsol: ${solBal.sol}\nata: ${tokenBal.ata}\npreTokenUi: ${tokenBal.ui}\nslippageBps: ${slippageBps}\nprioLamports: ${prioLamports}`
    );

    return {
      ok: true,
      dryRun: true,
      wouldGetQuote: `${JUP_SWAP_BASE}/swap/v1/quote`,
      wouldSwap: `${JUP_SWAP_BASE}/swap/v1/swap`,
      quoteParams: {
        inputMint: m,
        outputMint: WSOL_MINT,
        amount: String(sellRaw),
        slippageBps,
        swapMode: "ExactIn",
      },
      swapParams: {
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: prioLamports,
      },
      wallet: publicKey,
      solBalance: solBal.sol,
      tokenAta: tokenBal.ata,
      preTokenUiBalance: tokenBal.ui,
      preTokenRawBalance: tokenBal.rawAmount,
    };
  }

  // ---------------- JUPITER QUOTE ----------------
  const quote = await jupGetQuote({
    inputMint: m,
    outputMint: WSOL_MINT,
    amountRaw: sellRaw.toString(),
    slippageBps,
  });

  // ---------------- BUILD TX ----------------
  const swapResp = await jupBuildSwapTx({
    quoteResponse: quote,
    userPublicKey: publicKey,
    prioritizationFeeLamports: prioLamports,
  });

  if (!swapResp?.swapTransaction) {
    await sendTelegram(
      `SELL build failed (Jupiter)\I: ${m}\nwallet: ${publicKey}\nraw: ${sellRaw}\nslippageBps: ${slippageBps}\nprioLamports: ${prioLamports}\nresp: ${JSON.stringify(swapResp).slice(0, 1200)}`
    );
    throw new Error("Jupiter /swap did not return swapTransaction");
  }

  // ---------------- SIGN + SEND ----------------
  const txBuf = Buffer.from(swapResp.swapTransaction, "base64");
  const vtx = VersionedTransaction.deserialize(txBuf);
  vtx.sign([wallet]);

  const sig = await rpcLimited("sendRawTransaction(jup)", (c) =>
    c.sendRawTransaction(Buffer.from(vtx.serialize()), { skipPreflight: false })
  );

  await rpcLimited("confirmTransaction(jup)", (c) =>
    c.confirmTransaction(sig, COMMITMENT)
  );

  await sendTelegram(
  `SELL CONFIRMED (Jupiter)

SELL_DEBUG
mint: ${m}
wallet: ${publicKey}

rawBal: ${tokenBal.rawAmount}
sellRaw: ${sellRaw.toString()}
uiBal: ${tokenBal.ui}

amount: ${String(amount)}
slippageBps: ${slippageBps}
prioLamports: ${prioLamports}

sol: ${solBal.sol}
ata: ${tokenBal.ata}

sig: ${sig}`
);

  return {
    ok: true,
    dryRun: false,
    signature: sig,
    mint: m,
    soldAmount: String(amount),
    soldRawAmount: sellRaw.toString(),
    slippageBps,
    prioritizationFeeLamports: prioLamports,
    wallet: publicKey,
    solBalance: solBal.sol,
    tokenAta: tokenBal.ata,
    preTokenUiBalance: tokenBal.ui,
    preTokenRawBalance: tokenBal.rawAmount,
    jup: {
      quoteOutAmount: quote?.outAmount,
      priceImpactPct: quote?.priceImpactPct,
      routePlanLen: Array.isArray(quote?.routePlan)
        ? quote.routePlan.length
        : null,
    },
  };
}