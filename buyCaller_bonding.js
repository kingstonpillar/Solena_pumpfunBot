import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Connection, PublicKey } from "@solana/web3.js";
import { executePumpfunBuyFromBonding } from './swapexecutor_pumpfun.js';
import { verifyCreatorSafetyPumpfun } from './tokenCreatorScanner.js';
import { checkTokenSecurity } from './tokensecurities.js';
import { checkToken2022ExtensionsSafety } from './token2022ExtensionsGate.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import PQueue from 'p-queue';

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
    msg.includes("rpc response error") ||
    msg.startsWith("rpc error")
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


// ---------------- CONFIG ----------------
// Slippage (basis points)
const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 150);
const MAX_ENTRY = process.env.MAX_ENTRY ? parseInt(process.env.MAX_ENTRY) : 10;  // Maximum number of active positions allowed (tokens being held)
const MAX_BUYS = process.env.MAX_BUYS ? parseInt(process.env.MAX_BUYS) : 20;  // Keep only the latest 20 buys in processed_mints.json
const MAX_AGE = process.env.MAX_AGE ? parseInt(process.env.MAX_AGE) : 12 * 60 * 1000;  // 12 minutes
const PROCESSED_MINTS_FILE = path.resolve(process.env.PROCESSED_MINTS_FILE || './processed_mints.json');
const ACTIVE_POSITIONS_FILE = path.resolve(process.env.ACTIVE_POSITIONS_FILE || './active_positions.json');
const BONDING_CANDIDATES_FILE = path.resolve(process.env.BONDING_CANDIDATES_FILE || './bonding_candidates.json');




// ---------------- UTILITY FUNCTIONS ----------------
function atomicWrite(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing file:', err);
  }
}





// Load the processed mints (tokens already bought)
function loadProcessedList() {
  try {
    const data = fs.readFileSync(PROCESSED_MINTS_FILE, 'utf8');
    return JSON.parse(data); // Parse and return the list of bought tokens
  } catch (err) {
    console.error('Error reading processed_mints.json:', err);
    return [];
  }
}

// Save the processed mints to file, keeping only the latest MAX_BUYS (20)
function saveProcessedList(processedList) {
  const limitedList = processedList.slice(-MAX_BUYS); // Ensure we only keep the latest 20 processed mints
  fs.writeFileSync(PROCESSED_MINTS_FILE, JSON.stringify(limitedList, null, 2), 'utf8');
}

// Load active positions from the `active_positions.json` file
function loadActivePositions() {
  try {
    const data = fs.readFileSync(ACTIVE_POSITIONS_FILE, 'utf8');
    return JSON.parse(data); // Parse and return the list of active positions (tokens held)
  } catch (err) {
    console.error('Error reading active_positions.json:', err);
    return [];
  }
}

// Load the list of candidate tokens for purchase from `bonding_candidates.json`
function loadCandidates() {
  try {
    const data = fs.readFileSync(BONDING_CANDIDATES_FILE, 'utf8');
    return JSON.parse(data); // Parse and return the list of bonding candidates
  } catch (err) {
    console.error('Error reading bonding_candidates.json:', err);
    return [];
  }
}


function isExpiredCandidate(candidate) {
  const MAX_AGE = process.env.MAX_AGE ? parseInt(process.env.MAX_AGE) : 12 * 60 * 1000; // 12 minutes
  const currentTime = Date.now();
  const candidateTime = Date.parse(candidate.seenAt); // use seenAt only

  if (currentTime - candidateTime > MAX_AGE) {
    console.log(`[INFO] Candidate ${candidate.mint} has expired.`);
    return true;
  }
  return false;
}

// ---------------- MAX ENTRY AND ACTIVE POSITION LOGIC ----------------

export async function resumeWatcherIfBelowMax() {
  const active = loadActivePositions();  // Fetch active positions (tokens still held)

  // Compare active positions count with MAX_ENTRY
  if (active.length >= MAX_ENTRY) {
    await stopWatcher();  // Stop buying if max entries are reached
    return { ok: false, reason: 'max_entry_reached', count: active.length };
  }

  await startWatcher();  // Resume buying if under max entries
  return { ok: true, count: active.length };
}

// ---------------- TELEGRAM --------------------

async function sendTelegram(message) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

// Initialize the watcherActive variable globally
let watcherActive = false;

// Function to start the watcher and notify via Telegram
export async function startWatcher() {
  watcherActive = true;
  await sendTelegram('🎯 Liquidity Watcher Started');
}

// Function to stop the watcher and notify via Telegram
export async function stopWatcher() {
  watcherActive = false;
  await sendTelegram('🚫 Liquidity Watcher Stopped');
}



// ---------------- PRUNE EXPIRED CANDIDATES ----------------

// Function to prune expired candidates based on `seenAt` timestamp
function pruneExpiredCandidates(candidates) {
  const now = Date.now();
  const filteredCandidates = candidates.filter(candidate => {
    const seenAt = Date.parse(candidate?.seenAt || 0);
    return now - seenAt <= MAX_AGE; // Keep candidates seen in the last MAX_AGE milliseconds
  });
  return filteredCandidates;
}

// ---------------- TOKEN PROGRAM & EXTENSIONS ----------------

// Function to check the mint program owner
async function getMintProgramOwner(mint) {
  try {
    const mintPubKey = new PublicKey(mint);
    const accountInfo = await conn.getAccountInfo(mintPubKey);

    if (!accountInfo) {
      throw new Error(`Unable to fetch account info for mint: ${mint}`);
    }

    const owner = accountInfo.owner.toBase58();
    if (owner === TOKEN_PROGRAM_ID.toBase58()) {
      return { ok: true, program: "spl-token" };
    } else if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
      return { ok: true, program: "spl-token-2022" };
    } else {
      return { ok: false, reason: `unknown_program:${owner}` };
    }
  } catch (e) {
    console.error(`Error in getMintProgramOwner for ${mint}:`, e);
    return { ok: false, reason: e.message };
  }
}

// Centralized logging function to track events
function logEvent(message, level = 'INFO') {
  const timeStamp = new Date().toISOString();
  console.log(`[${level}] [${timeStamp}] ${message}`);
}

// ---------------- MAIN LOGIC ----------------


// The process loop that logs all activities

async function runBuyCallerOnce() {
  logEvent("Starting to process candidates...");

  let processedList = loadProcessedList(); // Load the list of tokens already bought
  const processedSet = new Set(processedList); // Using a Set for fast lookup
  const allCandidates = loadCandidates(); // Load the list of candidate tokens for purchase

  logEvent(`Loaded ${allCandidates.length} candidates.`);

  const candidates = pruneExpiredCandidates(allCandidates); // uses seenAt

  candidates.sort((a, b) => {
    const ta = Date.parse(a?.seenAt || "") || 0;
    const tb = Date.parse(b?.seenAt || "") || 0;
    return tb - ta; // newest seenAt first
  });

  let buysDone = 0;
  const nextCandidates = [];

  for (const c of candidates) {
    //  define mintStr ONCE and use it everywhere
    const mintStr = String(c?.mint || "").trim();
    if (!mintStr) {
      logEvent(`[BUY-CHECK] missing mint in candidate: ${JSON.stringify(c)}`, "FAIL");
      continue;
    }

    if (processedSet.has(mintStr)) {
      logEvent(`Skipping already processed mint: ${mintStr}`, "INFO");
      continue;
    }

    if (isExpiredCandidate(c)) {
      logEvent(`Skipping expired candidate: ${mintStr}`, "INFO");
      continue;
    }

    logEvent(
      `[BUY-CHECK] mint=${mintStr} curveSol=${c?.solLiquidity ?? c?.curveSol ?? "?"}`,
      "DEBUG"
    );

    let mintProg;
    try {
      mintProg = await getMintProgramOwner(mintStr);
    } catch (e) {
      logEvent(`RPC failure for getMintProgramOwner: ${String(e?.message || e)}`, "ERROR");
      nextCandidates.push(c);
      continue;
    }

    if (!mintProg?.ok) {
      logEvent(`mint program owner check failed for mint=${mintStr}: ${mintProg?.reason}`, "FAIL");
      nextCandidates.push(c);
      continue;
    }

    // Check for SPL Token 2022 extensions
    if (mintProg.program === "spl-token-2022") {
      let extGate;
      try {
        extGate = await rpcLimited("token2022ExtensionsGate(getMint)", (cc) =>
          checkToken2022ExtensionsSafety(cc, mintStr, {
            denyTypes: [1, 6, 9, 12, 14],
            allowlistOnly: true,
            allowTypes: [16, 17, 18, 19],
            commitment: COMMITMENT,
          })
        );
      } catch (e) {
        logEvent(
          `[ERROR] token-2022 extension gate failed for ${mintStr}: ${String(e?.message || e)}`,
          "ERROR"
        );
        nextCandidates.push(c);
        continue;
      }

      if (!extGate?.ok) {
        logEvent(
          `[FAIL] token-2022 extensions for mint=${mintStr}: ${extGate?.reason || "denied"}`,
          "FAIL"
        );
        continue;
      }
    }

    // Creator Security Check
    const creatorRes = await verifyCreatorSafetyPumpfun(mintStr).catch((e) => ({
      safe: false,
      rpcFailed: isRpcishError(e),
      score: 0,
      reasons: [String(e?.message || e || "creator_check_failed")],
      details: null,
    }));

    if (!creatorRes?.safe) {
      if (creatorRes.rpcFailed) {
        logEvent(
          `creator check failed for mint=${mintStr}, retrying later: ${creatorRes.reasons?.join(", ") || ""}`,
          "RPC"
        );
        nextCandidates.push(c);
        continue;
      }

      logEvent(
        `creator security check failed for mint=${mintStr}: ${creatorRes.reasons?.join(", ") || ""} | score=${creatorRes.score}`,
        "FAIL"
      );
      continue;
    }

    // optional debug
    console.log("Creator scan:", {
      safe: creatorRes.safe,
      score: creatorRes.score,
      reasons: creatorRes.reasons,
    });

    // Token Security Check
    const tokenRes = await checkTokenSecurity({
      mint: mintStr,
      bondingCurve: c?.bondingCurve,
    }).catch((e) => ({
      safe: false,
      rpcFailed: isRpcishError(e),
      reasons: String(e?.message || e || "token_security_failed"),
    }));

    if (!tokenRes?.safe) {
      if (tokenRes.rpcFailed) {
        logEvent(
          `token security check failed for mint=${mintStr}, retrying later: ${String(tokenRes.reasons || "")}`,
          "RPC"
        );
        nextCandidates.push(c);
        continue;
      }

      logEvent(
        `token security check failed for mint=${mintStr}: ${tokenRes?.reasons || tokenRes}`,
        "FAIL"
      );
      continue;
    }

    // Proceed with buying if all checks pass
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
        logEvent(`buy call failed for mint=${mintStr}, retrying later: ${String(buyRes.error || "")}`, "RPC");
        nextCandidates.push(c);
        continue;
      }

      logEvent(`buy failed for mint=${mintStr}: ${String(buyRes?.error || "")}`, "FAIL");
      continue;
    }

    logEvent(`[BOUGHT] mint=${mintStr} tx=${sig}`, "SUCCESS");
    buysDone += 1;

    processedList = markProcessedMint(processedList, mintStr);
    processedSet.add(mintStr);
  }

  if (nextCandidates.length === 0) {
    logEvent("No candidates found after processing.", "INFO");
  }

  atomicWrite(BONDING_CANDIDATES_FILE, nextCandidates);
  saveProcessedList(processedList);

  return { ok: true, buysDone, keptCandidates: nextCandidates.length };
}
// ---------------- START/STOP LOOP ----------------
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
      console.log('[buyCaller] stopped', {
        reason: `max_entry_reached:${gate?.count ?? 'unknown'}`,
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

  console.log('[buyCaller] started', { BUY_LOOP_MS });

  void runBuyTick('initial tick');

  buyTimer = setInterval(() => {
    void runBuyTick('loop tick');
  }, BUY_LOOP_MS);
}

export async function stopBuyCaller(reason = 'manual') {
  if (!buyTimer) return;

  clearInterval(buyTimer);
  buyTimer = null;

  while (buyTickRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('[buyCaller] stopped', { reason });
}

export const startBuyCallerLoop = startBuyCaller;
export const stopBuyCallerLoop = stopBuyCaller;

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startBuyCaller();
}