// creator_safety_pumpfun.js (ESM, SINGLE FILE)
// On-chain only creator-risk signals (no fs, no wallet age/balance/tx-count scoring).
//
// Signals implemented:
// 1) Creator creates many tokens rapidly (mint-velocity proxy via pump-program tx + mint discovery)
// 2) Creator funds many fresh wallets (SystemProgram transfers -> recipients whose first tx is very recent)
//
// Uses canonical mint gateway:
//   import { getCanonicalMint } from "./canonical_mint.js";
//
// Export:
//   export async function verifyCreatorSafetyPumpfun(mintOrRecord)

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import PQueue from "p-queue";
import { getCanonicalMint } from "./canonical_mint.js";

const COMMITMENT = "confirmed";
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// ONLY RPC 11 & 12
const RPC_ENDPOINTS = [process.env.RPC_URL_11, process.env.RPC_URL_12].filter(Boolean);

if (!RPC_ENDPOINTS.length) {
  throw new Error("No RPC endpoints configured (RPC_URL_11 / RPC_URL_12)");
}

const CONNECTIONS = RPC_ENDPOINTS.map((url) => new Connection(url, { commitment: COMMITMENT }));

let rpcIndex = 0;

export function getNextConnection() {
  const c = CONNECTIONS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % CONNECTIONS.length;
  return c;
}

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("402") ||
    msg.includes("payment required") ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("fetch failed") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("node is behind") ||
    msg.includes("block height exceeded")
  );
}

const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

async function withRpcFailover(op, fn) {
  let lastErr = null;
  for (let i = 0; i < CONNECTIONS.length; i++) {
    const idx = (rpcIndex + i) % CONNECTIONS.length;
    try {
      const res = await fn(CONNECTIONS[idx]);
      rpcIndex = idx;
      return res;
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }
  throw new Error(`[RPC_FAILOVER:${op}] ${String(lastErr?.message || lastErr)}`);
}

function rpcLimited(op, fn) {
  return q.add(() => withRpcFailover(op, fn));
}

// ---------- helpers ----------

function is32ByteBase58Pubkey(s) {
  try {
    new PublicKey(String(s));
    return true;
  } catch {
    return false;
  }
}

function getMessageKeys(msg) {
  return Array.isArray(msg?.staticAccountKeys)
    ? msg.staticAccountKeys
    : Array.isArray(msg?.accountKeys)
    ? msg.accountKeys
    : [];
}

function getCompiledInstructions(msg) {
  return Array.isArray(msg?.compiledInstructions)
    ? msg.compiledInstructions
    : Array.isArray(msg?.instructions)
    ? msg.instructions
    : [];
}

function touchesProgram(tx, programId) {
  const msg = tx?.transaction?.message;
  if (!msg) return false;

  const keys = getMessageKeys(msg).map((k) => (k?.toBase58 ? k.toBase58() : String(k)));
  return getCompiledInstructions(msg).some((ix) => keys[ix?.programIdIndex] === programId);
}

function toUnixSec() {
  return Math.floor(Date.now() / 1000);
}

function ageSecFromBlockTime(bt) {
  return typeof bt === "number" ? toUnixSec() - bt : null;
}

// ---------- token program ----------

async function detectTokenProgramOwner(mintPub) {
  const acc = await rpcLimited("getAccountInfo(mint)", (c) => c.getAccountInfo(mintPub)).catch(
    () => null
  );

  const owner = acc?.owner?.toBase58?.() || null;
  return {
    ok: !!owner,
    owner,
    isTokenProgram: owner === TOKEN_PROGRAM_ID.toBase58(),
    isToken2022: owner === TOKEN_2022_PROGRAM_ID.toBase58(),
  };
}

// ---------- creator derivation ----------

async function derivePumpfunCreatorFast(mintPub) {
  const sigs = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
    c.getSignaturesForAddress(mintPub, { limit: 25 })
  ).catch(() => []);

  let scanned = 0;
  const pump = PUMP_PROGRAM_ID.toBase58();

  for (const s of sigs) {
    const sig = s?.signature;
    if (!sig) continue;
    scanned++;

    const tx = await rpcLimited("getTransaction(sig)", (c) =>
      c.getTransaction(sig, { commitment: COMMITMENT, maxSupportedTransactionVersion: 1 })
    ).catch(() => null);

    if (!tx || !touchesProgram(tx, pump)) continue;

    const msg = tx.transaction.message;
    const keys = getMessageKeys(msg).map((k) => (k?.toBase58 ? k.toBase58() : String(k)));

    return {
      creator: keys[0] || null, // best-effort fee payer
      signature: sig,
      scanned,
      sawPump: true,
    };
  }

  return { creator: null, scanned, sawPump: false };
}

// ---------- funding factory ----------

async function analyzeFundingFactory(creatorStr, windowSec = 86400, freshSec = 21600) {
  const creatorPub = new PublicKey(creatorStr);
  const sigs = await rpcLimited("getSignaturesForAddress(creator)", (c) =>
    c.getSignaturesForAddress(creatorPub, { limit: 200 })
  ).catch(() => []);

  const cutoff = toUnixSec() - windowSec;
  const recipients = new Set();

  for (const s of sigs) {
    if (typeof s?.blockTime !== "number" || s.blockTime < cutoff) continue;

    const ptx = await rpcLimited("getParsedTransaction(sig)", (c) =>
      c.getParsedTransaction(s.signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 1 })
    ).catch(() => null);

    const ixs = Array.isArray(ptx?.transaction?.message?.instructions)
      ? ptx.transaction.message.instructions
      : [];

    for (const ix of ixs) {
      if (ix?.program !== "system") continue;
      if (ix?.parsed?.type !== "transfer") continue;

      const info = ix?.parsed?.info || {};
      const src = String(info?.source || "");
      const dst = String(info?.destination || "");
      if (!src || !dst) continue;

      if (src === creatorStr && is32ByteBase58Pubkey(dst)) recipients.add(dst);
    }
  }

  let fresh = 0;
  for (const r of [...recipients].slice(0, 60)) {
    const rs = await rpcLimited("getSignaturesForAddress(r)", (c) =>
      c.getSignaturesForAddress(new PublicKey(r), { limit: 20 })
    ).catch(() => []);

    const oldest = rs?.[rs.length - 1];
    const age = ageSecFromBlockTime(oldest?.blockTime);
    if (age != null && age <= freshSec) fresh++;
  }

  return { ok: true, fundedWallets: recipients.size, fundedFreshWallets: fresh };
}

// ---------- mint velocity (NO FALLBACK) ----------

async function analyzeMintVelocity(creatorStr, windows = [3600, 21600, 86400]) {
  const creatorPub = new PublicKey(creatorStr);
  const sigs = await rpcLimited("getSignaturesForAddress(creator)", (c) =>
    c.getSignaturesForAddress(creatorPub, { limit: 400 })
  ).catch(() => []);

  const pump = PUMP_PROGRAM_ID.toBase58();
  const now = toUnixSec();
  const out = { ok: true, windows: {}, scanned: 0 };

  for (const w of windows) out.windows[w] = { uniqueMints: 0, mints: [] };

  if (!sigs.length) return out;

  const maxW = Math.max(...windows);
  const txs = [];

  for (const s of sigs) {
    if (typeof s?.blockTime !== "number" || s.blockTime < now - maxW) continue;

    const tx = await rpcLimited("getTransaction(sig)", (c) =>
      c.getTransaction(s.signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 1 })
    ).catch(() => null);

    if (!tx) continue;
    if (!touchesProgram(tx, pump)) continue;

    txs.push({ tx, blockTime: s.blockTime });
  }

  out.scanned = txs.length;

  for (const w of windows) {
    const cutoff = now - w;
    const mintSet = new Set();

    for (const t of txs) {
      if (typeof t.blockTime !== "number" || t.blockTime < cutoff) continue;

      const post = Array.isArray(t.tx?.meta?.postTokenBalances) ? t.tx.meta.postTokenBalances : [];
      for (const b of post) {
        const m = String(b?.mint || "");
        if (m && is32ByteBase58Pubkey(m)) mintSet.add(m);
      }
    }

    out.windows[w] = { uniqueMints: mintSet.size, mints: [...mintSet] };
  }

  return out;
}

// ---------- scoring ----------

function scoreFromSignals({ velocity, funding }) {
  let score = 100;
  const reasons = [];

  const v1h = velocity?.windows?.[3600]?.uniqueMints ?? 0;
  const v24h = velocity?.windows?.[86400]?.uniqueMints ?? 0;

  if (v1h >= 3) {
    score -= 25;
    reasons.push(`creator_high_mint_velocity_1h_${v1h}`);
  } else {
    reasons.push(`creator_mint_velocity_1h_${v1h}`);
  }

  if (v24h >= 10) {
    score -= 40;
    reasons.push(`creator_high_mint_velocity_24h_${v24h}`);
  } else {
    reasons.push(`creator_mint_velocity_24h_${v24h}`);
  }

  const funded = funding?.fundedWallets ?? 0;
  const fundedFresh = funding?.fundedFreshWallets ?? 0;

  if (funded >= 20) {
    score -= 20;
    reasons.push(`creator_funds_many_wallets_24h_${funded}`);
  } else {
    reasons.push(`creator_funds_wallets_24h_${funded}`);
  }

  if (fundedFresh >= 10) {
    score -= 45;
    reasons.push(`creator_funds_fresh_wallets_24h_${fundedFresh}`);
  } else {
    reasons.push(`creator_funds_fresh_wallets_24h_${fundedFresh}`);
  }

  score = Math.max(0, Math.min(100, score));
  return { score, reasons };
}

// ---------- REQUIRED EXPORT ----------

export async function verifyCreatorSafetyPumpfun(mintOrRecord) {
  const canon = await getCanonicalMint(mintOrRecord, COMMITMENT);

  if (!canon?.ok || !canon.mint) {
    return { safe: false, score: 0, reasons: ["Unresolved mint identifier"], creator: null };
  }

  let mintPub;
  try {
    mintPub = new PublicKey(canon.mint);
  } catch {
    return { safe: false, score: 0, reasons: ["Invalid canonical mint"], creator: null };
  }

  const prog = await detectTokenProgramOwner(mintPub);

  const derived = await derivePumpfunCreatorFast(mintPub);
  if (!derived.creator) {
    return { safe: true, score: 100, reasons: ["creator_not_determined"], creator: null };
  }

  const [funding, velocity] = await Promise.all([
    analyzeFundingFactory(derived.creator),
    analyzeMintVelocity(derived.creator),
  ]);

  const scored = scoreFromSignals({ funding, velocity });
  const MIN = Number(process.env.MIN_CREATOR_SCORE || 65);

  return {
    safe: scored.score >= MIN,
    score: scored.score,
    reasons: scored.reasons,
    creator: derived.creator,
  };
}