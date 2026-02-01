// pumpfun_poll_stage1_bonding_50pct.cjs
// Stage-1: Pump.fun bonding-curve candidate detector (NO migration, NO burn)
// Writes bonding_candidates.json immediately when curvePct >= CURVE_PCT_THRESHOLD
// RPC-only, slot polling, dedupe, TTL cleanup

const fs = require("fs");
const path = require("path");
const { Connection, PublicKey } = require("@solana/web3.js");

// ---------------- RPC ----------------
const RPC_URL =
  process.env.RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY";

// ---------------- Pump.fun program ----------------
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// ---------------- Settings ----------------
const OUT_FILE = process.env.BONDING_OUT_FILE || "bonding_candidates.json";
const COMMITMENT = process.env.COMMITMENT || "confirmed";

const SLOT_POLL_MS = Number(process.env.SLOT_POLL_MS || 2500);
const MAX_CATCHUP_SLOTS = Number(process.env.MAX_CATCHUP_SLOTS || 8);

// Hard floor. Still keep it.
const MIN_LIQ_SOL = Number(process.env.MIN_LIQ_SOL || 10);

// Curve percent logic (this is what you asked for)
const CURVE_TARGET_SOL = Number(process.env.CURVE_TARGET_SOL || 85); // adjust if your target is different
const CURVE_PCT_THRESHOLD = Number(process.env.CURVE_PCT_THRESHOLD || 50); // you asked for 50

// TTL cleanup
const CANDIDATE_TTL_MIN = Number(process.env.CANDIDATE_TTL_MIN || 20);

// safety: limit candidates written per cycle
const MAX_WRITES_PER_CYCLE = Number(process.env.MAX_WRITES_PER_CYCLE || 20);

// ---------------- Conn ----------------
const connection = new Connection(RPC_URL, { commitment: COMMITMENT });
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
    block = await connection.getBlock(slot, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 1,
      transactionDetails: "full",
      rewards: false,
    });
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
      lamports = await connection.getBalance(curve, COMMITMENT);
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

  const existing = safeReadArray(outPath);
  const pruned = pruneOldCandidates(existing, CANDIDATE_TTL_MIN);
  if (pruned.length !== existing.length) atomicWriteArray(outPath, pruned);

  const seenMints = new Set(pruned.map((x) => x?.mint).filter(Boolean));
  const seenSigs = new Set();

  let lastSlot;
  try {
    lastSlot = await connection.getSlot(COMMITMENT);
  } catch {
    lastSlot = 0;
  }

  while (true) {
    let slotNow;
    try {
      slotNow = await connection.getSlot(COMMITMENT);
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
      for (const rec of writeQueue) {
        if (!rec?.mint) continue;
        if (have.has(rec.mint)) continue;

        arr.push(rec);
        have.add(rec.mint);
        seenMints.add(rec.mint);
        added += 1;
      }

      if (added > 0) {
        atomicWriteArray(outPath, arr);
        console.log(`[WRITE] added=${added} total=${arr.length}`);
      }
    }

    await sleep(SLOT_POLL_MS);
  }
})();