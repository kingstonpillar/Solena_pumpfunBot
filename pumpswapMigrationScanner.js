import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const PUMPSWAP_MIGRATION_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const POLL_INTERVAL = 1200; // ms
const MAX_TRACKED = 1000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const lastSignatures = {};
let lastKnownSignature = null;

// Helper: send Telegram alert
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

// Helper: RPC limiter
async function withRpcLimit(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error("[RPC_ERROR]", err);
    return null;
  }
}

// ================= SCANNER FUNCTION =================
// This is the function you can import in index.js
export async function startScanner(onMigrationDetected, pollInterval = POLL_INTERVAL) {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL not defined in .env");

  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  console.log("[INIT] PumpSwap scanner started on RPC:", rpcUrl);

  while (true) {
    try {
      const now = Date.now();

      const signatures = await withRpcLimit(() =>
        connection.getSignaturesForAddress(PUMPSWAP_MIGRATION_PROGRAM_ID, { limit: 20 })
      );
      if (!signatures) {
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      const newSigs = lastKnownSignature
        ? signatures.filter(s => s.signature > lastKnownSignature)
        : signatures;

      if (newSigs.length > 0) lastKnownSignature = newSigs[0].signature;
      if (newSigs.length === 0) {
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      const recentSigs = newSigs.filter(s => s.blockTime && now - s.blockTime * 1000 <= 30 * 1000);
      if (recentSigs.length === 0) {
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      const txs = await Promise.all(
        recentSigs.map(sigInfo => withRpcLimit(() => connection.getTransaction(sigInfo.signature)))
      );

      txs.forEach((tx, index) => {
        const sigInfo = recentSigs[index];
        if (!tx) return;

        tx.transaction.message.instructions.forEach(instr => {
          if (!instr.programId.equals(PUMPSWAP_MIGRATION_PROGRAM_ID)) return;

          const mint = instr.accounts && instr.accounts[0] ? new PublicKey(instr.accounts[0].toString()) : null;
          if (!mint || lastSignatures[sigInfo.signature]) return;

          lastSignatures[sigInfo.signature] = true;
          if (Object.keys(lastSignatures).length > MAX_TRACKED) {
            const keys = Object.keys(lastSignatures).slice(0, 500);
            keys.forEach(k => delete lastSignatures[k]);
          }

          console.log("[MIGRATION_DETECTED]", mint.toBase58(), sigInfo.signature);
          sendTelegramAlert(`PumpSwap migration detected: ${mint.toBase58()}\nSignature: ${sigInfo.signature}`);

          // Send detected token to the callback
          if (onMigrationDetected) onMigrationDetected({ mint, signature: sigInfo.signature });
        });
      });

      await new Promise(r => setTimeout(r, pollInterval));
    } catch (err) {
      console.error("[SCANNER_ERROR]", err);
      await new Promise(r => setTimeout(r, pollInterval * 2));
    }
  }
}

// ================= SELF RUN (so node pumpswapMigrationScanner.js works) =================
if (process.argv[1] === new URL(import.meta.url).pathname) {
  // Run scanner directly with Node
  startScanner(({ mint, signature }) => {
    console.log("[SELF_RUN] Migration detected:", mint.toBase58(), signature);
  }).catch(err => console.error(err));
}