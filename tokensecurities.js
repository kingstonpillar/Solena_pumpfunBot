// verifyTokenSecurity.js (ESM)
// ON-CHAIN ONLY security checks (no pump.fun API, no curve/migration)
// Focus: mint/freeze authority, token program owner, token-2022 risk flags, holder concentration.
// Fixes decimal issues using BigInt (raw amounts), not ui strings.

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import PQueue from "p-queue";
import { getCanonicalMint } from "./canonical_mint.js";

// ---------------- RPC FAILOVER ----------------
const RPC_ENDPOINTS = [process.env.RPC_URL_3, process.env.RPC_URL_4].filter(Boolean);
if (RPC_ENDPOINTS.length === 0) throw new Error("Missing RPC_URL_3 / RPC_URL_4 in env");

const COMMITMENT = process.env.COMMITMENT || "confirmed";

let activeRpcUrl = RPC_ENDPOINTS[0];
let conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });

function pickRpcCandidates() {
  return [...new Set(RPC_ENDPOINTS)];
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
    msg.includes("node is behind")
  );
}

function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });
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

  throw new Error(`[RPC_FAILOVER] ${opName} failed on all RPCs. last=${String(lastErr?.message || lastErr)}`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[TIMEOUT] ${label} after ${ms}ms`)), ms)
    ),
  ]);
}

// ---------------- PQUEUE ----------------
const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  const timeoutMs = Number(process.env.RPC_TIMEOUT_MS || 15000);
  return q.add(() => withTimeout(withRpcFailover(opName, fn), timeoutMs, opName));
}

// ---------------- Helpers ----------------
function nullIfSystem111(v) {
  if (!v) return null;
  if (v === "11111111111111111111111111111111") return null;
  return v;
}

function bi(x) {
  try {
    return BigInt(String(x));
  } catch {
    return null;
  }
}

// ---------------- Core checks ----------------
async function getMintParsedAndRaw(mintPub) {
  // parsed: RpcResponseAndContext
  const parsed = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mintPub, { commitment: COMMITMENT })
  );

  // raw: AccountInfo | null (NOT { value })
  const raw = await rpcLimited("getAccountInfo(mintRaw)", (c) =>
    c.getAccountInfo(mintPub, { commitment: COMMITMENT })
  );

  return { parsed, raw };
}

function extractMintAuthorities(parsedResp) {
  const info = parsedResp?.value?.data?.parsed?.info || {};
  const mintAuthority = nullIfSystem111(info?.mintAuthority ?? null);
  const freezeAuthority = nullIfSystem111(info?.freezeAuthority ?? null);
  const decimals = Number(info?.decimals ?? NaN);
  const isInitialized = info?.isInitialized === true || info?.isInitialized === "true";
  return { mintAuthority, freezeAuthority, decimals, isInitialized, parsedInfo: info };
}

function token2022RiskFromParsed(parsedInfo) {
  const exts = Array.isArray(parsedInfo?.extensions) ? parsedInfo.extensions : [];
  const s = exts.map((x) => String(x).toLowerCase());

  const dangerous =
    s.some((e) => e.includes("transferhook")) ||
    s.some((e) => e.includes("confidential")) ||
    s.some((e) => e.includes("defaultaccountstate")) ||
    s.some((e) => e.includes("nontransferable")) ||
    s.some((e) => e.includes("transferfee")) ||
    s.some((e) => e.includes("withheld")) ||
    s.some((e) => e.includes("permanentdelegate")) ||
    s.some((e) => e.includes("mintcloseauthority"));

  return { extensions: s, dangerous };
}

async function top10ConcentrationBigInt(mintPub) {
  const largest = await rpcLimited("getTokenLargestAccounts", (c) =>
    c.getTokenLargestAccounts(mintPub, COMMITMENT)
  );

  const supply = await rpcLimited("getTokenSupply", (c) =>
    c.getTokenSupply(mintPub, COMMITMENT)
  );

  const supplyAmt = bi(supply?.value?.amount);
  const decimals = Number(supply?.value?.decimals ?? 0);
  const arr = Array.isArray(largest?.value) ? largest.value : [];

  if (!supplyAmt || supplyAmt <= 0n || arr.length === 0) {
    return { ok: false, pct: 1, reason: "no_supply_or_holders", decimals };
  }

  let topSum = 0n;
  for (const a of arr.slice(0, 10)) {
    const amt = bi(a?.amount);
    if (amt && amt > 0n) topSum += amt;
  }

  // safer ratio (keeps precision, avoids Number overflow in weird supplies)
  const pct = Number((topSum * 1_000_000n) / supplyAmt) / 1_000_000;

  return {
    ok: true,
    pct,
    supplyAmount: supplyAmt.toString(),
    top10Amount: topSum.toString(),
    decimals,
  };
}

// ---------------- PUBLIC API ----------------
export async function checkTokenSecurity(mintOrRecord) {
  const reasons = [];
  let score = 0;

  // 0) Canonical mint gateway
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

  const mintStr = String(canon.mint).trim();
  const resolverMeta = canon?.resolver || null;

  let mintPub;
  try {
    mintPub = new PublicKey(mintStr);
  } catch {
    return {
      safe: false,
      score: 0,
      reasons: ["Invalid canonical mint"],
      details: { input: mintOrRecord, mint: mintStr, resolver: resolverMeta },
    };
  }

  // 1) Mint account exists + owner check (FIXED raw.value usage)
  const { parsed, raw } = await getMintParsedAndRaw(mintPub).catch(() => ({
    parsed: null,
    raw: null,
  }));

  const rawValue = raw?.value || null;
  if (!rawValue) {
    return {
      safe: false,
      score: 0,
      reasons: ["Mint account not found on-chain (bad mint or RPC issue)"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  const ownerStr = rawValue.owner?.toBase58?.() || null;
  const isTokenProgram = ownerStr === TOKEN_PROGRAM_ID.toBase58();
  const isToken2022 = ownerStr === TOKEN_2022_PROGRAM_ID.toBase58();

  if (!isTokenProgram && !isToken2022) {
    return {
      safe: false,
      score: 0,
      reasons: [`Unknown token program owner: ${ownerStr || "null"}`],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        owner: ownerStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  score += 15;
  reasons.push(isTokenProgram ? "spl_token_program" : "token2022_program");

  // 2) Authorities + init
  const {
    mintAuthority,
    freezeAuthority,
    decimals,
    isInitialized,
    parsedInfo,
  } = extractMintAuthorities(parsed);

  if (!isInitialized) {
    return {
      safe: false,
      score: 0,
      reasons: ["Mint not initialized"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        decimals,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  if (mintAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`Mint authority present: ${mintAuthority}`],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        mintAuthority,
        freezeAuthority,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  score += 35;
  reasons.push("mint_authority_renounced");

  if (freezeAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`Freeze authority present: ${freezeAuthority}`],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        mintAuthority,
        freezeAuthority,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  score += 25;
  reasons.push("freeze_authority_renounced");

  // 3) Token-2022 risk flags
  if (isToken2022) {
    const r = token2022RiskFromParsed(parsedInfo);
    if (r.dangerous) {
      return {
        safe: false,
        score: 0,
        reasons: [
          `Token-2022 risky extensions: ${r.extensions.join(",") || "unknown"}`,
        ],
        details: {
          input: mintOrRecord,
          mint: mintStr,
          token2022: r,
          resolver: resolverMeta,
          rpcUsed: activeRpcUrl,
        },
      };
    }

    score += 10;
    reasons.push("token2022_no_dangerous_extensions");
  }

  // 4) Distribution (top10) HARD FAIL > 25%
  const TOP10_MAX_PCT = Number(process.env.TOP10_MAX_PCT || 0.25);
  const dist = await top10ConcentrationBigInt(mintPub).catch(() => null);

  if (dist?.ok) {
    if (dist.pct > TOP10_MAX_PCT) {
      return {
        safe: false,
        score: 0,
        reasons: [
          `top10_hard_fail_${dist.pct.toFixed(6)}_gt_${TOP10_MAX_PCT}`,
        ],
        details: {
          input: mintOrRecord,
          mint: mintStr,
          owner: ownerStr,
          decimals,
          distribution: dist,
          resolver: resolverMeta,
          rpcUsed: activeRpcUrl,
        },
      };
    }

    // Passed hard gate
    score += 15;
    reasons.push(`top10_ok_${dist.pct.toFixed(6)}`);
  } else {
    // Keep your prior behavior: unknown does not auto-fail.
    // If you want strict mode, change this to a hard-fail return.
    reasons.push("top10_unknown");
  }

  if (score > 100) score = 100;

  const SAFE_THRESHOLD = Number(process.env.SAFE_THRESHOLD || 70);
  const safe = score >= SAFE_THRESHOLD;

  return {
    safe,
    score,
    reasons,
    details: {
      input: mintOrRecord,
      mint: mintStr,
      owner: ownerStr,
      decimals,
      distribution: dist,
      resolver: resolverMeta,
      rpcUsed: activeRpcUrl,
    },
  };
}
