import "dotenv/config";
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import PQueue from "p-queue";
import { resolveMintOnChain } from "./mint_resolver.js";

// ---------------- RPC FAILOVER ----------------
const RPC_ENDPOINTS = [process.env.RPC_URL_11, process.env.RPC_URL_12].filter(Boolean);
if (!RPC_ENDPOINTS.length) throw new Error("No RPC endpoints found. Set RPC_URL_11/RPC_URL_12");

const COMMITMENT = "confirmed";
const CONNECTIONS = RPC_ENDPOINTS.map((url) => new Connection(url, COMMITMENT));
let rpcIndex = 0;

function isRateLimitError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("fetch failed") ||
    msg.includes("node is behind") ||
    msg.includes("overloaded") ||
    msg.includes("service unavailable")
  );
}

const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 12),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

async function withRpcFailover(opName, fn) {
  const attempts = CONNECTIONS.length;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const idx = (rpcIndex + i) % CONNECTIONS.length;
    const c = CONNECTIONS[idx];
    try {
      const res = await fn(c);
      rpcIndex = idx;
      return res;
    } catch (e) {
      lastErr = e;
      if (isRateLimitError(e)) continue;
      continue;
    }
  }

  throw new Error(`[RPC_FAILOVER:${opName}] ${String(lastErr?.message || lastErr)}`);
}

const rpcLimited = (opName, fn) => q.add(() => withRpcFailover(opName, fn));

// ---------------- Pump.fun program ----------------
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// ---------------- Blacklist config ----------------
const BLACKLIST_FILE = path.resolve(process.cwd(), "blacklist.json");
const MIN_CREATOR_SCORE = 65;
const AUTO_BLACKLIST_THRESHOLD = 30;
const CREATOR_UNKNOWN_PENALTY = Number(process.env.CREATOR_UNKNOWN_PENALTY || 25);

// ---------------- Dev thresholds ----------------
const DEV_MIN_AGE_DAYS = Number(process.env.DEV_MIN_AGE_DAYS || 7);
const DEV_MIN_TXS = Number(process.env.DEV_MIN_TXS || 5);

// ---------------- File helpers ----------------
function loadBlacklist() {
  try {
    const j = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
    const wallets = Array.isArray(j?.wallets) ? j.wallets : [];
    return new Set(wallets);
  } catch {
    return new Set();
  }
}

function saveBlacklist(set) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify({ wallets: [...set] }, null, 2));
}

// ---------------- Token-2022 detection ----------------
async function detectTokenProgramOwner(mintPub) {
  const acc = await rpcLimited("getAccountInfo(mint)", (c) => c.getAccountInfo(mintPub)).catch(() => null);
  const owner = acc?.owner?.toBase58?.() || null;

  if (!owner) return { ok: false, owner: null, isToken2022: false, isTokenProgram: false };

  const isToken2022 = owner === TOKEN_2022_PROGRAM_ID.toBase58();
  const isTokenProgram = owner === TOKEN_PROGRAM_ID.toBase58();

  return { ok: true, owner, isToken2022, isTokenProgram };
}

// ---------------- FAST creator derivation (Pump-only, no false negatives) ----------------
async function derivePumpfunCreatorFast(mintPub) {
  const sigInfos = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
    c.getSignaturesForAddress(mintPub, { limit: 25 })
  ).catch(() => []);

  if (!sigInfos.length) return { creator: null, signature: null, scanned: 0, sawPump: false };

  let scanned = 0;
  let sawPump = false;

  for (const s of sigInfos) {
    const sig = s?.signature;
    if (!sig) continue;
    scanned++;

    const tx = await rpcLimited("getTransaction(sig)", (c) =>
      c.getTransaction(sig, { commitment: COMMITMENT, maxSupportedTransactionVersion: 1 })
    ).catch(() => null);

    if (!tx?.transaction?.message) continue;

    const msg = tx.transaction.message;

    const keys = msg.accountKeys.map((k) => (k?.toBase58 ? k.toBase58() : String(k)));
    const pump = PUMP_PROGRAM_ID.toBase58();

    const ix = Array.isArray(msg.instructions) ? msg.instructions : [];
    const touchesPump = ix.some((i) => keys[i.programIdIndex] === pump);

    if (!touchesPump) continue;

    sawPump = true;

    const payer = keys[0] || null;
    return { creator: payer, signature: sig, scanned, sawPump: true };
  }

  return { creator: null, signature: null, scanned, sawPump };
}

// ---------------- Creator wallet analysis ----------------
async function analyzeCreatorWallet(creatorAddress) {
  const reasons = [];
  let score = 100;

  let creatorPub;
  try {
    creatorPub = new PublicKey(creatorAddress);
  } catch {
    return { safe: false, score: 0, reasons: ["Invalid creator pubkey"], details: {} };
  }

  const sigInfos = await rpcLimited("getSignaturesForAddress(creator)", (c) =>
    c.getSignaturesForAddress(creatorPub, { limit: 300 })
  ).catch(() => []);

  if (!sigInfos.length) {
    return { safe: false, score: 0, reasons: ["Creator has no on-chain history"], details: { txCount: 0 } };
  }

  const earliest = sigInfos[sigInfos.length - 1];
  const earliestBlockTime = typeof earliest?.blockTime === "number" ? earliest.blockTime : null;

  const now = Math.floor(Date.now() / 1000);
  const ageDays = earliestBlockTime ? (now - earliestBlockTime) / 86400 : 0;
  const txCount = sigInfos.length;

  if (!earliestBlockTime || ageDays < DEV_MIN_AGE_DAYS) {
    score -= 80;
    reasons.push(`Creator wallet too new (${ageDays.toFixed(1)}d)`);
  } else {
    reasons.push(`Creator wallet age ${ageDays.toFixed(1)}d`);
  }

  if (txCount < DEV_MIN_TXS) {
    score -= 30;
    reasons.push(`Creator tx count low (${txCount})`);
  } else {
    reasons.push(`Creator tx count ${txCount}`);
  }

  const bal = await rpcLimited("getBalance(creator)", (c) => c.getBalance(creatorPub)).catch(() => null);
  if (typeof bal === "number") {
    const sol = bal / 1e9;
    if (sol < 0.05) {
      score -= 10;
      reasons.push(`Creator SOL balance low (${sol.toFixed(4)})`);
    } else {
      reasons.push(`Creator SOL balance ${sol.toFixed(4)}`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { safe: score >= MIN_CREATOR_SCORE, score, reasons, details: { ageDays, txCount } };
}

// ---------------- Exported API (on-chain only, no pump.fun false negatives) ----------------
export async function verifyCreatorSafetyPumpfun(mintOrRecord) {
  const reasons = [];
  let score = 100;

  // 0) Resolve any identifier to a real 32-byte mint using RPC failover
  const resolved = await rpcLimited("resolveMintOnChain", (c) =>
    resolveMintOnChain(c, mintOrRecord, COMMITMENT)
  ).catch((e) => ({ ok: false, reason: String(e?.message || e) }));

  if (!resolved?.ok || !resolved.mint) {
    return {
      safe: false,
      score: 0,
      reasons: ["Unresolved mint identifier"],
      creator: null,
      details: { input: mintOrRecord, resolver: resolved },
    };
  }

  const mintStr = String(resolved.mint);
  let mintPub;
  try {
    mintPub = new PublicKey(mintStr);
  } catch {
    return { safe: false, score: 0, reasons: ["Invalid resolved mint"], creator: null, details: { mintStr, resolver: resolved } };
  }

  // 1) Token program owner check (on-chain)
  const prog = await detectTokenProgramOwner(mintPub);

  if (!prog.ok) {
    reasons.push("mint_account_owner_unknown");
    score -= 15;
  } else if (prog.isToken2022) {
    score -= 25;
    reasons.push("token2022_detected_penalty");
  } else if (prog.isTokenProgram) {
    reasons.push("spl_token_program_ok");
  } else {
    // not SPL Token or Token-2022 mint account
    return {
      safe: false,
      score: 0,
      reasons: [`Unknown token program owner: ${prog.owner || "null"}`],
      creator: null,
      details: { mint: mintStr, tokenProgram: prog, resolver: resolved },
    };
  }

  // 2) Derive creator only if we actually see Pump program in tx history
  const derived = await derivePumpfunCreatorFast(mintPub);

  if (!derived.creator) {
    // IMPORTANT: no pump instruction found, treat as non-pump token, do not penalize as "unsafe"
    if (derived.sawPump) {
      score = Math.max(0, score - CREATOR_UNKNOWN_PENALTY);
      reasons.push("pump_creator_unknown");
    } else {
      reasons.push("non_pump_token_skip_creator_checks");
    }

    score = Math.max(0, Math.min(100, score));

    return {
      safe: score >= MIN_CREATOR_SCORE,
      score,
      reasons,
      creator: null,
      details: { mint: mintStr, resolver: resolved, derived, tokenProgram: prog },
    };
  }

  // 3) Blacklist (only applies if we have a creator)
  const blacklist = loadBlacklist();
  if (blacklist.has(derived.creator)) {
    return {
      safe: false,
      score: 0,
      reasons: ["Creator BLACKLISTED"],
      creator: derived.creator,
      details: { mint: mintStr, resolver: resolved, derived, tokenProgram: prog },
    };
  }

  // 4) Creator wallet analysis (on-chain)
  const dev = await analyzeCreatorWallet(derived.creator);
  score = Math.min(score, dev.score);
  reasons.push(...dev.reasons);

  if (score < AUTO_BLACKLIST_THRESHOLD) {
    blacklist.add(derived.creator);
    saveBlacklist(blacklist);
    reasons.push("Creator auto-blacklisted");
  }

  return {
    safe: score >= MIN_CREATOR_SCORE && dev.safe,
    score,
    reasons,
    creator: derived.creator,
    details: { mint: mintStr, resolver: resolved, derived, tokenProgram: prog, dev: dev.details },
  };
}
