// verifyTokenSecurity.js (ESM)
// ON-CHAIN ONLY security checks (no pump.fun API, no curve/migration)
// Focus: mint/freeze authority, token program owner, token-2022 risk flags, holder concentration.
// Uses BigInt raw amounts (no ui string math).
// HARD FAIL: top10 > TOP10_MAX_PCT (default 0.25)

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Buffer } from "buffer";

import PQueue from "p-queue";
import { getCanonicalMint } from "./canonical_mint.js";

// ---------------- RPC SETUP ----------------
const RPC_ENDPOINTS = [process.env.RPC_URL_3, process.env.RPC_URL_4].filter(Boolean);
if (!RPC_ENDPOINTS.length) throw new Error("Missing RPC_URL_3 / RPC_URL_4 in env");

const COMMITMENT = process.env.COMMITMENT || "confirmed";

let activeRpcUrl = RPC_ENDPOINTS[0];
let conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });

function pickRpcCandidates() {
  return [...new Set(RPC_ENDPOINTS)];
}

function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });
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

function rpcOnCurrent(opName, fn) {
  const timeoutMs = Number(process.env.RPC_TIMEOUT_MS || 15000);
  return q.add(() => withTimeout(fn(conn), timeoutMs, opName));
}

// Single, non-nested failover: tries each RPC in order for THIS op.
async function rpcTryAll(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      return await rpcOnCurrent(opName, fn);
    } catch (e) {
      lastErr = e;
      // You prefer "keep trying", so we still try the next RPC even if non-retryable.
      // This keeps behavior consistent across providers.
      continue;
    }
  }

  throw new Error(
    `[RPC_FAILOVER] ${opName} failed on all RPCs. last=${String(
      lastErr?.message || lastErr
    )}`
  );
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

function asB58(v) {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v?.toBase58 === "function") return v.toBase58();
  return String(v).trim();
}

// Classic SPL token account layout owner offset: bytes 32..64
// Only safe to use this raw decode for TOKEN_PROGRAM_ID, not token-2022.
function readTokenAccountOwnerFromRaw(accInfo) {
  const d = accInfo?.data;
  if (!d || typeof d?.subarray !== "function" || d.length < 64) return null;
  return new PublicKey(d.subarray(32, 64)).toBase58();
}

// ---------------- Core reads ----------------
async function getMintParsedAndRaw(mintPub) {
  let lastErr = null;

  for (const url of pickRpcCandidates()) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      const [raw, parsedResp] = await Promise.all([
        rpcOnCurrent("getAccountInfo(mint)", (c) =>
          c.getAccountInfo(mintPub, { commitment: COMMITMENT })
        ),
        rpcOnCurrent("getParsedAccountInfo(mint)", (c) =>
          c.getParsedAccountInfo(mintPub, { commitment: COMMITMENT })
        ),
      ]);

      if (raw) return { raw, parsed: parsedResp?.value || null };
      continue;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  return {
    raw: null,
    parsed: null,
    err: lastErr ? String(lastErr?.message || lastErr) : null,
  };
}

function extractMintAuthorities(parsedValue) {
  const info = parsedValue?.data?.parsed?.info || {};
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

// --------------- top10ConcentrationBigInt ----------------
async function top10ConcentrationBigInt(mintPub, opts = {}) {
  const {
    bondingCurvePubkey = null,
    tokenProgramId = TOKEN_PROGRAM_ID,
    inspectN = 20,
    sumN = 10,
  } = opts;

  const mintPk = mintPub instanceof PublicKey ? mintPub : new PublicKey(mintPub);

  
const largest = await rpcTryAll("getTokenLargestAccounts", (c) =>
  c.getTokenLargestAccounts(mintPk, { commitment: COMMITMENT })
);

const supply = await rpcTryAll("getTokenSupply", (c) =>
  c.getTokenSupply(mintPk, { commitment: COMMITMENT })
);
  const supplyAmt = bi(supply?.value?.amount);
  const decimals = Number(supply?.value?.decimals ?? 0);
  const arr = Array.isArray(largest?.value) ? largest.value : [];

  if (!supplyAmt || supplyAmt <= 0n || arr.length === 0) {
    return { ok: false, pct: 1, reason: "no_supply_or_holders", decimals };
  }

  // Compute curve ATA (token account address) so we can exclude it precisely
  let curveAtaStr = null;
  let curveOwnerStr = null;

  if (bondingCurvePubkey) {
    const curvePk =
      bondingCurvePubkey instanceof PublicKey
        ? bondingCurvePubkey
        : new PublicKey(String(bondingCurvePubkey));

    curveOwnerStr = curvePk.toBase58();

    // allowOwnerOffCurve=true since curve PDAs can be off curve
    const curveAta = getAssociatedTokenAddressSync(
      mintPk,
      curvePk,
      true,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    curveAtaStr = curveAta.toBase58();
  }

  // Pull a bit more than top10 so we can skip excluded accounts and still sum N accounts
  const inspect = arr.slice(0, Math.max(sumN, inspectN));

  // -------- BATCH TOKEN ACCOUNT FETCH (once) --------
  // Only useful for owner exclusion, and owner raw decoding is only safe for classic SPL token accounts.
  const tokenAccountInfos = new Map();

  if (curveOwnerStr && tokenProgramId === TOKEN_PROGRAM_ID) {
    const pubkeys = inspect
      .map((a) => asB58(a?.address))
      .filter(Boolean)
      .map((x) => new PublicKey(x));

    const multi = await rpcTryAll("getMultipleAccountsInfo(largestTA_batch)", (c) =>
      c.getMultipleAccountsInfo(pubkeys, { commitment: COMMITMENT })
    ).catch(() => null);

    if (Array.isArray(multi)) {
      pubkeys.forEach((pk, i) => {
        tokenAccountInfos.set(pk.toBase58(), multi[i] || null);
      });
    }
  }

  let topSum = 0n;
  let counted = 0;

  for (const a of inspect) {
    const tokenAccountAddr = asB58(a?.address);
    if (!tokenAccountAddr) continue;

    // Exclude curve ATA if known
    if (curveAtaStr && tokenAccountAddr === curveAtaStr) continue;

    // Backup exclusion by raw owner decode (classic SPL only)
    if (curveOwnerStr && tokenProgramId === TOKEN_PROGRAM_ID) {
      const accInfo = tokenAccountInfos.get(tokenAccountAddr);
      const owner = readTokenAccountOwnerFromRaw(accInfo);
      if (owner === curveOwnerStr) continue;
    }

    const amt = bi(a?.amount);
    if (!amt || amt <= 0n) continue;

    topSum += amt;
    counted += 1;

    if (counted >= sumN) break;
  }

  // If we excluded too much and didn’t count enough, treat as “unknown” rather than hard-fail.
  if (counted === 0) {
    return { ok: false, pct: 1, reason: "no_counted_holders_after_exclusions", decimals };
  }

  // NOTE: returns fraction (0..1), not percent
  const pct = Number((topSum * 1_000_000n) / supplyAmt) / 1_000_000;

  return {
    ok: true,
    pct,
    supplyAmount: supplyAmt.toString(),
    top10Amount: topSum.toString(),
    decimals,
    excludedCurveAta: curveAtaStr,
    excludedCurveOwner: curveOwnerStr,
    countedHolders: counted,
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
        rpcUsed: activeRpcUrl,
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
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  // 1) Mint exists + owner check
  const { parsed, raw, err } = await getMintParsedAndRaw(mintPub);
  if (!raw) {
    return {
      safe: false,
      score: 0,
      reasons: ["Mint account not found on-chain (bad mint or RPC issue)"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
        err: err || null,
      },
    };
  }

  const ownerStr = raw.owner?.toBase58?.() || null;
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

  // 2) Parsed mint info required
  if (!parsed) {
    return {
      safe: false,
      score: 0,
      reasons: ["Mint parsed info unavailable (RPC parsing issue)"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  // 3) Authorities + initialization
  const { mintAuthority, freezeAuthority, decimals, isInitialized, parsedInfo } =
    extractMintAuthorities(parsed);

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

  // 4) Token-2022 risk flags
  if (isToken2022) {
    const r = token2022RiskFromParsed(parsedInfo);
    if (r.dangerous) {
      return {
        safe: false,
        score: 0,
        reasons: [`Token-2022 risky extensions: ${r.extensions.join(",") || "unknown"}`],
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

  // 5) Distribution (top10) HARD FAIL > TOP10_MAX_PCT
  const TOP10_MAX_PCT = Number(process.env.TOP10_MAX_PCT || 0.25);

  // token program comes from the mint owner we already computed above
  const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  // bonding curve (optional) comes from the input record (if you passed it)
  const bondingCurvePubkey =
    mintOrRecord && typeof mintOrRecord === "object"
      ? mintOrRecord.bondingCurve ||
        mintOrRecord.bondingCurvePubkey ||
        mintOrRecord.curve ||
        null
      : null;

  const dist = await top10ConcentrationBigInt(mintPub, {
    bondingCurvePubkey,
    tokenProgramId,
  }).catch(() => null);

  if (dist?.ok) {
    if (dist.pct > TOP10_MAX_PCT) {
      return {
        safe: false,
        score: 0,
        reasons: [`top10_hard_fail_${dist.pct.toFixed(6)}_gt_${TOP10_MAX_PCT}`],
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

    score += 15;
    reasons.push(`top10_ok_${dist.pct.toFixed(6)}`);
  } else {
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
      distribution: dist || null,
      resolver: resolverMeta,
      rpcUsed: activeRpcUrl,
      mintErr: err || null,
    },
  };
}