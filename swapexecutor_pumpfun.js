// swapexecutor_pumpfun.js (ESM)
// Adds ONLY:
// - RPC failover: SIGNER_URL_1 -> SIGNER_URL_2
// - PQueue rate limiting to prevent bursts / 429
// Does NOT change your buy logic.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import bs58 from "bs58";

import anchorPkg from "@coral-xyz/anchor";
const { BN, AnchorProvider, Program } = anchorPkg;
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
  Connection,
  Keypair,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import PQueue from "p-queue";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";

dotenv.config();

// ---------------- CONFIG ----------------
const COMMITMENT = process.env.COMMITMENT || "confirmed";

// ONLY these 2, as you ordered
const SIGNER_URL_1 = process.env.SIGNER_URL_1 || "";
const SIGNER_URL_2 = process.env.SIGNER_URL_2 || "";

function pickRpcCandidates() {
  const list = [SIGNER_URL_1, SIGNER_URL_2].filter(Boolean);
  return [...new Set(list)];
}

const candidates = pickRpcCandidates();
if (candidates.length === 0) {
  throw new Error("❌ Missing SIGNER_URL_1 / SIGNER_URL_2 in env");
}

let activeRpcUrl = candidates[0];
let conn = new Connection(activeRpcUrl, COMMITMENT);

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
  conn = new Connection(activeRpcUrl, COMMITMENT);
}

async function withRpcFailover(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      return await fn(conn);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
      continue;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed on all RPCs. last=${msg}`);
}

// ---------------- PQUEUE RATE LIMITER ----------------
const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return rpcQueue.add(() => withRpcFailover(opName, fn));
}

// ---------------- PROGRAM IDS ----------------
const DEFAULT_PUMP_PROGRAM_ID = new PublicKey(
  process.env.PUMPFUN_PROGRAM_ID || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const PUMPFUN_IDL_PATH = process.env.PUMPFUN_IDL_PATH
  ? path.resolve(process.cwd(), process.env.PUMPFUN_IDL_PATH)
  : null;

const ACTIVE_POSITIONS_FILE = path.resolve(process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json");

const MAX_ENTRY = Number(process.env.MAX_ENTRY || 1);
const DRY_RUN = String(process.env.DRY_RUN || "true") === "true";

const INPUT_SOL = Number(process.env.BUY_INPUT_SOL || 0.05);
const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 150);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -------------------- TELEGRAM --------------------
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

// -------------------- WATCHER --------------------
let watcherActive = true;
export async function startWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 Liquidity Watcher Started");
}
export async function stopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 Liquidity Watcher Stopped");
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
  if (!encrypted) throw new Error("❌ ENCRYPTED_KEY missing in .env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("❌ Passphrase file missing.");

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

// ---------------- file helpers ----------------
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadActivePositions() {
  const arr = safeReadJson(ACTIVE_POSITIONS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function addActivePosition(entry) {
  const arr = loadActivePositions();
  arr.push(entry);
  atomicWrite(ACTIVE_POSITIONS_FILE, arr);
  return arr.length;
}

// ---------------- max positions guard ----------------
export async function resumeWatcherIfBelowMax() {
  const active = loadActivePositions();
  if (active.length >= MAX_ENTRY) {
    await stopWatcher();
    return { ok: false, reason: "max_entry_reached", count: active.length };
  }
  await startWatcher();
  return { ok: true, count: active.length };
}

// ---------------- helpers ----------------
function mustLoadIdl() {
  if (!PUMPFUN_IDL_PATH) {
    throw new Error("PUMPFUN_IDL_PATH missing. Example: PUMPFUN_IDL_PATH=./idl/pumpfun.json");
  }
  if (!fs.existsSync(PUMPFUN_IDL_PATH)) {
    throw new Error(`Pump.fun IDL file not found at: ${PUMPFUN_IDL_PATH}`);
  }
  const raw = fs.readFileSync(PUMPFUN_IDL_PATH, "utf8");
  return JSON.parse(raw);
}

function u64Bn(n) {
  const x = typeof n === "string" ? Number(n) : Number(n);
  if (!Number.isFinite(x) || x < 0) throw new Error("Invalid u64 input");
  return new BN(Math.floor(x));
}

function lamportsFromSol(sol) {
  const s = Number(sol);
  if (!Number.isFinite(s) || s <= 0) throw new Error("inputSol must be > 0");
  return Math.floor(s * 1e9);
}

async function ensureAtaIx(owner, mint) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const info = await rpcLimited("getAccountInfo(ata)", (c) =>
    c.getAccountInfo(ata, COMMITMENT)
  ).catch(() => null);

  if (info) return { ata, ix: null };

  const ix = createAssociatedTokenAccountInstruction(
    owner,
    ata,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return { ata, ix };
}

async function getMintDecimals(mint) {
  const info = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mint, COMMITMENT)
  ).catch(() => null);

  const dec = info?.value?.data?.parsed?.info?.decimals;
  if (typeof dec === "number") return dec;
  return 6;
}

function deriveGlobalPda() {
  if (process.env.PUMPFUN_GLOBAL_PDA) return new PublicKey(process.env.PUMPFUN_GLOBAL_PDA);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("global")], DEFAULT_PUMP_PROGRAM_ID);
  return pda;
}

function deriveEventAuthorityPda() {
  if (process.env.PUMPFUN_EVENT_AUTHORITY) return new PublicKey(process.env.PUMPFUN_EVENT_AUTHORITY);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("event_authority")], DEFAULT_PUMP_PROGRAM_ID);
  return pda;
}

function deriveBondingCurvePda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    DEFAULT_PUMP_PROGRAM_ID
  );
  return pda;
}

// ---------------- MAIN EXECUTOR ----------------
export async function executePumpfunBuyFromBonding({
  candidate,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
} = {}) {
  if (!candidate?.mint) throw new Error("candidate.mint missing");

  const gate = await resumeWatcherIfBelowMax();
  if (!gate.ok) {
    return { signature: null, ok: false, reason: gate.reason, activeCount: gate.count };
  }

  const wallet = getWallet();
  const user = wallet.publicKey;

  const inputSol = INPUT_SOL;
  const lamportsIn = lamportsFromSol(inputSol);

  const priceRes = await getPumpFunPriceOnce(candidate);
  const priceSOL = Number(priceRes?.priceSOL);

  if (!Number.isFinite(priceSOL) || priceSOL <= 0) {
    console.log("[PRICE_FAIL]", { mint: candidate.mint, priceRes });
    return { signature: null, ok: false, reason: `price_unavailable:${priceRes?.error || "unknown"}` };
  }

  if (DRY_RUN) {
    const count = addActivePosition({
      buyLabel: `Buy ${loadActivePositions().length + 1}`,
      mint: candidate.mint,
      bondingCurve: candidate.bondingCurve || null,
      buyPriceSOL: Number(priceSOL),
      inputSol: Number(inputSol),
      signature: "DRY_RUN",
      walletAddress: user.toBase58(),
      openedAt: new Date().toISOString(),
      dryRun: true,
    });

    if (count >= MAX_ENTRY) await stopWatcher();

    return {
      signature: "DRY_RUN",
      ok: true,
      dryRun: true,
      buyPriceSOL: Number(priceSOL),
      inputSol: Number(inputSol),
      rpcUsed: activeRpcUrl,
    };
  }

  const idl = mustLoadIdl();

  const provider = new AnchorProvider(
    conn,
    {
      publicKey: user,
      signTransaction: async (tx) => {
        tx.partialSign(wallet);
        return tx;
      },
      signAllTransactions: async (txs) => {
        for (const t of txs) t.partialSign(wallet);
        return txs;
      },
    },
    { commitment: COMMITMENT }
  );

  const program = new Program(idl, DEFAULT_PUMP_PROGRAM_ID, provider);

  const mint = new PublicKey(candidate.mint);

  const bondingCurve = candidate?.bondingCurve
    ? new PublicKey(candidate.bondingCurve)
    : deriveBondingCurvePda(mint);

  const bondingCurveTokenAccount = await getAssociatedTokenAddress(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { ata: userTokenAta, ix: createUserAtaIx } = await ensureAtaIx(user, mint);

  const decimals = await getMintDecimals(mint);

  const estTokenOutUi = Number(inputSol) / Number(priceSOL);
  const estTokenOutRaw = Math.floor(estTokenOutUi * Math.pow(10, decimals));
  if (!Number.isFinite(estTokenOutRaw) || estTokenOutRaw <= 0) {
    return { signature: null, ok: false, reason: "estimated_token_out_invalid" };
  }

  const minOutRaw = Math.floor(estTokenOutRaw * (1 - Number(slippageBps) / 10_000));
  if (minOutRaw <= 0) return { signature: null, ok: false, reason: "min_out_too_low" };

  const maxSolLamports = Math.floor(lamportsIn * (1 + Number(slippageBps) / 10_000));

  const global = deriveGlobalPda();
  const eventAuthority = deriveEventAuthorityPda();

  const feeRecipient = process.env.PUMPFUN_FEE_RECIPIENT
    ? new PublicKey(process.env.PUMPFUN_FEE_RECIPIENT)
    : null;

  const tx = new Transaction();

  try {
    const cuLimit = Number(process.env.PUMPFUN_CU_LIMIT || 250000);
    const microLamports = Number(process.env.PUMPFUN_CU_PRICE_MICROLAMPORTS || 0);
    if (cuLimit > 0) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (microLamports > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  } catch {}

  if (createUserAtaIx) tx.add(createUserAtaIx);

  const METHOD_NAME = "buy";

  const accounts = {
    global,
    feeRecipient: feeRecipient || global,
    mint,
    bondingCurve,
    bondingCurveTokenAccount,
    userTokenAccount: userTokenAta,
    user,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    rent: SYSVAR_RENT_PUBKEY,
    eventAuthority,
    program: DEFAULT_PUMP_PROGRAM_ID,
  };
  if (!process.env.PUMPFUN_FEE_RECIPIENT) delete accounts.feeRecipient;

  const ix = await program.methods[METHOD_NAME](u64Bn(minOutRaw), u64Bn(maxSolLamports))
    .accounts(accounts)
    .instruction();

  tx.add(ix);

  tx.feePayer = user;

  const latest = await rpcLimited("getLatestBlockhash", (c) =>
    c.getLatestBlockhash(COMMITMENT)
  );
  tx.recentBlockhash = latest.blockhash;

  tx.sign(wallet);

  let signature;
  try {
    signature = await rpcLimited("sendRawTransaction", (c) =>
      c.sendRawTransaction(tx.serialize(), { skipPreflight: false })
    );

    await rpcLimited("confirmTransaction", (c) =>
      c.confirmTransaction(signature, COMMITMENT)
    );
  } catch (e) {
    return { signature: null, ok: false, reason: `send_failed:${e?.message || e}`, rpcUsed: activeRpcUrl };
  }

  const count = addActivePosition({
    buyLabel: `Buy ${loadActivePositions().length + 1}`,
    mint: candidate.mint,
    bondingCurve: candidate.bondingCurve || bondingCurve.toBase58(),
    buyPriceSOL: Number(priceSOL),
    priceSource: priceRes?.source || "unknown",
    inputSol: Number(inputSol),
    signature,
    walletAddress: user.toBase58(),
    openedAt: new Date().toISOString(),
    dryRun: false,
  });

  if (count >= MAX_ENTRY) await stopWatcher();

  return {
    signature,
    ok: true,
    buyPriceSOL: Number(priceSOL),
    inputSol: Number(inputSol),
    minOutRaw: String(minOutRaw),
    maxSolLamports: String(maxSolLamports),
    rpcUsed: activeRpcUrl,
  };
}