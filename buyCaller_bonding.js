// buycaller_bonding.js (ESM) — Pump.fun bonding-curve candidate buyer
// Same logic as your file.
// Adds only:
// - RPC failover: RPC_URL_8 -> RPC_URL_9
// - PQueue rate limiting for ALL RPC calls

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import PQueue from "p-queue";
import { Connection, PublicKey } from "@solana/web3.js";

import { verifyCreatorSafetyPumpfun } from "./tokenCreatorScanner.js";
import { verifyTokenSecurity } from "./tokensecurities.js";

import {
  executePumpfunBuyFromBonding,
  resumeWatcherIfBelowMax,
  isWatcherActive,
} from "./swapexecutor_pumpfun.js";

dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL_8 = process.env.RPC_URL_8 || "";
const RPC_URL_9 = process.env.RPC_URL_9 || "";

const COMMITMENT = "confirmed";

// keep your previous fallback behavior but ONLY for safety if env is missing
const RPC_PRIMARY =
  RPC_URL_8 ||
  "https://api.mainnet-beta.solana.com";

let activeRpcUrl = RPC_PRIMARY;
let conn = new Connection(activeRpcUrl, COMMITMENT);

function pickRpcCandidates() {
  const list = [RPC_URL_8, RPC_URL_9].filter(Boolean);
  // if user forgot to set env, still run using default public rpc
  if (list.length === 0) list.push(RPC_PRIMARY);
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
  throw new Error(`[RPC_FAILOVER] ${opName} failed. last=${msg}`);
}

// ---- buys per run ----
const MAX_BUYS_PER_RUN = Number(process.env.MAX_BUYS_PER_RUN || 1);

// ---- activity window ----
const WINDOW_MINUTES = Number(process.env.BUY_WINDOW_MINUTES || 15);
const SIG_LIMIT = Number(process.env.BUY_SIG_LIMIT || 250);

// ---- delete window ----
const DELETE_AFTER_MINUTES = Number(process.env.DELETE_AFTER_MINUTES || 20);

// ---- filters ----
const MIN_BUYS_15M = Number(process.env.MIN_BUYS_15M || 25);
const MIN_UNIQUE_BUYERS_15M = Number(process.env.MIN_UNIQUE_BUYERS_15M || 15);
const MIN_VELOCITY_BUYS_PER_MIN = Number(process.env.MIN_VELOCITY_BUYS_PER_MIN || 1.5);
const MIN_TOKEN_BUY_VOLUME_15M = Number(process.env.MIN_TOKEN_BUY_VOLUME_15M || 50_000);

// holder compatibility kill switch
const MAX_TOP_HOLDER_PCT = Number(process.env.MAX_TOP_HOLDER_PCT || 35);

// slippage passed to executor
const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 150);

// ---------------- FILES ----------------
const BONDING_CANDIDATES_FILE = path.resolve(
  process.env.BONDING_OUT_FILE || "./bonding_candidates.json"
);

const PROCESSED_FILE = path.resolve(
  process.env.PROCESSED_MINTS_FILE || "./processed_mints.json"
);

// ---------------- PQUEUE RATE LIMITER ----------------
const rpcQueue = new PQueue({
  interval: Number(process.env.BUYCALLER_RPC_INTERVAL_MS || 1000),
  intervalCap: Number(process.env.BUYCALLER_RPC_INTERVAL_CAP || 8),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return rpcQueue.add(() => withRpcFailover(opName, fn));
}

// ---------------- START/STOP LOOP (unchanged) ----------------
const BUY_LOOP_MS = Number(process.env.BUYCALLER_LOOP_MS || 10_000);

let buyTimer = null;
let buyTickRunning = false;

export function startBuyCallerLoop() {
  if (buyTimer) return;
  console.log(" buyCaller loop started");
  tickBuyCaller();
  buyTimer = setInterval(tickBuyCaller, BUY_LOOP_MS);
}

export function stopBuyCallerLoop(reason = "manual") {
  if (!buyTimer) return;
  clearInterval(buyTimer);
  buyTimer = null;
  console.log(` buyCaller loop stopped (${reason})`);
}

async function tickBuyCaller() {
  if (buyTickRunning) return;
  buyTickRunning = true;

  try {
    const gate = await resumeWatcherIfBelowMax();

    if (!gate.ok) {
      stopBuyCallerLoop(`max_entry_reached:${gate.count}`);
      return;
    }

    if (!isWatcherActive()) {
      stopBuyCallerLoop("watcher_inactive");
      return;
    }

    await runBuyCallerOnce();
  } catch (e) {
    console.log("[BUY_CALLER_TICK_ERROR]", e?.message || e);
  } finally {
    buyTickRunning = false;
  }
}

// ---------------- file helpers (unchanged) ----------------
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

function loadProcessedSet() {
  const arr = safeReadJson(PROCESSED_FILE, []);
  return new Set((Array.isArray(arr) ? arr : []).filter(Boolean));
}

function saveProcessedSet(set) {
  atomicWrite(PROCESSED_FILE, Array.from(set));
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

// ---------------- candidate TTL pruning (unchanged) ----------------
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

// ---------------- core metrics (RPC calls routed via rpcLimited) ----------------
async function getBuysInWindow(mintStr, windowStartSec, sigLimit = SIG_LIMIT) {
  const mintPub = toPubkey(mintStr);
  if (!mintPub) {
    return { buyCount: 0, uniqueBuyers: 0, tokenBuyVolume: 0, oldestTs: null, newestTs: null };
  }

  const sigs = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
    c.getSignaturesForAddress(mintPub, { limit: Math.min(sigLimit, 1000) })
  ).catch(() => []);

  let buyCount = 0;
  let tokenBuyVolume = 0;
  const buyers = new Set();
  let oldestTs = null;
  let newestTs = null;

  for (const s of sigs || []) {
    const bt = typeof s?.blockTime === "number" ? s.blockTime : null;
    if (!bt) continue;
    if (bt < windowStartSec) break;

    const sig = s.signature;
    if (!sig) continue;

    const tx = await rpcLimited("getParsedTransaction(sig)", (c) =>
      c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })
    ).catch(() => null);

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

        const owner =
          p.owner ||
          (typeof p.accountIndex === "number"
            ? tx.transaction?.message?.accountKeys?.[p.accountIndex]?.pubkey?.toString?.() ||
              tx.transaction?.message?.accountKeys?.[p.accountIndex]?.toString?.() ||
              null
            : null);

        if (owner) buyers.add(owner);

        if (!newestTs || bt > newestTs) newestTs = bt;
        if (!oldestTs || bt < oldestTs) oldestTs = bt;
      }
    }
  }

  return { buyCount, uniqueBuyers: buyers.size, tokenBuyVolume, oldestTs, newestTs };
}

async function getTopHolderPct(mintStr) {
  const mintPub = toPubkey(mintStr);
  if (!mintPub) return { ok: false, pct: 100, reason: "invalid_mint" };

  const mintInfo = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mintPub)
  ).catch(() => null);

  const supplyStr = mintInfo?.value?.data?.parsed?.info?.supply || "0";
  const supply = Number(supplyStr);
  if (!Number.isFinite(supply) || supply <= 0) {
    return { ok: false, pct: 100, reason: "supply_unknown" };
  }

  const largest = await rpcLimited("getTokenLargestAccounts(mint)", (c) =>
    c.getTokenLargestAccounts(mintPub)
  ).catch(() => null);

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

// ---------------- main exported function (logic unchanged) ----------------
export async function runBuyCallerOnce() {
  const processed = loadProcessedSet();

  const allCandidates = loadCandidates();
  const { keep: candidates, removed } = pruneExpiredCandidates(allCandidates);
  if (removed.length > 0) {
    console.log(`[PRUNE] removed=${removed.length} older than ${DELETE_AFTER_MINUTES} min`);
    atomicWrite(BONDING_CANDIDATES_FILE, candidates);
  }

  candidates.sort((a, b) => {
    const ta = Date.parse(a?.firstSeenAt || a?.detectedAt || "") || 0;
    const tb = Date.parse(b?.firstSeenAt || b?.detectedAt || "") || 0;
    return tb - ta;
  });

  let buysDone = 0;

  for (const c of candidates) {
    if (buysDone >= MAX_BUYS_PER_RUN) break;

    const mint = c?.mint;
    if (!mint) continue;
    if (processed.has(mint)) continue;

    console.log(`\n[BUY-CHECK] mint=${mint} curveSol=${c?.solLiquidity ?? "?"}`);

    const creatorRes = await verifyCreatorSafetyPumpfun(mint).catch(() => null);
    if (!creatorRes?.safe) {
      console.log("[FAIL] creator security:", creatorRes?.reasons || creatorRes);
      processed.add(mint);
      continue;
    }

    const tokenRes = await verifyTokenSecurity(mint).catch(() => null);
    if (!tokenRes?.safe) {
      console.log("[FAIL] token security:", tokenRes?.reasons || tokenRes);
      processed.add(mint);
      continue;
    }

    const holder = await getTopHolderPct(mint);
    if (!holder.ok) {
      console.log(`[FAIL] holder check: ${holder.reason}`);
      processed.add(mint);
      continue;
    }
    if (holder.pct > MAX_TOP_HOLDER_PCT) {
      console.log(`[FAIL] top holder too high: ${holder.pct.toFixed(2)}% > ${MAX_TOP_HOLDER_PCT}%`);
      processed.add(mint);
      continue;
    }

    const seenTs = Date.parse(c?.firstSeenAt || c?.detectedAt || "");
    const seenSec = Number.isFinite(seenTs) ? Math.floor(seenTs / 1000) : 0;
    const windowStartSec = Math.max(nowSec() - WINDOW_MINUTES * 60, seenSec || 0);

    const stats = await getBuysInWindow(mint, windowStartSec, SIG_LIMIT);
    const velocity = computeVelocity(stats.buyCount, stats.oldestTs, stats.newestTs, windowStartSec);

    const verdict = passesActivityFilters({
      buyCount: stats.buyCount,
      uniqueBuyers: stats.uniqueBuyers,
      tokenBuyVolume: stats.tokenBuyVolume,
      velocity,
    });

    console.log(
      `[STATS] buys=${stats.buyCount} unique=${stats.uniqueBuyers} volTok=${stats.tokenBuyVolume.toFixed(
        2
      )} velocity=${velocity.toFixed(2)}/min topHolder=${holder.pct.toFixed(2)}% rpc=${activeRpcUrl}`
    );

    if (!verdict.ok) {
      console.log(`[FAIL] activity filters: ${verdict.reasons.join(", ")}`);
      processed.add(mint);
      continue;
    }

    console.log(`[PASS] Buying on bonding curve: ${mint}`);

    const buyRes = await executePumpfunBuyFromBonding({
      candidate: c,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    }).catch(() => null);

    const sig = buyRes?.signature || null;

    if (!sig) {
      console.log(`[FAIL] buy failed for ${mint}`);
      processed.add(mint);
      continue;
    }

    console.log(`[BOUGHT] ${mint} tx=${sig}`);
    buysDone += 1;
    processed.add(mint);
  }

  saveProcessedSet(processed);
  return { ok: true, buysDone };
}