// tokenCreatorScanner.js (ESM, SINGLE FILE)
// Export:
//   export async function verifyCreatorSafetyPumpfun(mintOrRecord)
//
// Mint-only, on-chain holder-cluster check:
// - getTokenLargestAccounts(mint) => top N token accounts
// - getAccountInfo(tokenAccount) => extract OWNER wallet (real holder wallet)
// - count UNIQUE owner wallets
// - flag if topN maps to 1–3 unique owners (dump cluster risk)

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";
import { getCanonicalMint } from "./canonical_mint.js";

const COMMITMENT = process.env.COMMITMENT || "confirmed";

// ONLY RPC 11 & 12
const RPC_ENDPOINTS = [process.env.RPC_URL_11, process.env.RPC_URL_12].filter(Boolean);

if (!RPC_ENDPOINTS.length) {
  throw new Error("No RPC endpoints configured (RPC_URL_11 / RPC_URL_12)");
}

const CONNECTIONS = RPC_ENDPOINTS.map((url) => new Connection(url, { commitment: COMMITMENT }));

let rpcIndex = 0;
function nextConn() {
  const c = CONNECTIONS[rpcIndex % CONNECTIONS.length];
  rpcIndex += 1;
  return c;
}

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("402") ||
    msg.includes("payment required") ||
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

const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

async function rpcLimited(opName, fn) {
  return q.add(async () => {
    let lastErr = null;

    for (let i = 0; i < CONNECTIONS.length; i++) {
      const c = nextConn();
      try {
        return await fn(c);
      } catch (e) {
        lastErr = e;
        if (!isRetryableRpcError(e)) break;
      }
    }

    throw new Error(`[RPC_FAILOVER] ${opName}: ${String(lastErr?.message || lastErr)}`);
  });
}

function safePk(s) {
  try {
    return new PublicKey(String(s));
  } catch {
    return null;
  }
}

// Convert RPC account data into Buffer safely (Buffer | [base64,"base64"])
function accountDataToBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;

  // In case some RPC returns base64 tuple
  if (Array.isArray(data) && typeof data[0] === "string") {
    try {
      return Buffer.from(data[0], "base64");
    } catch {
      return null;
    }
  }
  return null;
}

// SPL token account layout: owner wallet is bytes 32..63
function ownerFromTokenAccountData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return null;
  try {
    return new PublicKey(buf.subarray(32, 64)).toBase58();
  } catch {
    return null;
  }
}

function riskLabel(uniqueOwners) {
  if (uniqueOwners <= 3) return "HIGH";
  if (uniqueOwners <= 6) return "MED";
  return "LOW";
}

// REQUIRED EXPORT NAME
export async function verifyCreatorSafetyPumpfun(mintOrRecord) {
  const canon = await getCanonicalMint(mintOrRecord, COMMITMENT);

  if (!canon?.ok || !canon.mint) {
    return {
      safe: false,
      score: 0,
      reasons: ["Unresolved mint identifier"],
      details: {
        input: mintOrRecord,
        resolver: canon?.resolver || null,
        error: canon?.error || null,
      },
    };
  }

  const mintPk = safePk(canon.mint);
  if (!mintPk) {
    return {
      safe: false,
      score: 0,
      reasons: ["Invalid canonical mint"],
      details: {
        input: mintOrRecord,
        mint: String(canon.mint || ""),
        resolver: canon?.resolver || null,
      },
    };
  }

  const mintStr = mintPk.toBase58();

  const TOPN = Number(process.env.OWNER_SCAN_TOPN || 10);
  const HIGH_RISK_MAX = Number(process.env.OWNER_UNIQUE_HIGH_RISK_MAX || 3);

  // You said you will set this to 70
  const MIN_SCORE = Number(process.env.MIN_CREATOR_SCORE || 70);

  let score = 100;
  const reasons = [];

  // 1) largest token accounts
  const largest = await rpcLimited("getTokenLargestAccounts", (c) =>
    c.getTokenLargestAccounts(mintPk, COMMITMENT)
  ).catch(() => null);

  const list = Array.isArray(largest?.value) ? largest.value : [];
  const top = list.slice(0, Math.max(1, TOPN)).map((x) => ({
    tokenAccount: String(x?.address || ""),
    uiAmount: x?.uiAmountString ?? x?.uiAmount ?? x?.amount ?? "0",
  }));

  const tokenAccounts = top.map((x) => x.tokenAccount).filter(Boolean);

  if (!tokenAccounts.length) {
    reasons.push("no_largest_accounts");
    return {
      safe: score >= MIN_SCORE,
      score,
      reasons,
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: canon?.resolver || null,
        topN: 0,
        uniqueOwners: 0,
        risk: "LOW",
        flag: false,
        ownersRanked: [],
        ownersByTokenAccount: [],
      },
    };
  }

  // 2) tokenAccount -> owner wallet
  const ownerCountMap = Object.create(null);
  const ownerAmountMap = Object.create(null);
  const ownersByTokenAccount = [];

  for (const row of top) {
    const taPk = safePk(row.tokenAccount);
    if (!taPk) continue;

    const acc = await rpcLimited("getAccountInfo(tokenAccount)", (c) =>
      c.getAccountInfo(taPk, COMMITMENT)
    ).catch(() => null);

    const buf = accountDataToBuffer(acc?.data);
    const owner = buf ? ownerFromTokenAccountData(buf) : null;
    if (!owner) continue;

    ownersByTokenAccount.push({
      tokenAccount: row.tokenAccount,
      owner,
      uiAmount: String(row.uiAmount ?? "0"),
    });

    ownerCountMap[owner] = (ownerCountMap[owner] || 0) + 1;

    const amt = Number(row.uiAmount);
    ownerAmountMap[owner] = (ownerAmountMap[owner] || 0) + (Number.isFinite(amt) ? amt : 0);
  }

  const uniqueOwners = Object.keys(ownerCountMap).length;

  const ownersRanked = Object.entries(ownerAmountMap)
    .map(([owner, amountTopN]) => ({
      owner,
      tokenAccountsInTopN: ownerCountMap[owner] || 0,
      amountTopN,
    }))
    .sort((a, b) => b.amountTopN - a.amountTopN);

  const flag = uniqueOwners > 0 && uniqueOwners <= HIGH_RISK_MAX;
  const risk = riskLabel(uniqueOwners);

  if (flag) {
    score -= 45;
    reasons.push(`top${TOPN}_map_to_${uniqueOwners}_owners_high_dump_risk`);
  } else {
    reasons.push(`top${TOPN}_unique_owners_${uniqueOwners}`);
  }

  // CLAMP ONCE (ONLY ONE PLACE)
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return {
    safe: score >= MIN_SCORE,
    score,
    reasons,
    details: {
      input: mintOrRecord,
      mint: mintStr,
      resolver: canon?.resolver || null,
      topN: tokenAccounts.length,
      uniqueOwners,
      risk,
      flag,
      ownersRanked: ownersRanked.slice(0, 25),
      ownersByTokenAccount: ownersByTokenAccount.slice(0, 50),
    },
  };
}