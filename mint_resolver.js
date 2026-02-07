// mint_resolver.js (ESM)
// Resolves any "bot token identifier" into a real 32-byte SPL mint.
// Self-contained: builds its own Connection with RPC failover (RPC_URL_7, RPC_URL_13),
// rate-limits RPC calls, and retries on retryable RPC errors.
//
// Supports:
// - mint pubkey (32 bytes)
// - "xxxxx...pump" suffix (stripped)
// - token account -> mint (parsed account)
// - pump.fun bonding curve state -> mint (heuristic: discriminator(8) + mint(32))
//
// Env:
// RPC_URL_7 (required)
// RPC_URL_13 (optional)
// COMMITMENT (optional, default confirmed)
// RPC_INTERVAL_CAP, RPC_INTERVAL_MS
// RPC_RETRIES

import "dotenv/config";
import bs58 from "bs58";
import PQueue from "p-queue";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

// ---------------- RPC failover (internal) ----------------
const RPC_URL_7 = process.env.RPC_URL_7 || "";
const RPC_URL_13 = process.env.RPC_URL_13 || "";

const RPC_ENDPOINTS = [RPC_URL_7, RPC_URL_13].filter(Boolean);
if (RPC_ENDPOINTS.length === 0) {
  throw new Error("mint_resolver: missing RPC_URL_7 / RPC_URL_13");
}

const COMMITMENT = process.env.COMMITMENT || "confirmed";

function pickRpcCandidates() {
  return [...new Set(RPC_ENDPOINTS)];
}

let activeRpcUrl = pickRpcCandidates()[0];
let conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });

function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed on all RPCs. last=${msg}`);
}

const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

async function rpcLimited(opName, fn) {
  const retries = Number(process.env.RPC_RETRIES || 2);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await rpcQueue.add(() => withRpcFailover(opName, fn));
    } catch (e) {
      if (attempt >= retries || !isRetryableRpcError(e)) throw e;
      await sleep(250 * Math.pow(2, attempt));
    }
  }

  throw new Error(`[RPC_RETRY] ${opName} exhausted retries`);
}

// Optional: export for logging/diagnostics
export function getActiveResolverRpc() {
  return activeRpcUrl;
}

// ---------------- Base58 helpers ----------------
export function stripPumpSuffix(input) {
  let s = String(input || "").trim();
  if (s.toLowerCase().endsWith("pump")) s = s.slice(0, -4).trim();
  return s;
}

export function b58Len(input) {
  try {
    const b = bs58.decode(String(input));
    return b.length;
  } catch {
    return null;
  }
}

export function is32BytePubkeyStr(input) {
  const s = stripPumpSuffix(input);
  const len = b58Len(s);
  return len === 32;
}

function safePk(input) {
  const s = stripPumpSuffix(input);
  if (!is32BytePubkeyStr(s)) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

function looksLikeMintData(buf) {
  // SPL mint base has decimals at byte 44 (0-18 typical)
  if (!Buffer.isBuffer(buf) || buf.length < 45) return false;
  const d = buf[44];
  return Number.isInteger(d) && d >= 0 && d <= 18;
}

// ---------------- Resolution strategies (on-chain) ----------------
async function tryResolveIfMintAccount(pubkey, commitment) {
  const ai = await rpcLimited("getAccountInfo(mint?)", (c) =>
    c.getAccountInfo(pubkey, { commitment })
  );

  if (!ai) return null;

  const owner = ai.owner?.toBase58?.() || "";
  const isToken = owner === TOKEN_PROGRAM_ID.toBase58();
  const isT22 = owner === TOKEN_2022_PROGRAM_ID.toBase58();

  if (!isToken && !isT22) return null;
  if (!looksLikeMintData(ai.data)) return null;

  return {
    ok: true,
    mint: pubkey.toBase58(),
    kind: "mint_account",
    owner,
    rpcUsed: activeRpcUrl,
  };
}

async function tryResolveIfTokenAccount(pubkey, commitment) {
  const parsed = await rpcLimited("getParsedAccountInfo(tokenAccount?)", (c) =>
    c.getParsedAccountInfo(pubkey, { commitment })
  );

  const info = parsed?.value?.data?.parsed?.info;
  const type = parsed?.value?.data?.parsed?.type;

  if (type !== "account" || !info?.mint) return null;

  const mintStr = String(info.mint);
  if (!is32BytePubkeyStr(mintStr)) return null;

  return {
    ok: true,
    mint: stripPumpSuffix(mintStr),
    kind: "token_account",
    rpcUsed: activeRpcUrl,
  };
}

async function tryResolvePumpBondingCurve(pubkey, commitment) {
  const ai = await rpcLimited("getAccountInfo(pumpCurve?)", (c) =>
    c.getAccountInfo(pubkey, { commitment })
  );
  if (!ai) return null;

  const owner = ai.owner?.toBase58?.() || "";
  if (owner !== PUMP_PROGRAM_ID.toBase58()) return null;

  const data = ai.data;
  if (!Buffer.isBuffer(data) || data.length < 8 + 32) return null;

  // heuristic: Anchor discriminator (8 bytes) then mint pubkey (32 bytes)
  const mintBytes = data.subarray(8, 8 + 32);
  const mintStr = bs58.encode(mintBytes);

  if (!is32BytePubkeyStr(mintStr)) return null;

  // verify it is actually a mint account
  const mintPk = new PublicKey(mintStr);
  const mintCheck = await tryResolveIfMintAccount(mintPk, commitment).catch(() => null);
  if (!mintCheck) return null;

  return {
    ok: true,
    mint: mintStr,
    kind: "pump_bonding_curve",
    curve: pubkey.toBase58(),
    rpcUsed: activeRpcUrl,
  };
}

function toIdString(v) {
  if (!v) return "";
  // PublicKey (and similar)
  if (typeof v?.toBase58 === "function") return v.toBase58();
  // Buffer/Uint8Array etc, just stringify as fallback
  if (typeof v === "string") return v;
  // If it is a number/bigint, stringify
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  // If it is an object, do NOT allow String(obj) => [object Object]
  // Return empty so it won't poison resolver.
  return "";
}

function normalizeCandidates(recordOrMint) {
  const candidates = [];

  if (typeof recordOrMint === "string") {
    candidates.push(recordOrMint);
  } else if (recordOrMint && typeof recordOrMint === "object") {
    if (recordOrMint.mint) candidates.push(recordOrMint.mint);
    if (recordOrMint.bondingCurve) candidates.push(recordOrMint.bondingCurve);
    if (recordOrMint.curve) candidates.push(recordOrMint.curve);
    if (recordOrMint.pair) candidates.push(recordOrMint.pair);
    if (recordOrMint.pairAddress) candidates.push(recordOrMint.pairAddress);
  }

  const uniq = [];
  const seen = new Set();

  for (const c of candidates) {
    const raw = toIdString(c);
    const s = stripPumpSuffix(raw);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }

  return uniq;
}
// ---------------- Main resolver ----------------
// Supports BOTH calling styles to stop "[object Object]" bugs:
//
// 1) resolveMintOnChain(recordOrMint, commitment)
// 2) resolveMintOnChain(connectionIgnored, recordOrMint, commitment)
//
// We ignore the passed connection because this resolver is self-contained.
export async function resolveMintOnChain(arg1, arg2 = COMMITMENT, arg3 = COMMITMENT) {
  const arg1IsObject = arg1 && typeof arg1 === "object";

  const arg1LooksLikeConn =
    arg1IsObject &&
    (typeof arg1.getAccountInfo === "function" ||
      typeof arg1.getParsedAccountInfo === "function" ||
      typeof arg1.getSignaturesForAddress === "function" ||
      typeof arg1._rpcEndpoint === "string");

  // Only this should decide call style
  const use3ArgsStyle = arg1LooksLikeConn;

  const recordOrMint = use3ArgsStyle ? arg2 : arg1;
  const commitment = use3ArgsStyle
    ? (typeof arg3 === "string" ? arg3 : COMMITMENT)
    : (typeof arg2 === "string" ? arg2 : COMMITMENT);

  const uniq = normalizeCandidates(recordOrMint);

  for (const s of uniq) {
    const pk = safePk(s);
    if (!pk) continue;

    const asMint = await tryResolveIfMintAccount(pk, commitment).catch(() => null);
    if (asMint) return asMint;

    const asTokenAcc = await tryResolveIfTokenAccount(pk, commitment).catch(() => null);
    if (asTokenAcc) return asTokenAcc;

    const asCurve = await tryResolvePumpBondingCurve(pk, commitment).catch(() => null);
    if (asCurve) return asCurve;
  }

  const first = uniq[0] || toIdString(recordOrMint) || "";
const len = b58Len(stripPumpSuffix(first));

  return {
    ok: false,
    kind: "unresolved_identifier",
    input: first,
    reason: len == null ? "not_base58" : `wrong_size_${len}`,
    rpcUsed: activeRpcUrl,
  };
}