// buycaller_bonding.js (ESM) — Pump.fun bonding-curve candidate buyer
// Updates applied:
// (1) Removed uncapped processed_mints helpers (loadProcessedSet/saveProcessedSet) to prevent uncontrolled growth.
// (2) rpcFailed is ONLY true for real RPC/network-ish errors (not for internal logic bugs).
// (3) Stats RPC failures log the actual error instead of swallowing it.

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import PQueue from "p-queue";

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

import { verifyCreatorSafetyPumpfun } from "./tokenCreatorScanner.js";
import { checkTokenSecurity } from "./tokensecurities.js";
import {
  executePumpfunBuyFromBonding,
  resumeWatcherIfBelowMax,
} from "./swapexecutor_pumpfun.js";

import { checkToken2022ExtensionsSafety } from "./token2022ExtensionsGate.js";

dotenv.config();

// ---------------- CONFIG / CONNECTION (FAILOVER ALWAYS) ----------------
const RPC_URL_8 = process.env.RPC_URL_8 || "";
const RPC_URL_9 = process.env.RPC_URL_9 || "";
const COMMITMENT = process.env.COMMITMENT || "confirmed";

const RPC_PRIMARY = RPC_URL_8 || "https://api.mainnet-beta.solana.com";

function pickRpcCandidates() {
  const list = [RPC_URL_8, RPC_URL_9].filter(Boolean);
  if (!list.length) list.push(RPC_PRIMARY);
  return [...new Set(list)];
}

let activeRpcUrl = pickRpcCandidates()[0];
let conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });

function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });
}

class RpcFailoverError extends Error {
  constructor(opName, lastErr) {
    super(
      `[RPC_FAILOVER] ${opName} failed on all RPCs. last=${String(
        lastErr?.message || lastErr || "unknown_error"
      )}`
    );
    this.name = "RpcFailoverError";
    this.opName = opName;
    this.lastErr = lastErr;
  }
}

// rpc-ish classifier (used for non-rpcLimited modules too)
function isRpcishError(e) {
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
    msg.includes("block height exceeded") ||
    msg.includes("rpc") // conservative catch for “rpc error”
  );
}

// Your requirement:
// - ALWAYS try the next RPC on any failure.
// - Only throw after all candidates fail.
async function withRpcFailover(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      return await fn(conn);
    } catch (e) {
      lastErr = e;
      console.log(
        `[RPC_FAILOVER] ${opName} failed on ${url}:`,
        String(e?.message || e)
      );
      continue;
    }
  }

  console.log(
    `[RPC_FAILOVER] ${opName} failed on all RPCs:`,
    String(lastErr?.message || lastErr || "unknown_error")
  );
  throw new RpcFailoverError(opName, lastErr);
}

// ---------------- PQUEUE RATE LIMITER ----------------
const rpcQueue = new PQueue({
  interval: Number(process.env.BUYCALLER_RPC_INTERVAL_MS || 1000),
  intervalCap: Number(process.env.BUYCALLER_RPC_INTERVAL_CAP || 8),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return rpcQueue.add(() => withRpcFailover(opName, fn)).catch((e) => {
    console.log(`[RPC_LIMITED_ERROR] ${opName}:`, String(e?.message || e));
    throw e;
  });
}

// ---------------- RUN MODES ----------------
const BUY_DRY_RUN = process.env.BUY_DRY_RUN === "1";
const MAX_BUYS_PER_RUN = Number(process.env.MAX_BUYS_PER_RUN || 1);

const WINDOW_MINUTES = Number(process.env.BUY_WINDOW_MINUTES || 15);
const SIG_LIMIT = Number(process.env.BUY_SIG_LIMIT || 250);

const DELETE_AFTER_MINUTES = Number(process.env.DELETE_AFTER_MINUTES || 20);

const MIN_BUYS_15M = Number(process.env.MIN_BUYS_15M || 25);
const MIN_UNIQUE_BUYERS_15M = Number(process.env.MIN_UNIQUE_BUYERS_15M || 15);
const MIN_VELOCITY_BUYS_PER_MIN = Number(
  process.env.MIN_VELOCITY_BUYS_PER_MIN || 1.5
);
const MIN_TOKEN_BUY_VOLUME_15M = Number(
  process.env.MIN_TOKEN_BUY_VOLUME_15M || 50_000
);

const MAX_TOP_HOLDER_PCT = Number(process.env.MAX_TOP_HOLDER_PCT || 35);
const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 150);

const CURVE_TARGET_SOL = Number(process.env.CURVE_TARGET_SOL || 85);
const DOM_MIN = Number(process.env.CREATOR_DOMINANCE_WINDOW_MIN_PCT || 1);
const DOM_MAX = Number(process.env.CREATOR_DOMINANCE_WINDOW_MAX_PCT || 50);
const DOM_MAX_SHARE = Number(process.env.CREATOR_DOMINANCE_MAX_SHARE || 0.35);

// ---------------- FILES ----------------
const BONDING_CANDIDATES_FILE = path.resolve(
  process.env.BONDING_OUT_FILE || "./bonding_candidates.json"
);

const PROCESSED_FILE = path.resolve(
  process.env.PROCESSED_MINTS_FILE || "./processed_mints.json"
);

const PROCESSED_MAX = Number(process.env.PROCESSED_MAX || 100);

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

function loadCandidates() {
  const arr = safeReadJson(BONDING_CANDIDATES_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

// (1) processed list ONLY, capped, de-duped
function loadProcessedList() {
  const arr = safeReadJson(PROCESSED_FILE, []);
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (typeof x !== "string" || !x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out.slice(Math.max(0, out.length - PROCESSED_MAX));
}

function saveProcessedList(list) {
  atomicWrite(PROCESSED_FILE, list);
}

function markProcessedMint(list, mint) {
  const next = list.filter((m) => m !== mint);
  next.push(mint);
  return next.slice(Math.max(0, next.length - PROCESSED_MAX));
}

function toPubkey(x) {
  try {
    return new PublicKey(x);
  } catch {
    return null;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------------- candidate TTL pruning ----------------
function candidateAgeSeconds(c) {
  const t = Date.parse(c?.firstSeenAt || c?.detectedAt || "");
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / 1000);
}

function isExpiredCandidate(c) {
  const ageSec = candidateAgeSeconds(c);
  return ageSec >= DELETE_AFTER_MINUTES * 60;
}

function pruneExpiredCandidates(candidates) {
  const keep = [];
  const removed = [];
  for (const c of candidates) {
    if (isExpiredCandidate(c)) removed.push(c);
    else keep.push(c);
  }
  return { keep, removed };
}

// ---------------- Mint program owner gate ----------------
const ALLOW_TOKEN_2022 = process.env.ALLOW_TOKEN_2022 === "1";

async function getMintProgramOwner(mintStr) {
  let mintPub;
  try {
    mintPub = new PublicKey(mintStr);
  } catch {
    return { ok: false, reason: "invalid_pubkey" };
  }

  const info = await rpcLimited("getAccountInfo(mint)", (c) =>
    c.getAccountInfo(mintPub, { commitment: COMMITMENT })
  );

  if (!info) return { ok: false, reason: "account_not_found" };

  const ownerStr = info.owner?.toString?.() || "";
  const isClassic = ownerStr === TOKEN_PROGRAM_ID.toString();
  const is2022 = ownerStr === TOKEN_2022_PROGRAM_ID.toString();

  if (isClassic) return { ok: true, program: "spl-token" };
  if (ALLOW_TOKEN_2022 && is2022) return { ok: true, program: "spl-token-2022" };

  return { ok: false, reason: `not_token_program:${ownerStr}` };
}

// ---------------- START/STOP LOOP (NO overlap ticks) ----------------
const BUY_LOOP_MS = Number(process.env.BUYCALLER_LOOP_MS || 10_000);

let buyTimer = null;
let buyTickRunning = false;

async function runBuyTick(label) {
  if (buyTickRunning) return;

  buyTickRunning = true;
  try {
    const gate = await resumeWatcherIfBelowMax();

    if (!gate?.ok) {
      if (buyTimer) {
        clearInterval(buyTimer);
        buyTimer = null;
      }
      console.log("[buyCaller] stopped", {
        reason: `max_entry_reached:${gate?.count ?? "unknown"}`,
      });
      return;
    }

    await runBuyCallerOnce();
  } catch (err) {
    console.error(`[buyCaller] ${label} error:`, String(err?.message || err));
  } finally {
    buyTickRunning = false;
  }
}

export function startBuyCaller() {
  if (buyTimer) return;

  console.log("[buyCaller] started", { BUY_LOOP_MS });

  void runBuyTick("initial tick");

  buyTimer = setInterval(() => {
    void runBuyTick("loop tick");
  }, BUY_LOOP_MS);
}

export async function stopBuyCaller(reason = "manual") {
  if (!buyTimer) return;

  clearInterval(buyTimer);
  buyTimer = null;

  while (buyTickRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[buyCaller] stopped", { reason });
}

export const startBuyCallerLoop = startBuyCaller;
export const stopBuyCallerLoop = stopBuyCaller;

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startBuyCaller();
}

// ---------------- Creator Dominance helpers ----------------
function num(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function getCurveProgressPct(candidate) {
  const rawCurveSol = candidate?.solLiquidity ?? candidate?.curveSol ?? null;
  const curveSol = num(rawCurveSol, NaN);
  const target = num(CURVE_TARGET_SOL, 85);

  if (!Number.isFinite(curveSol) || curveSol <= 0 || !Number.isFinite(target) || target <= 0) {
    return null;
  }

  return (curveSol / target) * 100;
}

function extractCreatorWallets(creatorRes) {
  const wallets = new Set();

  const maybe = [
    creatorRes?.creator,
    creatorRes?.deployer,
    creatorRes?.owner,
    creatorRes?.wallet,
    creatorRes?.details?.creator,
    creatorRes?.details?.deployer,
    creatorRes?.resolver?.creator,
    creatorRes?.resolver?.deployer,
  ];

  for (const w of maybe) {
    if (typeof w === "string" && w.length > 20) wallets.add(w);
  }

  const arr =
    creatorRes?.relatedWallets ||
    creatorRes?.wallets ||
    creatorRes?.details?.wallets;

  if (Array.isArray(arr)) {
    for (const w of arr) {
      if (typeof w === "string" && w.length > 20) wallets.add(w);
    }
  }

  return Array.from(wallets);
}

function computeDominanceStats({ deltasByOwner, totalDelta, creatorWallets }) {
  if (!totalDelta || totalDelta <= 0) {
    return {
      ok: false,
      totalDelta: 0,
      creatorDelta: 0,
      creatorShare: 0,
      top1Share: 1,
      top3Share: 1,
      uniqueBuyers: 0,
    };
  }

  const entries = Object.entries(deltasByOwner || {});
  entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));

  const top1 = entries[0]?.[1] || 0;
  const top3 =
    (entries[0]?.[1] || 0) + (entries[1]?.[1] || 0) + (entries[2]?.[1] || 0);

  const creatorSet = new Set(creatorWallets || []);
  let creatorDelta = 0;

  for (const [owner, delta] of entries) {
    if (creatorSet.has(owner)) creatorDelta += num(delta, 0);
  }

  return {
    ok: true,
    totalDelta,
    creatorDelta,
    creatorShare: creatorDelta / totalDelta,
    top1Share: top1 / totalDelta,
    top3Share: top3 / totalDelta,
    uniqueBuyers: entries.length,
  };
}

// ---------------- core metrics ----------------
async function getBuysInWindow(mintStr, windowStartSec, sigLimit = SIG_LIMIT) {
  const mintPub = toPubkey(mintStr);

  if (!mintPub) {
    return {
      buyCount: 0,
      uniqueBuyers: 0,
      tokenBuyVolume: 0,
      oldestTs: null,
      newestTs: null,
      deltasByOwner: {},
      totalDelta: 0,
      rpcError: false,
    };
  }

  const sigs = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
    c.getSignaturesForAddress(mintPub, { limit: Math.min(sigLimit, 1000) })
  );

  if (!Array.isArray(sigs)) {
    return {
      buyCount: 0,
      uniqueBuyers: 0,
      tokenBuyVolume: 0,
      oldestTs: null,
      newestTs: null,
      deltasByOwner: {},
      totalDelta: 0,
      rpcError: true,
    };
  }

  let buyCount = 0;
  let tokenBuyVolume = 0;
  const buyers = new Set();
  let oldestTs = null;
  let newestTs = null;

  const deltasByOwner = {};
  let totalDelta = 0;

  for (const s of sigs) {
    const bt = typeof s?.blockTime === "number" ? s.blockTime : null;
    if (!bt) continue;
    if (bt < windowStartSec) break;

    const sig = s?.signature;
    if (!sig) continue;

    const tx = await rpcLimited("getParsedTransaction(sig)", (c) =>
      c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })
    );

    if (!tx?.meta) continue;

    const pre = Array.isArray(tx.meta.preTokenBalances) ? tx.meta.preTokenBalances : [];
    const post = Array.isArray(tx.meta.postTokenBalances) ? tx.meta.postTokenBalances : [];

    for (const p of post) {
      if (!p || p.mint !== mintStr) continue;

      const postAmt =
        typeof p.uiTokenAmount?.uiAmount === "number"
          ? p.uiTokenAmount.uiAmount
          : Number(p.uiTokenAmount?.uiAmountString || 0);

      const prev = pre.find((x) => x.accountIndex === p.accountIndex) || null;

      const prevAmt = prev
        ? typeof prev.uiTokenAmount?.uiAmount === "number"
          ? prev.uiTokenAmount.uiAmount
          : Number(prev.uiTokenAmount?.uiAmountString || 0)
        : 0;

      const delta = postAmt - prevAmt;

      if (delta > 0) {
        buyCount += 1;
        tokenBuyVolume += delta;
        totalDelta += delta;

        const owner =
          p.owner ||
          (typeof p.accountIndex === "number"
            ? tx.transaction?.message?.accountKeys?.[p.accountIndex]?.pubkey
                ?.toString?.() ||
              tx.transaction?.message?.accountKeys?.[p.accountIndex]?.toString?.() ||
              null
            : null);

        if (owner) {
          buyers.add(owner);
          deltasByOwner[owner] = (deltasByOwner[owner] || 0) + delta;
        }

        if (!newestTs || bt > newestTs) newestTs = bt;
        if (!oldestTs || bt < oldestTs) oldestTs = bt;
      }
    }
  }

  return {
    buyCount,
    uniqueBuyers: buyers.size,
    tokenBuyVolume,
    oldestTs,
    newestTs,
    deltasByOwner,
    totalDelta,
    rpcError: false,
  };
}

async function getTopHolderPct(mintStr) {
  const mintPub = toPubkey(mintStr);
  if (!mintPub) return { ok: false, pct: 100, reason: "invalid_mint" };

  const mintInfo = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mintPub)
  );

  const supplyStr = mintInfo?.value?.data?.parsed?.info?.supply || "0";
  const supply = Number(supplyStr);
  if (!Number.isFinite(supply) || supply <= 0) {
    return { ok: false, pct: 100, reason: "supply_unknown" };
  }

  const largest = await rpcLimited("getTokenLargestAccounts(mint)", (c) =>
    c.getTokenLargestAccounts(mintPub)
  );

  const top = largest?.value?.[0];
  if (!top?.amount) return { ok: false, pct: 100, reason: "no_largest_accounts" };

  const topAmt = Number(top.amount);
  if (!Number.isFinite(topAmt) || topAmt <= 0) {
    return { ok: false, pct: 100, reason: "top_amount_invalid" };
  }

  const pct = (topAmt / supply) * 100;
  return { ok: true, pct };
}

function computeVelocity(buyCount, oldestTs, newestTs, windowStartSec) {
  const end = newestTs || nowSec();
  const start = oldestTs || windowStartSec;
  const spanMin = Math.max(1 / 60, (end - start) / 60);
  return buyCount / spanMin;
}

function passesActivityFilters({ buyCount, uniqueBuyers, tokenBuyVolume, velocity }) {
  const reasons = [];
  if (buyCount < MIN_BUYS_15M) reasons.push(`buyCount<${MIN_BUYS_15M}`);
  if (uniqueBuyers < MIN_UNIQUE_BUYERS_15M) reasons.push(`uniqueBuyers<${MIN_UNIQUE_BUYERS_15M}`);
  if (velocity < MIN_VELOCITY_BUYS_PER_MIN) reasons.push(`velocity<${MIN_VELOCITY_BUYS_PER_MIN}`);
  if (tokenBuyVolume < MIN_TOKEN_BUY_VOLUME_15M) reasons.push(`tokenBuyVolume<${MIN_TOKEN_BUY_VOLUME_15M}`);
  return { ok: reasons.length === 0, reasons };
}

// ---------------- main exported function ----------------
export async function runBuyCallerOnce() {
  // processed (capped)
  let processedList = loadProcessedList();
  const processedSet = new Set(processedList);

  // candidates
  const allCandidates = loadCandidates();

  // remove expired first
  const { keep: candidates, removed } = pruneExpiredCandidates(allCandidates);
  if (removed.length) {
    console.log(
      `[PRUNE] removed=${removed.length} older than ${DELETE_AFTER_MINUTES} min`
    );
  }

  // newest first
  candidates.sort((a, b) => {
    const ta = Date.parse(a?.firstSeenAt || a?.detectedAt || "") || 0;
    const tb = Date.parse(b?.firstSeenAt || b?.detectedAt || "") || 0;
    return tb - ta;
  });

  let buysDone = 0;

  // rebuild nextCandidates for full control
  const nextCandidates = [];

  for (const c of candidates) {
    const mint = c?.mint;
    if (!mint) continue;

    // always drop these first (prevents pile)
    if (processedSet.has(mint)) continue;
    if (isExpiredCandidate(c)) continue;

    // if max buys hit, keep candidate for later (still within TTL)
    if (buysDone >= MAX_BUYS_PER_RUN) {
      nextCandidates.push(c);
      continue;
    }

    console.log(
      `\n[BUY-CHECK] mint=${mint} curveSol=${c?.solLiquidity ?? c?.curveSol ?? "?"}`
    );

    const keepForRetry = () => {
      if (!isExpiredCandidate(c)) nextCandidates.push(c);
    };

    // -------- Mint program owner gate --------
    let mintProg;
    try {
      mintProg = await getMintProgramOwner(mint);
    } catch (e) {
      console.log(`[RPC] getMintProgramOwner failed:`, String(e?.message || e));
      keepForRetry();
      continue;
    }

    if (!mintProg?.ok) {
      console.log(`[FAIL] mint program owner: ${mintProg?.reason}`);
      continue;
    }

    // -------- Token-2022 TLV extensions gate --------
    if (mintProg.program === "spl-token-2022") {
      let extGate;
      try {
        extGate = await rpcLimited("token2022ExtensionsGate(getMint)", (cc) =>
          checkToken2022ExtensionsSafety(cc, mint, {
            denyTypes: [1, 6, 9, 12, 14],
            allowlistOnly: true,
            allowTypes: [16, 17, 18, 19],
            commitment: COMMITMENT,
          })
        );
      } catch (e) {
        console.log(`[RPC] token-2022 ext gate failed:`, String(e?.message || e));
        keepForRetry();
        continue;
      }

      if (!extGate?.ok) {
        console.log(`[FAIL] token-2022 extensions: ${extGate?.reason || "denied"}`);
        continue;
      }
    }

    // -------- Creator safety --------
    const creatorRes = await verifyCreatorSafetyPumpfun(mint).catch((e) => ({
      safe: false,
      rpcFailed: isRpcishError(e),
      reasons: String(e?.message || e || "creator_check_failed"),
    }));

    if (!creatorRes?.safe) {
      if (creatorRes.rpcFailed) {
        console.log(`[RPC] creator check failed, will retry later:`, String(creatorRes.reasons || ""));
        keepForRetry();
        continue;
      }
      console.log("[FAIL] creator security:", creatorRes?.reasons || creatorRes);
      continue;
    }

    // -------- Token security --------
    const tokenRes = await checkTokenSecurity(mint).catch((e) => ({
      safe: false,
      rpcFailed: isRpcishError(e),
      reasons: String(e?.message || e || "token_security_failed"),
    }));

    if (!tokenRes?.safe) {
      if (tokenRes.rpcFailed) {
        console.log(`[RPC] token security failed, will retry later:`, String(tokenRes.reasons || ""));
        keepForRetry();
        continue;
      }
      console.log("[FAIL] token security:", tokenRes?.reasons || tokenRes);
      continue;
    }

    // -------- Holder check --------
    const holder = await getTopHolderPct(mint).catch((e) => ({
      ok: false,
      rpcFailed: isRpcishError(e),
      reason: String(e?.message || e || "holder_check_failed"),
    }));

    if (!holder.ok) {
      if (holder.rpcFailed) {
        console.log(`[RPC] holder check failed, will retry later:`, String(holder.reason || ""));
        keepForRetry();
        continue;
      }
      console.log(`[FAIL] holder check: ${holder.reason}`);
      continue;
    }

    if (holder.pct > MAX_TOP_HOLDER_PCT) {
      console.log(
        `[FAIL] top holder too high: ${holder.pct.toFixed(2)}% > ${MAX_TOP_HOLDER_PCT}%`
      );
      continue;
    }

    // -------- Activity window + stats --------
    const seenTs = Date.parse(c?.firstSeenAt || c?.detectedAt || "");
    const seenSec = Number.isFinite(seenTs) ? Math.floor(seenTs / 1000) : 0;
    const windowStartSec = Math.max(nowSec() - WINDOW_MINUTES * 60, seenSec || 0);

    const stats = await getBuysInWindow(mint, windowStartSec, SIG_LIMIT).catch((e) => {
      console.log("[RPC] stats fetch failed:", String(e?.message || e));
      return { rpcError: true };
    });

    if (stats.rpcError) {
      console.log("[RPC] stats fetch failed, will retry later");
      keepForRetry();
      continue;
    }

    const velocity = computeVelocity(
      stats.buyCount,
      stats.oldestTs,
      stats.newestTs,
      windowStartSec
    );

    const verdict = passesActivityFilters({
      buyCount: stats.buyCount,
      uniqueBuyers: stats.uniqueBuyers,
      tokenBuyVolume: stats.tokenBuyVolume,
      velocity,
    });

    if (!verdict.ok) {
      console.log(`[FAIL] activity filters: ${verdict.reasons.join(", ")}`);
      continue;
    }

    // -------- BUY --------
    if (BUY_DRY_RUN) {
      console.log(`[BUY-DRY-RUN] buy skipped for ${mint}`);
      buysDone += 1;
      processedList = markProcessedMint(processedList, mint);
      processedSet.add(mint);
      continue;
    }

    const buyRes = await executePumpfunBuyFromBonding({
      candidate: c,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    }).catch((e) => ({
      ok: false,
      rpcFailed: isRpcishError(e),
      error: String(e?.message || e || "buy_failed"),
    }));

    const sig = buyRes?.signature || null;

    if (!sig) {
      if (buyRes.rpcFailed) {
        console.log("[RPC] buy call failed, will retry later:", String(buyRes.error || ""));
        keepForRetry();
        continue;
      }
      console.log(`[FAIL] buy failed for ${mint}`, String(buyRes?.error || ""));
      continue;
    }

    console.log(`[BOUGHT] ${mint} tx=${sig}`);
    buysDone += 1;

    processedList = markProcessedMint(processedList, mint);
    processedSet.add(mint);
  }

  // write back controlled lists
  atomicWrite(BONDING_CANDIDATES_FILE, nextCandidates);
  saveProcessedList(processedList);

  return { ok: true, buysDone, keptCandidates: nextCandidates.length };
}
