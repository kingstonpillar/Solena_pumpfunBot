// verifyTokenSecurity.js (ESM)
// Same logic as your file.
// Changes:
// - RPC failover: RPC_URL -> RPC_URL_3 -> RPC_URL_4
// - PQueue rate limiting
// - REMOVE LP burn requirement
// - REPLACE LP burn scoring (+30) with honeypotRiskGate(mintPub) (+30)

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import PQueue from "p-queue";

// ---------------- RPC FAILOVER ----------------
// Priority order: RPC_URL_3 -> RPC_URL_4
const RPC_URL_3 = process.env.RPC_URL_3;
const RPC_URL_4 = process.env.RPC_URL_4;

const RPC_ENDPOINTS = [RPC_URL_3, RPC_URL_4].filter(Boolean);

if (!RPC_ENDPOINTS.length) {
  throw new Error("Missing RPC_URL_3 / RPC_URL_4 in env");
}

const COMMITMENT = "confirmed";

let activeRpcUrl = RPC_PRIMARY;
let conn = new Connection(activeRpcUrl, COMMITMENT);

function pickRpcCandidates() {
  const list = [RPC_PRIMARY, RPC_URL_3, RPC_URL_4].filter(Boolean);
  return [...new Set(list)];
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
    msg.includes("block height exceeded") ||
    msg.includes("node is behind")
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
const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return q.add(() => withRpcFailover(opName, fn));
}

// ---------------- PROGRAM IDS (UNCHANGED) ----------------
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const RAYDIUM_AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

// ---------------- SETTINGS (UNCHANGED except LP burn removed) ----------------
const SIG_LIMIT_MINT_SCAN = 120;
const SAFE_THRESHOLD = 80;
const TOP10_MAX_PCT = 0.35;

// ---------------- HELPERS (UNCHANGED) ----------------
function safeNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAccountKeys(message) {
  const ak = message?.accountKeys;
  if (!Array.isArray(ak)) return [];
  return ak.map((k) => (k?.pubkey ? k.pubkey : k)).filter(Boolean);
}

function txTouchesProgramFromParsed(tx, programId) {
  const msg = tx?.transaction?.message;
  if (!msg) return false;

  const keys = normalizeAccountKeys(msg);
  if (keys.length === 0) return false;

  const target = programId.toBase58();

  const programIdAt = (idx) => {
    const pk = keys[idx];
    if (!pk) return null;
    return pk.toBase58 ? pk.toBase58() : String(pk);
  };

  const check = (ix) => {
    if (!ix || typeof ix.programIdIndex !== "number") return false;
    return programIdAt(ix.programIdIndex) === target;
  };

  const outer = Array.isArray(msg.instructions) ? msg.instructions : [];
  if (outer.some(check)) return true;

  const innerGroups = Array.isArray(tx?.meta?.innerInstructions)
    ? tx.meta.innerInstructions
    : [];

  for (const g of innerGroups) {
    const inner = Array.isArray(g?.instructions) ? g.instructions : [];
    if (inner.some(check)) return true;
  }

  return false;
}

async function getParsedTx(sig) {
  try {
    return await rpcLimited("getParsedTransaction", (c) =>
      c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 })
    );
  } catch {
    return null;
  }
}

async function getMintAuthorities(mintPub) {
  let mintAuthority = null;
  let freezeAuthority = null;

  try {
    const mintInfo = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
      c.getParsedAccountInfo(mintPub)
    );

    const parsed = mintInfo?.value?.data?.parsed?.info || {};

    mintAuthority = parsed?.mintAuthority ?? null;
    freezeAuthority = parsed?.freezeAuthority ?? null;

    if (mintAuthority === "11111111111111111111111111111111") mintAuthority = null;
    if (freezeAuthority === "11111111111111111111111111111111") freezeAuthority = null;
  } catch {}

  return { mintAuthority, freezeAuthority };
}

// Scan mint txs. Confirm pump.fun origin, detect migration tx, and attempt to extract LP mint.
// Kept as-is, but lpMint is no longer required.
async function findPumpfunAndMigration(mintPub) {
  const mintStr = mintPub.toBase58();

  let sigInfos = [];
  try {
    sigInfos = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
      c.getSignaturesForAddress(mintPub, { limit: SIG_LIMIT_MINT_SCAN })
    );
  } catch {
    sigInfos = [];
  }

  let isPumpFun = false;
  let migration = null;
  let lpMint = null;

  for (const s of sigInfos || []) {
    const sig = s?.signature;
    if (!sig) continue;

    const tx = await getParsedTx(sig);
    if (!tx) continue;

    if (!isPumpFun && txTouchesProgramFromParsed(tx, PUMP_PROGRAM_ID)) {
      isPumpFun = true;
    }

    const touchesRaydium =
      txTouchesProgramFromParsed(tx, RAYDIUM_AMM_V4) ||
      txTouchesProgramFromParsed(tx, RAYDIUM_CPMM);

    if (touchesRaydium && !migration) {
      migration = {
        signature: sig,
        slot: tx.slot,
        blockTime: typeof tx.blockTime === "number" ? tx.blockTime : null,
      };

      const pre = new Set(
        (tx.meta?.preTokenBalances || []).map((b) => b?.mint).filter(Boolean)
      );
      const post = new Set(
        (tx.meta?.postTokenBalances || []).map((b) => b?.mint).filter(Boolean)
      );

      const candidates = [];
      for (const m of post) {
        if (!pre.has(m) && m !== mintStr) candidates.push(m);
      }
      lpMint = candidates[0] || null;
    }

    if (isPumpFun && migration) break;
  }

  return { isPumpFun, migration, lpMint };
}

// Optional distribution check
async function top10Concentration(mintPub) {
  try {
    const largest = await rpcLimited("getTokenLargestAccounts(mint)", (c) =>
      c.getTokenLargestAccounts(mintPub)
    );
    const arr = Array.isArray(largest?.value) ? largest.value : [];
    if (arr.length === 0) return { ok: false, pct: 1, reason: "no_holders" };

    const top10 = arr.slice(0, 10).map((x) => safeNumber(x.uiAmountString, 0));
    const top10Sum = top10.reduce((a, b) => a + b, 0);

    const supplyResp = await rpcLimited("getTokenSupply(mint)", (c) =>
      c.getTokenSupply(mintPub)
    );
    const supplyUi = safeNumber(supplyResp?.value?.uiAmountString, 0);
    if (!supplyUi || supplyUi <= 0) return { ok: false, pct: 1, reason: "supply_zero" };

    const pct = top10Sum / supplyUi;
    return { ok: pct <= TOP10_MAX_PCT, pct, supplyUi, top10Sum };
  } catch {
    return { ok: false, pct: 1, reason: "top10_check_failed" };
  }
}

// ---------------- NEW: Honeypot risk gate (replaces LP burn) ----------------
async function honeypotRiskGate(mintPub) {
  // 1) Freeze authority must be null
  // 2) Token-2022 dangerous extensions hard fail (and fail-closed on token2022)

  const parsedMintInfo = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mintPub)
  ).catch(() => null);

  const parsed = parsedMintInfo?.value?.data?.parsed?.info || {};
  let freezeAuthority = parsed?.freezeAuthority ?? null;

  if (freezeAuthority === "11111111111111111111111111111111") freezeAuthority = null;
  if (freezeAuthority) {
    return { ok: false, reason: `freeze_authority_present:${freezeAuthority}` };
  }

  const rawInfo = await rpcLimited("getAccountInfo(mint)", (c) =>
    c.getAccountInfo(mintPub)
  ).catch(() => null);

  const ownerStr = rawInfo?.owner?.toBase58?.() || null;
  const isToken2022 = ownerStr === TOKEN_2022_PROGRAM_ID.toBase58();

  const extensions = Array.isArray(parsed?.extensions) ? parsed.extensions : [];
  const extStrings = extensions.map((x) => String(x).toLowerCase());

  const dangerous =
    extStrings.some((e) => e.includes("transferhook")) ||
    extStrings.some((e) => e.includes("confidential")) ||
    extStrings.some((e) => e.includes("defaultaccountstate")) ||
    extStrings.some((e) => e.includes("nontransferable")) ||
    extStrings.some((e) => e.includes("transferfee")) ||
    extStrings.some((e) => e.includes("withheld"));

  if (isToken2022 && dangerous) {
    return { ok: false, reason: `token2022_dangerous_extensions:${extStrings.join(",") || "unknown"}` };
  }

  if (isToken2022) {
    return { ok: false, reason: "token2022_blocked_pre_migration" };
  }

  const isTokenProgram = ownerStr === TOKEN_PROGRAM_ID.toBase58();
  if (!isTokenProgram) {
    return { ok: false, reason: `unknown_token_program_owner:${ownerStr || "null"}` };
  }

  return { ok: true, reason: "sellability_risk_ok" };
}

// ---------------- EXPORTED (LOGIC UNCHANGED except step-3 replacement) ----------------
export async function verifyTokenSecurity(mint) {
  const reasons = [];
  let score = 0;

  const mintPub = (() => {
    try {
      return new PublicKey(mint);
    } catch {
      return null;
    }
  })();

  if (!mintPub) return { safe: false, score: 0, reasons: ["Invalid mint"], details: {} };

  // 1) Pump.fun origin + migration + LP mint discovery
  const { isPumpFun, migration, lpMint } = await findPumpfunAndMigration(mintPub);

  if (!isPumpFun) {
    return { safe: false, score: 0, reasons: ["Not a Pump.fun mint"], details: { isPumpFun } };
  }
  score += 20;
  reasons.push("pumpfun_origin");

  if (!migration) {
    return {
      safe: false,
      score: 0,
      reasons: ["Not migrated to Raydium yet"],
      details: { isPumpFun, migration: null },
    };
  }
  score += 20;
  reasons.push("migrated");

  // 2) Mint authority and freeze authority must be null
  const { mintAuthority, freezeAuthority } = await getMintAuthorities(mintPub);

  if (mintAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`mint authority NOT renounced -> ${mintAuthority}`],
      details: { mintAuthority, freezeAuthority },
    };
  }
  score += 15;
  reasons.push("mint_authority_null");

  if (freezeAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`freeze authority NOT renounced -> ${freezeAuthority}`],
      details: { mintAuthority, freezeAuthority },
    };
  }
  score += 10;
  reasons.push("freeze_authority_null");

  // 3) REPLACEMENT: Honeypot risk gate (same score weight as LP burn was)
  const hp = await honeypotRiskGate(mintPub);
  if (!hp.ok) {
    return {
      safe: false,
      score: 0,
      reasons: [`honeypot_risk_gate_fail (${hp.reason})`],
      details: { isPumpFun, migration, lpMint, honeypotGate: hp },
    };
  }

  score += 30;
  reasons.push("honeypot_risk_gate_ok");

  // 4) Optional distribution score (not a hard fail)
  const dist = await top10Concentration(mintPub);
  if (dist.ok) {
    score += 5;
    reasons.push(`top10_ok_${dist.pct.toFixed(4)}`);
  } else {
    reasons.push(`top10_high_${dist.pct.toFixed(4)}`);
  }

  if (score > 100) score = 100;
  const safe = score >= SAFE_THRESHOLD;

  return {
    safe,
    score,
    reasons,
    details: {
      isPumpFun,
      migration,
      lpMint, // kept for debug only
      distribution: dist,
      honeypotGate: hp,
      rpcUsed: activeRpcUrl, // optional debug
    },
  };
}