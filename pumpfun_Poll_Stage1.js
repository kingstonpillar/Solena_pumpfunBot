// pumpfun_poll_stage1_bonding_50pct.js (ESM)
// Stage-1: Pump.fun bonding-curve candidate detector (NO migration, NO burn)
// Writes bonding_candidates.json immediately when curvePct >= CURVE_PCT_THRESHOLD
// RPC-only, slot polling, dedupe, TTL cleanup
// Adds:
// - Telegram alert when written to json
// - RPC failover: RPC_URL_1 -> RPC_URL_2 -> RPC_URL (or default)
// - PQueue rate limiting for RPC (prevents bursts / 429)

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

dotenv.config();

// ---------------- RPC FAILOVER ----------------

const RPC_ENDPOINTS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
].filter(Boolean);

if (RPC_ENDPOINTS.length === 0) {
  throw new Error("No RPC endpoints configured (RPC_URL_1 / RPC_URL_2)");
}

// Use first RPC as primary
const RPC_PRIMARY = RPC_ENDPOINTS[0];

const COMMITMENT = process.env.COMMITMENT || "confirmed";

function pickRpcCandidates() {
  const list = [RPC_URL_1, RPC_URL_2, RPC_URL_FALLBACK].filter(Boolean);
  return [...new Set(list)];
}

// mutable active connection so once it fails over, we stay on the working RPC
let activeRpcUrl = pickRpcCandidates()[0] || RPC_URL_FALLBACK;
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
      continue;
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
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: String(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------- Pump.fun program ----------------
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// ---------------- Settings ----------------
const OUT_FILE = process.env.BONDING_OUT_FILE || "bonding_candidates.json";

const SLOT_POLL_MS = Number(process.env.SLOT_POLL_MS || 2500);
const MAX_CATCHUP_SLOTS = Number(process.env.MAX_CATCHUP_SLOTS || 8);

// Hard floor. Still keep it.
const MIN_LIQ_SOL = Number(process.env.MIN_LIQ_SOL || 10);

// Curve percent logic
const CURVE_TARGET_SOL = Number(process.env.CURVE_TARGET_SOL || 85);
const CURVE_PCT_THRESHOLD = Number(process.env.CURVE_PCT_THRESHOLD || 50);

// TTL cleanup
const CANDIDATE_TTL_MIN = Number(process.env.CANDIDATE_TTL_MIN || 20);

// safety: limit candidates written per cycle
const MAX_WRITES_PER_CYCLE = Number(process.env.MAX_WRITES_PER_CYCLE || 20);

// ---------------- Paths ----------------
const outPath = path.resolve(process.cwd(), OUT_FILE);

// ---------------- Helpers ----------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
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

// Pick mint from token balance deltas
function pickMint(meta) {
  const pre = new Set();
  const post = new Set();

  for (const b of meta?.preTokenBalances || []) if (b?.mint) pre.add(b.mint);
  for (const b of meta?.postTokenBalances || []) if (b?.mint) post.add(b.mint);

  for (const m of post) if (!pre.has(m)) return m;
  return meta?.postTokenBalances?.[0]?.mint || null;
}

function pruneOldCandidates(arr, ttlMin) {
  const cutoff = Date.now() - ttlMin * 60_000;
  return arr.filter((x) => {
    const t = Date.parse(x?.firstSeenAt || x?.detectedAt || "");
    return Number.isFinite(t) ? t >= cutoff : true;
  });
}

function computeCurvePct(curveSol) {
  if (!Number.isFinite(curveSol) || curveSol <= 0) return 0;
  if (!Number.isFinite(CURVE_TARGET_SOL) || CURVE_TARGET_SOL <= 0) return 0;
  return (curveSol / CURVE_TARGET_SOL) * 100;
}

// ---------------- Block scan ----------------
async function processBlock(slot, seenSigs, seenMints, writeQueue) {
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

  const txs = Array.isArray(block?.transactions) ? block.transactions : [];
  for (const t of txs) {
    const sig = t?.transaction?.signatures?.[0];
    if (!sig) continue;

    if (seenSigs.has(sig)) continue;
    seenSigs.add(sig);

    if (!touchesPump(t)) continue;

    const mintStr = pickMint(t?.meta);
    if (!mintStr) continue;
    if (seenMints.has(mintStr)) continue;

    let mint;
    try {
      mint = new PublicKey(mintStr);
    } catch {
      continue;
    }

    const curve = deriveBondingCurvePda(mint);

    let lamports;
    try {
      lamports = await rpcLimited("getBalance(bondingCurve)", (c) =>
        c.getBalance(curve, COMMITMENT)
      );
    } catch {
      continue;
    }

    const sol = lamports / 1e9;
    if (sol < MIN_LIQ_SOL) continue;

    const curvePct = computeCurvePct(sol);
    if (curvePct < CURVE_PCT_THRESHOLD) continue;

    writeQueue.push({
      mint: mintStr,
      bondingCurve: curve.toBase58(),
      solLiquidity: Number(sol.toFixed(6)),
      curveTargetSol: Number(CURVE_TARGET_SOL),
      curvePct: Number(curvePct.toFixed(2)),
      firstSeenAt: nowIso(),
      firstSeenSlot: slot,
      rule: `curve_pct>=${CURVE_PCT_THRESHOLD}`,
    });

    if (writeQueue.length >= MAX_WRITES_PER_CYCLE) break;
  }
}

// ---------------- Main ----------------
(async () => {
  console.log("[+] Stage-1 Pump.fun bonding detector started");
  console.log(
    `[+] OUT=${OUT_FILE} | MIN_LIQ_SOL=${MIN_LIQ_SOL} | CURVE_TARGET_SOL=${CURVE_TARGET_SOL} | THRESH=${CURVE_PCT_THRESHOLD}% | TTL=${CANDIDATE_TTL_MIN}min | polling=${SLOT_POLL_MS}ms`
  );
  console.log(`[+] RPC order: ${pickRpcCandidates().join(" -> ")}`);

  const existing = safeReadArray(outPath);
  const pruned = pruneOldCandidates(existing, CANDIDATE_TTL_MIN);
  if (pruned.length !== existing.length) atomicWriteArray(outPath, pruned);

  const seenMints = new Set(pruned.map((x) => x?.mint).filter(Boolean));
  const seenSigs = new Set();

  let lastSlot;
  try {
    lastSlot = await rpcLimited("getSlot(init)", (c) => c.getSlot(COMMITMENT));
  } catch {
    lastSlot = 0;
  }

  while (true) {
    let slotNow;
    try {
      slotNow = await rpcLimited("getSlot(loop)", (c) => c.getSlot(COMMITMENT));
    } catch {
      await sleep(SLOT_POLL_MS);
      continue;
    }

    const end = Math.min(slotNow, lastSlot + MAX_CATCHUP_SLOTS);
    const writeQueue = [];

    for (let s = lastSlot + 1; s <= end; s++) {
      await processBlock(s, seenSigs, seenMints, writeQueue);
      lastSlot = s;
    }

    if (writeQueue.length) {
      const arr = pruneOldCandidates(safeReadArray(outPath), CANDIDATE_TTL_MIN);
      const have = new Set(arr.map((x) => x?.mint).filter(Boolean));

      let added = 0;
      const addedRecs = [];

      for (const rec of writeQueue) {
        if (!rec?.mint) continue;
        if (have.has(rec.mint)) continue;

        arr.push(rec);
        have.add(rec.mint);
        seenMints.add(rec.mint);
        added += 1;
        addedRecs.push(rec);
      }

      if (added > 0) {
        atomicWriteArray(outPath, arr);
        console.log(`[WRITE] added=${added} total=${arr.length} rpc=${activeRpcUrl}`);

        for (const rec of addedRecs) {
          const msg =
            `🟣 <b>Bonding Candidate Added</b>\n` +
            `Mint: <code>${rec.mint}</code>\n` +
            `SOL: <b>${rec.solLiquidity}</b>\n` +
            `Curve: <b>${rec.curvePct}%</b> (target ${rec.curveTargetSol})\n` +
            `Slot: <b>${rec.firstSeenSlot}</b>\n` +
            `Rule: <code>${rec.rule}</code>\n` +
            `RPC: <code>${activeRpcUrl}</code>`;

          await sendTelegram(msg);
        }
      }
    }

    await sleep(SLOT_POLL_MS);
  }
})();