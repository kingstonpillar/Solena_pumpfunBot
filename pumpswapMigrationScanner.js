// pumpswapMigrationScanner.js
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ---------------- CONFIG ----------------
const PUMPSWAP_MIGRATION_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS || 1200);
const MAX_TRACKED = 1000;
const TIMESTAMP_THRESHOLD_MS = 30 * 1000; // 30 seconds old

// ---------------- RPC FAILOVER ----------------
const RPC_URLS = [process.env.RPC_URL_1, process.env.RPC_URL_2, process.env.RPC_URL_3].filter(Boolean);
if (!RPC_URLS.length) throw new Error("No RPC endpoints configured");

let activeRpcUrl = RPC_URLS[0];
let connection = new Connection(activeRpcUrl, { commitment: "confirmed" });

function switchRpc(url) {
  activeRpcUrl = url;
  connection = new Connection(activeRpcUrl, { commitment: "confirmed" });
}

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable")
  );
}

async function withRpcFailover(opName, fn) {
  let lastErr = null;
  for (const url of RPC_URLS) {
    if (activeRpcUrl !== url) switchRpc(url);
    try {
      return await fn(connection);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
      console.warn(`[RPC_FAILOVER] ${opName} failed on ${url}, trying next`);
    }
  }
  throw new Error(`[RPC_FAILOVER] ${opName} failed on all RPCs. last=${lastErr?.message || lastErr}`);
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

// ---------------- TELEGRAM ALERT ----------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
    console.log("[TELEGRAM] Alert sent:", message);
  } catch (err) {
    console.error("[TELEGRAM_ERROR]", err);
  }
}

// ---------------- STATE ----------------
let lastSlot = 0;
let seenSigs = new Set();
let seenMints = new Set();

// ---------------- SCANNER ----------------
export async function startScanner(onMigrationDetected, pollInterval = POLL_INTERVAL) {
  try {
    lastSlot = await rpcLimited("getSlot(init)", c => c.getSlot());
  } catch {
    lastSlot = 0;
  }

  console.log("[+] PumpSwap migration scanner started");
  console.log(`[+] RPC order: ${RPC_URLS.join(" -> ")}`);

  while (true) {
    try {
      const currentSlot = await rpcLimited("getSlot(loop)", c => c.getSlot());
      const endSlot = Math.min(currentSlot, lastSlot + 10); // limit per tick

      for (let slot = lastSlot + 1; slot <= endSlot; slot++) {
        const block = await rpcLimited("getBlock", c =>
          c.getBlock(slot, {
            commitment: "confirmed",
            transactionDetails: "full",
            maxSupportedTransactionVersion: 1
          })
        );
        if (!block?.transactions) continue;

        const now = Date.now();

        for (const tx of block.transactions) {
          const sig = tx.transaction?.signatures?.[0];
          const blockTime = tx.blockTime ? tx.blockTime * 1000 : null;
          if (!sig || seenSigs.has(sig)) continue;

          // Skip transactions older than 30 seconds
          if (!blockTime || now - blockTime > TIMESTAMP_THRESHOLD_MS) continue;

          seenSigs.add(sig);

          // Flatten instructions + inner instructions
          const msg = tx.transaction?.message;
          if (!msg) continue;

          const instructions = Array.isArray(msg.instructions) ? msg.instructions : [];
          const innerGroups = Array.isArray(tx.meta?.innerInstructions) ? tx.meta.innerInstructions : [];
          const allInstructions = [...instructions];
          for (const g of innerGroups) if (Array.isArray(g?.instructions)) allInstructions.push(...g.instructions);

          const touchesProgram = allInstructions.some(ix => ix?.programId?.equals?.(PUMPSWAP_MIGRATION_PROGRAM_ID));
          if (!touchesProgram) continue;

          // Extract mint safely
          const mintStr = tx?.meta?.postTokenBalances?.[0]?.mint;
          if (!mintStr || seenMints.has(mintStr)) continue;
          seenMints.add(mintStr);

          const mint = new PublicKey(mintStr);

          console.log("[MIGRATION_DETECTED]", mint.toBase58(), sig);
          sendTelegramAlert(`PumpSwap migration detected: ${mint.toBase58()}\nSignature: ${sig}`);

          if (onMigrationDetected) onMigrationDetected({ mint, signature: sig });

          // Limit tracked size
          if (seenSigs.size > MAX_TRACKED) {
            const oldKeys = Array.from(seenSigs).slice(0, 500);
            oldKeys.forEach(k => seenSigs.delete(k));
          }
          if (seenMints.size > MAX_TRACKED) {
            const oldKeys = Array.from(seenMints).slice(0, 500);
            oldKeys.forEach(k => seenMints.delete(k));
          }
        }

        lastSlot = slot;
      }

      await new Promise(r => setTimeout(r, pollInterval));
    } catch (err) {
      console.error("[SCANNER_ERROR]", err);
      await new Promise(r => setTimeout(r, pollInterval * 2));
    }
  }
}

// ---------------- SELF RUN ----------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  startScanner(({ mint, signature }) => {
    console.log("[SELF_RUN] Migration detected:", mint.toBase58(), signature);
  }).catch(console.error);
}