import "dotenv/config";
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import PQueue from "p-queue";

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
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 12), // bump slightly
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

// ---------------- Pump.fun API (FAST ORIGIN) ----------------
async function pumpfunApiLookup(mintStr) {
  const url = `https://pump.fun/api/token/${mintStr}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    if (!j?.mint || j.mint !== mintStr) return { ok: false, reason: "bad_json" };
    return { ok: true, token: j };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// ---------------- Token-2022 detection (CORRECT) ----------------
async function detectTokenProgramOwner(mintPub) {
  const acc = await rpcLimited("getAccountInfo(mint)", (c) => c.getAccountInfo(mintPub)).catch(() => null);
  const owner = acc?.owner?.toBase58?.() || null;

  if (!owner) return { ok: false, owner: null, isToken2022: false, isTokenProgram: false };

  const isToken2022 = owner === TOKEN_2022_PROGRAM_ID.toBase58();
  const isTokenProgram = owner === TOKEN_PROGRAM_ID.toBase58();

  return { ok: true, owner, isToken2022, isTokenProgram };
}

// ---------------- FAST creator derivation (minimal tx fetch) ----------------
// Only fetch a small window of signatures and a few raw transactions.
async function derivePumpfunCreatorFast(mintPub) {
  const sigInfos = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
    c.getSignaturesForAddress(mintPub, { limit: 25 })
  ).catch(() => []);

  if (!sigInfos.length) return { creator: null, signature: null, scanned: 0 };

  let scanned = 0;

  for (const s of sigInfos) {
    const sig = s?.signature;
    if (!sig) continue;
    scanned++;

    const tx = await rpcLimited("getTransaction(sig)", (c) =>
      c.getTransaction(sig, { commitment: COMMITMENT, maxSupportedTransactionVersion: 1 })
    ).catch(() => null);

    if (!tx?.transaction?.message) continue;

    const msg = tx.transaction.message;

    // check if any instruction uses Pump program
    const keys = msg.accountKeys.map((k) => (k?.toBase58 ? k.toBase58() : String(k)));
    const pump = PUMP_PROGRAM_ID.toBase58();

    const ix = Array.isArray(msg.instructions) ? msg.instructions : [];
    const touchesPump = ix.some((i) => keys[i.programIdIndex] === pump);

    if (!touchesPump) continue;

    // best-effort: fee payer is first key
    const payer = keys[0] || null;
    return { creator: payer, signature: sig, scanned };
  }

  return { creator: null, signature: null, scanned };
}

// ---------------- Creator wallet analysis (unchanged, but fast caps) ----------------
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
    c.getSignaturesForAddress(creatorPub, { limit: 300 }) // cap hard
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

// ---------------- Exported API ----------------
export async function verifyCreatorSafetyPumpfun(mint) {
  const reasons = [];
  let score = 100;

  let mintPub;
  try {
    mintPub = new PublicKey(mint);
  } catch {
    return { safe: false, score: 0, reasons: ["Invalid mint"], creator: null, details: {} };
  }

  // 1) FAST: confirm pumpfun via API
  const api = await pumpfunApiLookup(mintPub.toBase58());
  if (!api.ok) {
    // not fatal, but you lose certainty
    reasons.push("pumpfun_api_unavailable");
    score -= 15;
  } else {
    reasons.push("pumpfun_origin_api");
  }

  // 2) Correct Token-2022 check
  const prog = await detectTokenProgramOwner(mintPub);
  if (prog.ok && prog.isToken2022) {
    // your choice: hard fail or penalty
    score -= 25;
    reasons.push("Token-2022 detected (penalty)");
  } else {
    reasons.push("Token program OK");
  }

  // 3) Derive creator fast (no deep scan)
  const derived = await derivePumpfunCreatorFast(mintPub);

  if (!derived.creator) {
    score = Math.max(0, score - CREATOR_UNKNOWN_PENALTY);
    reasons.push("creator_unknown");
    return {
      safe: score >= MIN_CREATOR_SCORE,
      score,
      reasons,
      creator: null,
      details: { derived, pumpfunApi: api.ok ? api.token : api, tokenProgram: prog },
    };
  }

  // 4) Blacklist
  const blacklist = loadBlacklist();
  if (blacklist.has(derived.creator)) {
    return {
      safe: false,
      score: 0,
      reasons: ["Creator BLACKLISTED"],
      creator: derived.creator,
      details: { derived, pumpfunApi: api.ok ? api.token : api, tokenProgram: prog },
    };
  }

  // 5) Creator wallet analysis
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
    details: { derived, pumpfunApi: api.ok ? api.token : api, tokenProgram: prog, dev: dev.details },
  };
}