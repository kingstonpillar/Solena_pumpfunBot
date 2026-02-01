
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

// Hardcoded Helius RPC
const RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=ffce4942-e7c6-45cc-ab51-1e0ce95bb175";

const conn = new Connection(RPC_URL, "confirmed");

// Pump.fun program
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Blacklist config
const BLACKLIST_FILE = path.resolve(process.cwd(), "blacklist.json");
const MIN_CREATOR_SCORE = 65;
const AUTO_BLACKLIST_THRESHOLD = 30;

// Scan limits
const MINT_SIG_SCAN_LIMIT = 120;
const DEV_SIG_SCAN_LIMIT = 500;

// Dev thresholds
const DEV_MIN_AGE_DAYS = 7;
const DEV_MIN_TXS = 5;

// RPC limiter
const q = new PQueue({ intervalCap: 8, interval: 1000, carryoverConcurrencyCount: true });
const rpcLimited = (fn) => q.add(fn);

function loadBlacklist() {
  try {
    const j = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
    const wallets = Array.isArray(j?.wallets) ? j.wallets : [];
    return new Set(wallets);
  } catch {
    return new Set();
  }
}
function saveBlacklist(set) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify({ wallets: [...set] }, null, 2));
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
  if (!keys.length) return false;

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
    return await rpcLimited(() =>
      conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 })
    );
  } catch {
    return null;
  }
}

// Token-2022 detection + dangerous extension hard fail
async function detectToken2022Danger(mintPub) {
  // Simple & reliable checks:
  // - if parsed includes extensions array
  // - or raw data length suggests token-2022 mint layout
  try {
    const parsedMintInfo = await rpcLimited(() => conn.getParsedAccountInfo(mintPub)).catch(() => null);
    const parsed = parsedMintInfo?.value?.data?.parsed?.info || null;

    const raw = await rpcLimited(() => conn.getAccountInfo(mintPub)).catch(() => null);
    const rawLen = raw?.data?.length || 0;

    const extensions = Array.isArray(parsed?.extensions) ? parsed.extensions : [];

    const isToken2022 =
      (extensions.length > 0) ||
      rawLen > 200; // heuristic

    const extStrings = extensions.map((x) => String(x).toLowerCase());

    const dangerous =
      extStrings.some((e) => e.includes("transferhook")) ||
      extStrings.some((e) => e.includes("confidential")) ||
      extStrings.some((e) => e.includes("defaultaccountstate")) ||
      extStrings.some((e) => e.includes("nontransferable"));

    return { isToken2022, extensions: extStrings, dangerous, rawLen };
  } catch {
    return { isToken2022: false, extensions: [], dangerous: false, rawLen: 0 };
  }
}

// Derive creator wallet: first tx that touches pump.fun, pick feePayer (accountKeys[0]) as creator.
async function derivePumpfunCreator(mintPub) {
  let sigInfos = [];
  try {
    sigInfos = await rpcLimited(() =>
      conn.getSignaturesForAddress(mintPub, { limit: MINT_SIG_SCAN_LIMIT })
    );
  } catch {
    sigInfos = [];
  }

  for (const s of sigInfos || []) {
    const sig = s?.signature;
    if (!sig) continue;

    const tx = await getParsedTx(sig);
    if (!tx) continue;

    if (!txTouchesProgram(tx, PUMP_PROGRAM_ID)) continue;

    // fee payer is typically accountKeys[0]
    const ak0 = tx.transaction?.message?.accountKeys?.[0];
    const creator =
      ak0?.pubkey?.toBase58?.() ||
      ak0?.toBase58?.() ||
      null;

    if (creator) return { creator, signature: sig, slot: tx.slot, blockTime: tx.blockTime || null };
  }

  return { creator: null, signature: null, slot: null, blockTime: null };
}

async function analyzeCreatorWallet(creatorAddress) {
  const reasons = [];
  let score = 100;

  if (!creatorAddress) return { safe: false, score: 0, reasons: ["No creator"], details: {} };

  let creatorPub;
  try { creatorPub = new PublicKey(creatorAddress); }
  catch { return { safe: false, score: 0, reasons: ["Invalid creator pubkey"], details: {} }; }

  const sigInfos = await rpcLimited(() =>
    conn.getSignaturesForAddress(creatorPub, { limit: Math.min(DEV_SIG_SCAN_LIMIT, 1000) })
  ).catch(() => []);

  if (!Array.isArray(sigInfos) || sigInfos.length === 0) {
    return { safe: false, score: 0, reasons: ["Creator has no on-chain history"], details: { txCount: 0 } };
  }

  const earliest = sigInfos[sigInfos.length - 1];
  const earliestBlockTime = typeof earliest?.blockTime === "number" ? earliest.blockTime : null;
  const now = Math.floor(Date.now() / 1000);
  const ageDays = earliestBlockTime ? (now - earliestBlockTime) / 86400 : 0;
  const txCount = sigInfos.length;

  if (!earliestBlockTime || ageDays < DEV_MIN_AGE_DAYS) {
    score -= 80;
    reasons.push(`Creator wallet too new (${ageDays.toFixed(1)}d)`);
  } else {
    reasons.push(`Creator wallet age ${ageDays.toFixed(1)}d`);
  }

  if (txCount < DEV_MIN_TXS) {
    score -= 30;
    reasons.push(`Creator tx count low (${txCount})`);
  } else {
    reasons.push(`Creator tx count ${txCount}`);
  }

  try {
    const bal = await rpcLimited(() => conn.getBalance(creatorPub)).catch(() => null);
    if (typeof bal === "number") {
      const sol = bal / 1e9;
      if (sol < 0.05) {
        score -= 10;
        reasons.push(`Creator SOL balance low (${sol.toFixed(4)})`);
      } else {
        reasons.push(`Creator SOL balance ${sol.toFixed(4)}`);
      }
    }
  } catch {}

  score = Math.max(0, Math.min(100, score));
  const safe = score >= MIN_CREATOR_SCORE;

  return { safe, score, reasons, details: { ageDays, txCount } };
}

// Exported API
export async function verifyCreatorSafetyPumpfun(mint) {
  const reasons = [];
  let score = 100;

  let mintPub;
  try { mintPub = new PublicKey(mint); }
  catch { return { safe: false, score: 0, reasons: ["Invalid mint"], creator: null, details: {} }; }

  // Token-2022 dangerous extension hard fail
  const t22 = await detectToken2022Danger(mintPub);
  if (t22.dangerous) {
    return {
      safe: false,
      score: 0,
      reasons: ["Token-2022 dangerous extensions"],
      creator: null,
      details: { token2022: t22 },
    };
  }
  if (t22.isToken2022) {
    score -= 25;
    reasons.push("Token-2022 detected (penalty)");
  } else {
    reasons.push("Token program OK");
  }

  // Derive pump.fun creator
  const derived = await derivePumpfunCreator(mintPub);
  if (!derived.creator) {
    return { safe: false, score: 0, reasons: ["Unable to derive Pump.fun creator"], creator: null, details: { derived } };
  }

  const blacklist = loadBlacklist();
  if (blacklist.has(derived.creator)) {
    return { safe: false, score: 0, reasons: ["Creator BLACKLISTED"], creator: derived.creator, details: { derived } };
  }

  // Analyze creator wallet
  const dev = await analyzeCreatorWallet(derived.creator);
  score = Math.min(score, dev.score);
  reasons.push(...dev.reasons);

  // Auto blacklist
  if (derived.creator && score < AUTO_BLACKLIST_THRESHOLD) {
    blacklist.add(derived.creator);
    saveBlacklist(blacklist);
    reasons.push("Creator auto-blacklisted");
  }

  const safe = score >= MIN_CREATOR_SCORE && dev.safe;

  return {
    safe,
    score,
    reasons,
    creator: derived.creator,
    details: { derived, token2022: t22, dev: dev.details },
  };
}
