// autoSell_pumpfun.js (ESM)
// Jupiter sell executor with:
// - RPC failover (RPC_URL_5 -> RPC_URL_6)
// - PQueue rate limiting
// - Wallet decrypt
// - SOL + token balance check (Token-2022 aware)
// - If token balance is 0: returns NO_TOKEN_FUND + broadcasts proof tx (0-lamport self transfer)
// - Telegram alert on NO_TOKEN_FUND and on confirmed sell
//
// Required env:
// RPC_URL_5, RPC_URL_6 (at least one)
// ENCRYPTED_KEY
// KEY_PASSPHRASE_FILE (optional, default /root/.wallet_pass)
// DRY_RUN=true|false
// SELL_SLIPPAGE_PCT (default 10)
// SELL_PRIORITY_FEE (default 0.00001)
// COMMITMENT (default confirmed)
// TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional)
//
// Optional tuning:
// RPC_CONCURRENCY, RPC_INTERVAL_CAP, RPC_INTERVAL_MS
// JUP_CONCURRENCY, JUP_QUOTE_INTERVAL_CAP, JUP_QUOTE_INTERVAL_MS
// JUP_QUOTE_BASE (default https://api.jup.ag)
// WSOL_MINT (default So111...12)

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

// Function to validate public key format
function isValidBase58(str) {
  try {
    bs58.decode(str);  // Attempt to decode the public key
    return true;
  } catch (e) {
    return false;
  }
}

// Function to validate and return the PublicKey object
function validatePublicKey(input) {
  const publicKeyString = input.trim();
  if (!isValidBase58(publicKeyString)) {
    throw new Error("Invalid public key format");
  }
  try {
    return new PublicKey(publicKeyString);  // Create and return PublicKey
  } catch (error) {
    throw new Error("Invalid public key input");
  }
}

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

const rpcQueue = new PQueue({
  concurrency: Number(process.env.RPC_CONCURRENCY || 4),
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

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

function lamportsFromSol(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 1e9);
}

function pctToBps(slippagePct) {
  const pct = Number(slippagePct);
  if (!Number.isFinite(pct) || pct <= 0) return 50;
  return Math.max(1, Math.floor(pct * 100));
}

// ---------------- TOKEN BALANCE (Token-2022 aware) ----------------
async function getTokenBalanceAnyProgram(conn, ownerPubkey, mintPubkey) {
  const mintStr = mintPubkey.toBase58();

  const t22 = await conn.getParsedTokenAccountsByOwner(ownerPubkey, { programId: TOKEN_2022_PROGRAM_ID });
  for (const v of t22.value) {
    const info = v.account.data.parsed.info;
    if (info.mint === mintStr) {
      const ta = info.tokenAmount;
      return {
        program: "token2022",
        ata: v.pubkey.toBase58(),
        rawAmount: String(ta.amount || "0"),
        uiAmountString: String(ta.uiAmountString ?? ta.uiAmount ?? "0"),
        decimals: Number(ta.decimals),
      };
    }
  }

  const spl = await conn.getParsedTokenAccountsByOwner(ownerPubkey, { programId: TOKEN_PROGRAM_ID });
  for (const v of spl.value) {
    const info = v.account.data.parsed.info;
    if (info.mint === mintStr) {
      const ta = info.tokenAmount;
      return {
        program: "spl",
        ata: v.pubkey.toBase58(),
        rawAmount: String(ta.amount || "0"),
        uiAmountString: String(ta.uiAmountString ?? ta.uiAmount ?? "0"),
        decimals: Number(ta.decimals),
      };
    }
  }

  return null;
}

async function getSolBalance(ownerPubkey) {
  const lamports = await rpcLimited("getBalance", (c) => c.getBalance(ownerPubkey));
  return { lamports, sol: lamports / 1e9 };
}

function resolveSellRawAmount(amount, tokenBal) {
  const rawBal = BigInt(tokenBal.rawAmount || "0");
  const amt = String(amount).trim();

  if (amt.endsWith("%")) {
    const p = Number(amt.slice(0, -1));
    if (!Number.isFinite(p) || p <= 0) return 0n;
    if (p >= 100) return rawBal;
    return (rawBal * BigInt(Math.floor(p * 1000))) / 100000n;
  }

  const ui = Number(amt);
  if (!Number.isFinite(ui) || ui <= 0) return 0n;
  if (!Number.isFinite(tokenBal.decimals)) throw new Error("Token decimals unavailable; cannot convert UI to raw.");

  const scale = 10n ** BigInt(tokenBal.decimals);
  const [whole, frac = ""] = amt.split(".");
  const fracPadded = (frac + "0".repeat(tokenBal.decimals)).slice(0, tokenBal.decimals);
  return BigInt(whole || "0") * scale + BigInt(fracPadded || "0");
}

// ---------------- JUPITER WRAPPERS ----------------
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

async function jupBuildSwapTx({ quoteResponse, userPublicKey, prioritizationFeeLamports = 0 }) {
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
export async function executeAutoSellPumpfun({
  mint,
  amount = "100%",
  slippagePct = DEFAULT_SLIPPAGE_PCT,
  priorityFee = DEFAULT_PRIORITY_FEE,
} = {}) {
  const m = resolveMintStrict(mint);
  const mintPk = new PublicKey(m);

  const wallet = getWallet();
  const publicKey = wallet.publicKey.toBase58();

  const solBal = await getSolBalance(wallet.publicKey);

  const tokenBal = await rpcLimited("getTokenBalanceAnyProgram", async (conn) => {
    return await getTokenBalanceAnyProgram(conn, wallet.publicKey, mintPk);
  });

  const tokenUiNum = tokenBal ? Number(tokenBal.uiAmountString || "0") : 0;
  const tokenRawBig = tokenBal ? BigInt(tokenBal.rawAmount || "0") : 0n;

  // ---------------- NO TOKEN ----------------
  if (!tokenBal || tokenRawBig <= 0n || tokenUiNum <= 0) {
    const proof = await broadcastProofTx(wallet).catch((e) => ({
      ok: false,
      error: String(e?.message || e),
    }));

    await sendTelegram(
      `NO_TOKEN_FUND\nmint: ${m}\nwallet: ${publicKey}\nsol: ${solBal.sol}\nprogram: ${tokenBal?.program || "none"}\nata: ${tokenBal?.ata || "none"}\ntokenUi: ${tokenBal?.uiAmountString || "0"}\ntokenRaw: ${tokenBal?.rawAmount || "0"}\nproofOk: ${proof.ok}\nproofSig: ${proof.signature || "null"}`
    );

    return {
      ok: false,
      reason: "NO_TOKEN_FUND",
      mint: m,
      wallet: publicKey,
      solBalance: solBal.sol,
      tokenProgram: tokenBal?.program || null,
      tokenAta: tokenBal?.ata || null,
      tokenUiBalance: tokenBal?.uiAmountString ? Number(tokenBal.uiAmountString) : 0,
      tokenRawBalance: tokenBal?.rawAmount || "0",
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
      tokenProgram: tokenBal.program,
      tokenAta: tokenBal.ata,
      tokenUiBalance: Number(tokenBal.uiAmountString || "0"),
      tokenRawBalance: tokenBal.rawAmount,
      note: `Could not resolve sell amount from: ${String(amount)}`,
    };
  }

  const slippageBps = pctToBps(slippagePct);
  const prioLamports = lamportsFromSol(priorityFee);

  // ---------------- DRY RUN ----------------
  if (DRY_RUN) {
    await sendTelegram(
      `DRY_RUN sell skipped (Jupiter)\nmint: ${m}\namount: ${String(amount)}\nraw: ${sellRaw}\nwallet: ${publicKey}\nsol: ${solBal.sol}\nprogram: ${tokenBal.program}\nata: ${tokenBal.ata}\npreTokenUi: ${tokenBal.uiAmountString}\nslippageBps: ${slippageBps}\nprioLamports: ${prioLamports}`
    );

    return {
      ok: true,
      dryRun: true,
      wallet: publicKey,
      solBalance: solBal.sol,
      tokenProgram: tokenBal.program,
      tokenAta: tokenBal.ata,
      preTokenUiBalance: Number(tokenBal.uiAmountString || "0"),
      preTokenRawBalance: tokenBal.rawAmount,
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
      `SELL build failed (Jupiter)\nmint: ${m}\nwallet: ${publicKey}\nraw: ${sellRaw}\nslippageBps: ${slippageBps}\nprioLamports: ${prioLamports}\nresp: ${JSON.stringify(swapResp).slice(0, 1200)}`
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

  await rpcLimited("confirmTransaction(jup)", (c) => c.confirmTransaction(sig, COMMITMENT));

  await sendTelegram(
    `SELL CONFIRMED (Jupiter)\nmint: ${m}\nwallet: ${publicKey}\nprogram: ${tokenBal.program}\nata: ${tokenBal.ata}\nrawBal: ${tokenBal.rawAmount}\nsellRaw: ${sellRaw.toString()}\nuiBal: ${tokenBal.uiAmountString}\namount: ${String(amount)}\nslippageBps: ${slippageBps}\nprioLamports: ${prioLamports}\nsol: ${solBal.sol}\nsig: ${sig}`
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
    tokenProgram: tokenBal.program,
    tokenAta: tokenBal.ata,
    preTokenUiBalance: Number(tokenBal.uiAmountString || "0"),
    preTokenRawBalance: tokenBal.rawAmount,
    jup: {
      quoteOutAmount: quote?.outAmount,
      priceImpactPct: quote?.priceImpactPct,
      routePlanLen: Array.isArray(quote?.routePlan) ? quote.routePlan.length : null,
    },
  };
}