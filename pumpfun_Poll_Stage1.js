// pumpfun_poll_stage1_bonding_50pct.js (ESM)
// Stage-1 Pump.fun bonding detector
// Discovery + in-memory watchlist for >=50% curve tokens

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

dotenv.config();

// ---------------- RPC FAILOVER ----------------
const RPC_URL_1 = process.env.RPC_URL_1 || "";
const RPC_URL_2 = process.env.RPC_URL_2 || "";

const RPC_ENDPOINTS = [RPC_URL_1, RPC_URL_2].filter(Boolean);

if (RPC_ENDPOINTS.length === 0) {
  throw new Error("No RPC endpoints configured (RPC_URL_1 / RPC_URL_2)");
}

const COMMITMENT = process.env.COMMITMENT || "confirmed";

function pickRpcCandidates() {
  return [...new Set(RPC_ENDPOINTS)];
}

let activeRpcUrl = pickRpcCandidates()[0];
let connection = new Connection(activeRpcUrl, { commitment: COMMITMENT });

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
  connection = new Connection(activeRpcUrl, { commitment: COMMITMENT });
}

async function withRpcFailover(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      return await fn(connection);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed on all RPCs. last=${msg}`);
}

// ---------------- PQUEUE RATE LIMITER ----------------
const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return rpcQueue.add(() => withRpcFailover(opName, fn));
}

// ---------------- Telegram ----------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: String(text),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );

    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------- Pump.fun program ----------------
const PUMP_PROGRAM_ID = new PublicKey(
  process.env.PUMPFUN_PROGRAM_ID ||
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

// ---------------- Settings ----------------
const OUT_FILE = process.env.BONDING_OUT_FILE || "bonding_candidates.json";

const SLOT_POLL_MS = Number(process.env.SLOT_POLL_MS || 2500);
const MAX_CATCHUP_SLOTS = Number(process.env.MAX_CATCHUP_SLOTS || 8);

const MIN_LIQ_SOL = Number(process.env.MIN_LIQ_SOL || 10);
const CURVE_TARGET_SOL = Number(process.env.CURVE_TARGET_SOL || 60);

// real entry threshold
const CURVE_PCT_THRESHOLD = Number(process.env.CURVE_PCT_THRESHOLD || 88);

// watch threshold
const CURVE_WATCH_MIN_PCT = Number(process.env.CURVE_WATCH_MIN_PCT || 20);

const CANDIDATE_TTL_MIN = Number(process.env.CANDIDATE_TTL_MIN || 20);
const WATCH_TTL_MIN = Number(process.env.WATCH_TTL_MIN || 180);
const MAX_WRITES_PER_CYCLE = Number(process.env.MAX_WRITES_PER_CYCLE || 20);

// startup backscan
const STARTUP_BACKSCAN_SLOTS = Number(process.env.STARTUP_BACKSCAN_SLOTS || 200);

const outPath = path.resolve(process.cwd(), OUT_FILE);

// ---------------- In-memory state ----------------
const CURVE_WATCH = new Map(); // mint -> watch record


let detectorTimer = null;
let detectorTickRunning = false;
let detectorStopRequested = false;

let lastSlot = 0;
let seenMints = new Set();
let seenSigs = new Set();

const CURVE_WATCH = new Map(); // mint -> watch record
const CURVE_CACHE_TTL = 3000; // ms

const BONDING_CURVE_MIN_LEN = 49; // enough for discriminator + 5 u64 + bool

const OFFSETS = {
  discriminator: 0,
  virtualTokenReserves: 8,
  virtualSolReserves: 16,
  realTokenReserves: 24,
  realSolReserves: 32,
  tokenTotalSupply: 40,
  complete: 48,
};

// ---------------- Helpers ----------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}
// ---------------- DECODER----------------
function decodeBondingCurveAccount(data) {
  if (!data || data.length < BONDING_CURVE_MIN_LEN) {
    throw new Error("bonding curve account too short");
  }

  return {
    virtualTokenReserves: data.readBigUInt64LE(OFFSETS.virtualTokenReserves),
    virtualSolReserves: data.readBigUInt64LE(OFFSETS.virtualSolReserves),
    realTokenReserves: data.readBigUInt64LE(OFFSETS.realTokenReserves),
    realSolReserves: data.readBigUInt64LE(OFFSETS.realSolReserves),
    tokenTotalSupply: data.readBigUInt64LE(OFFSETS.tokenTotalSupply),
    complete: data[OFFSETS.complete] !== 0,
  };
}

function safeReadArray(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw || "[]");
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function atomicWriteArray(file, arr) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, file);
}

function deriveBondingCurvePda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function normalizeAccountKeys(message) {
  const ak = message?.accountKeys;
  if (!Array.isArray(ak)) return [];
  return ak.map((k) => (k?.pubkey ? k.pubkey : k)).filter(Boolean);
}

function txTouchesProgram(tx, programId) {
  const msg = tx?.transaction?.message;
  if (!msg) return false;

  const keys = normalizeAccountKeys(msg);
  if (keys.length === 0) return false;

  const target = programId.toBase58();

  const programIdAt = (programIdIndex) => {
    const pk = keys[programIdIndex];
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

function touchesPump(tx) {
  return txTouchesProgram(tx, PUMP_PROGRAM_ID);
}

function normalizeMintInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false };

  try {
    const b = bs58.decode(raw);
    if (b.length === 32) {
      return { ok: true, mint: raw };
    }
  } catch {}

  return { ok: false };
}

function pickMints(meta) {
  const pre = new Set();

  for (const b of meta?.preTokenBalances || []) {
    if (b?.mint) pre.add(b.mint);
  }

  const out = [];

  for (const b of meta?.postTokenBalances || []) {
    const mint = b?.mint;
    if (!mint) continue;
    if (pre.has(mint)) continue;

    out.push(mint);
  }

  return out;
}

function pruneOldCandidates(arr, ttlMin) {
  const cutoff = Date.now() - ttlMin * 60_000;
  return arr.filter((x) => {
    const t = Date.parse(x?.seenAt || "");
    return Number.isFinite(t) ? t >= cutoff : true;
  });
}

function computeCurvePct(curveSol) {
  if (!Number.isFinite(curveSol) || curveSol <= 0) return 0;
  if (!Number.isFinite(CURVE_TARGET_SOL) || CURVE_TARGET_SOL <= 0) return 0;
  return (curveSol / CURVE_TARGET_SOL) * 100;
}

function getWatchSnapshot() {
  return [...CURVE_WATCH.values()].map((x) => ({
    mint: x.mint,
    curvePct: x.lastCurvePct,
    solLiquidity: x.lastSolLiquidity,
    firstSeenAt: x.firstSeenAt,
    lastCheckedAt: x.lastCheckedAt,
    firstSeenSlot: x.firstSeenSlot,
  }));
}

async function getCurveInfoForMint(mintStr) {
  const now = Date.now();

  const cached = CURVE_CACHE.get(mintStr);
  if (cached && now - cached.ts < CURVE_CACHE_TTL) {
    return cached.data;
  }

  let mint;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    return null;
  }

  const curve = deriveBondingCurvePda(mint);

  let accountInfo;
  try {
    accountInfo = await rpcLimited("getAccountInfo(bondingCurve)", (c) =>
      c.getAccountInfo(curve, COMMITMENT)
    );
  } catch {
    return null;
  }

  if (!accountInfo?.data) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeBondingCurveAccount(accountInfo.data);
  } catch {
    return null;
  }

  // use real SOL reserves directly from account state
  const sol = Number(decoded.realSolReserves) / 1e9;
  const curvePct = computeCurvePct(sol);

  const result = {
    mint: mintStr,
    bondingCurve: curve.toBase58(),
    solLiquidity: Number(sol.toFixed(6)),
    curvePct: Number(curvePct.toFixed(2)),
    complete: decoded.complete,
    realSolReserves: decoded.realSolReserves.toString(),
    realTokenReserves: decoded.realTokenReserves.toString(),
    virtualSolReserves: decoded.virtualSolReserves.toString(),
    virtualTokenReserves: decoded.virtualTokenReserves.toString(),
  };

  CURVE_CACHE.set(mintStr, {
    data: result,
    ts: now,
  });

  return result;
}

function upsertWatch(rec, slot) {
  const prev = CURVE_WATCH.get(rec.mint);

  CURVE_WATCH.set(rec.mint, {
    mint: rec.mint,
    rawMint: rec.rawMint,
    bondingCurve: rec.bondingCurve,
    lastCurvePct: rec.curvePct,
    lastSolLiquidity: rec.solLiquidity,
    firstSeenAt: prev?.firstSeenAt || nowIso(),
    lastCheckedAt: nowIso(),
    firstSeenSlot: prev?.firstSeenSlot || slot || null,
  });
}

function pruneWatchlist() {
  const cutoff = nowMs() - WATCH_TTL_MIN * 60_000;

  for (const [mint, rec] of CURVE_WATCH.entries()) {
    const t = Date.parse(rec?.lastCheckedAt || rec?.firstSeenAt || "");
    if (Number.isFinite(t) && t < cutoff) {
      CURVE_WATCH.delete(mint);
    }
  }
}

async function flushQualifiedCandidatesFromWatch() {
  const arr = pruneOldCandidates(safeReadArray(outPath), CANDIDATE_TTL_MIN);
  const have = new Set(arr.map((x) => x?.mint).filter(Boolean));

  let added = 0;
  const addedRecs = [];

  for (const rec of CURVE_WATCH.values()) {
    if (!rec?.mint) continue;
    if (have.has(rec.mint)) continue;
    if (rec.lastSolLiquidity < MIN_LIQ_SOL) continue;
    if (rec.lastCurvePct < CURVE_PCT_THRESHOLD) continue;

    const outRec = {
      mint: rec.mint,
      rawMint: rec.rawMint,
      bondingCurve: rec.bondingCurve,
      solLiquidity: rec.lastSolLiquidity,
      curveTargetSol: Number(CURVE_TARGET_SOL),
      curvePct: rec.lastCurvePct,
      seenAt: nowIso(),
      firstSeenSlot: rec.firstSeenSlot,
      rule: `curve_pct>=${CURVE_PCT_THRESHOLD}`,
    };

    arr.push(outRec);
    have.add(rec.mint);
    seenMints.add(rec.mint);
    added += 1;
    addedRecs.push(outRec);
  }

  if (added > 0) {
    atomicWriteArray(outPath, arr);
    console.log(`[WRITE] added=${added} total=${arr.length} rpc=${activeRpcUrl}`);

    for (const rec of addedRecs) {
      const rawLine = rec.rawMint ? `Raw: <code>${rec.rawMint}</code>\n` : "";
      const rpcSafe = String(activeRpcUrl).replace(/api-key=([^&]+)/i, "api-key=***");

      const msg =
        `🟣 <b>Bonding Candidate Added</b>\n` +
        `Mint: <code>${rec.mint}</code>\n` +
        rawLine +
        `SOL: <b>${rec.solLiquidity}</b>\n` +
        `Curve: <b>${rec.curvePct}%</b> (target ${rec.curveTargetSol})\n` +
        `SeenAt: <b>${rec.seenAt || "n/a"}</b>\n` +
        `Rule: <code>${rec.rule}</code>\n` +
        `RPC: <code>${rpcSafe}</code>`;

      await sendTelegram(msg);
    }
  }
}

// ======================================================
// 🚀 BLOCK SCANNER — PROCESS PUMP.FUN TRANSACTIONS
// ======================================================
// - Scans block transactions
// - Filters Pump.fun interactions only
// - Extracts NEW token mints (postTokenBalances)
// - Keeps ONLY "pump" suffix tokens
// - Validates mint format (no mutation)
// - Deduplicates per block
// - Fetches curve data in parallel (rate-limited)
// - Stores qualifying tokens (>= CURVE_WATCH_MIN_PCT)
// ======================================================

async function processBlock(slot) {
  // ---------------- FETCH BLOCK ----------------
  let block;
  try {
    block = await rpcLimited("getBlock", (c) =>
      c.getBlock(slot, {
        commitment: COMMITMENT,
        maxSupportedTransactionVersion: 1,
        transactionDetails: "full",
        rewards: false,
      })
    );
  } catch {
    return;
  }

  // ---------------- INIT STATE ----------------
  const blockSeenMints = new Set(); // prevent duplicates within block
  let processedMintCount = 0;
  const MAX_MINTS_PER_BLOCK = Number(process.env.MAX_MINTS_PER_BLOCK || 25);

  const txs = Array.isArray(block?.transactions) ? block.transactions : [];

  // ---------------- LOOP TRANSACTIONS ----------------
  for (const t of txs) {
    if (processedMintCount >= MAX_MINTS_PER_BLOCK) break;

    const sig = t?.transaction?.signatures?.[0];
    if (!sig) continue;

    // skip already processed signatures
    if (seenSigs.has(sig)) continue;
    seenSigs.add(sig);

    // only Pump.fun interactions
    if (!touchesPump(t)) continue;

    // extract newly created tokens
    const rawMintList = pickMints(t?.meta);
    if (!rawMintList.length) continue;

    const candidates = [];

    // ---------------- FILTER MINTS ----------------
    for (const rawMintStr of rawMintList) {
      if (processedMintCount + candidates.length >= MAX_MINTS_PER_BLOCK) break;

      const mintStr = String(rawMintStr || "").trim();
      if (!mintStr) continue;

      // ONLY pump suffix tokens
      if (!mintStr.toLowerCase().endsWith("pump")) continue;

      // validate WITHOUT modifying
      try {
        new PublicKey(mintStr);
      } catch {
        continue;
      }

      // dedupe inside this block
      if (blockSeenMints.has(mintStr)) continue;
      blockSeenMints.add(mintStr);

      candidates.push(mintStr);
    }

    if (!candidates.length) continue;

    // ---------------- PARALLEL CURVE FETCH ----------------
    const results = await Promise.all(
      candidates.map((mintStr) => getCurveInfoForMint(mintStr))
    );

    // ---------------- PROCESS RESULTS ----------------
    for (let i = 0; i < candidates.length; i++) {
      if (processedMintCount >= MAX_MINTS_PER_BLOCK) break;

      const mintStr = candidates[i];
      const curveInfo = results[i];
      if (!curveInfo) continue;

      processedMintCount++;

      // keep only tokens above watch threshold
      if (curveInfo.curvePct >= CURVE_WATCH_MIN_PCT) {
        upsertWatch(
          {
            mint: mintStr,
            rawMint: mintStr,
            bondingCurve: curveInfo.bondingCurve,
            curvePct: curveInfo.curvePct,
            solLiquidity: curveInfo.solLiquidity,
          },
          slot
        );
      }
    }
  }
}
async function refreshWatchedCurves() {
  const mints = [...CURVE_WATCH.keys()];
  if (!mints.length) return;

  const candidates = [];

  for (const rawMintStr of mints) {
    const mintStr = String(rawMintStr || "").trim();
    if (!mintStr) continue;

    if (!mintStr.toLowerCase().endsWith("pump")) continue;

    try {
      new PublicKey(mintStr);
    } catch {
      continue;
    }

    candidates.push(mintStr);
  }

  // parallel RPC, still controlled by rpcLimited inside getCurveInfoForMint
  const results = await Promise.all(
    candidates.map((m) => getCurveInfoForMint(m))
  );

  for (let i = 0; i < candidates.length; i++) {
    const mintStr = candidates[i];
    const curveInfo = results[i];
    if (!curveInfo) continue;

    upsertWatch(
      {
        mint: mintStr,
        rawMint: mintStr,
        bondingCurve: curveInfo.bondingCurve,
        curvePct: curveInfo.curvePct,
        solLiquidity: curveInfo.solLiquidity,
      },
      CURVE_WATCH.get(mintStr)?.firstSeenSlot || null
    );
  }
}

// ---------------- Init ----------------
async function initDetectorStateOnce() {
  const existing = safeReadArray(outPath);
  const pruned = pruneOldCandidates(existing, CANDIDATE_TTL_MIN);
  if (pruned.length !== existing.length) atomicWriteArray(outPath, pruned);

  seenMints = new Set(pruned.map((x) => x?.mint).filter(Boolean));
  seenSigs = new Set();

  const currentSlot = await rpcLimited("getSlot(init)", (c) => c.getSlot(COMMITMENT));
  lastSlot = Math.max(0, currentSlot - STARTUP_BACKSCAN_SLOTS);

  console.log("[CONFIG]", {
    CURVE_WATCH_MIN_PCT,
    CURVE_PCT_THRESHOLD,
    envCurvePctThreshold: process.env.CURVE_PCT_THRESHOLD ?? null,
    STARTUP_BACKSCAN_SLOTS,
  });
}

// ---------------- Tick ----------------
async function runDetectorTick(label) {
  if (detectorTickRunning) {
    console.log("[bondingDetector] tick skipped because previous tick still running");
    return;
  }

  detectorTickRunning = true;
  const started = Date.now();

  try {
    if (detectorStopRequested) return;

    let slotNow;
    try {
      slotNow = await rpcLimited("getSlot(loop)", (c) => c.getSlot(COMMITMENT));
    } catch {
      return;
    }

    const end = Math.min(slotNow, lastSlot + MAX_CATCHUP_SLOTS);

    for (let s = lastSlot + 1; s <= end; s++) {
      if (detectorStopRequested) break;
      await processBlock(s);
      lastSlot = s;
    }

    // recheck all watched mints each tick
    await refreshWatchedCurves();

    pruneWatchlist();
    await flushQualifiedCandidatesFromWatch();

    console.log("[bondingDetector] tick stats", {
      label,
      durationMs: Date.now() - started,
      watchCount: CURVE_WATCH.size,
      lastSlot,
      slotNow,
      rpc: activeRpcUrl,
    });
  } catch (err) {
    console.error(`[bondingDetector] ${label} error:`, err?.message || err);
  } finally {
    detectorTickRunning = false;
  }
}

// ---------------- Start / Stop ----------------
export async function startBondingDetector() {
  if (detectorTimer) return;

  detectorStopRequested = false;

  console.log("[+] Stage-1 Pump.fun bonding detector started");
  console.log(
    `[+] OUT=${OUT_FILE} | MIN_LIQ_SOL=${MIN_LIQ_SOL} | CURVE_TARGET_SOL=${CURVE_TARGET_SOL} | WATCH=${CURVE_WATCH_MIN_PCT}% | THRESH=${CURVE_PCT_THRESHOLD}% | TTL=${CANDIDATE_TTL_MIN}min | polling=${SLOT_POLL_MS}ms`
  );
  console.log(`[+] RPC order: ${pickRpcCandidates().join(" -> ")}`);

  await initDetectorStateOnce();

  void runDetectorTick("initial tick");

  detectorTimer = setInterval(() => {
    void runDetectorTick("loop tick");
  }, SLOT_POLL_MS);

  console.log("[bondingDetector] loop started", { SLOT_POLL_MS });
}

export async function stopBondingDetector(reason = "manual") {
  if (!detectorTimer) return;

  detectorStopRequested = true;

  clearInterval(detectorTimer);
  detectorTimer = null;

  while (detectorTickRunning) {
    await sleep(200);
  }

  console.log("[bondingDetector] stopped", {
    reason,
    watchSnapshot: getWatchSnapshot(),
  });
}

export const startStage1Bonding = startBondingDetector;
export const stopStage1Bonding = stopBondingDetector;

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startBondingDetector();
}