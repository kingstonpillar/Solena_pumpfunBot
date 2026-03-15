import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { withRpcLimit } from "./rpcLimiter.js"; // <- use your limiter

dotenv.config();

const PUMPSWAP_MIGRATION_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const POLL_INTERVAL = 1200; // ms
const MAX_TRACKED = 1000;

// ================= Helper: send Telegram alert =================
async function sendTelegramAlert(message, botToken, chatId) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    console.log("[TELEGRAM] Alert sent:", message);
  } catch (err) {
    console.error("[TELEGRAM_ERROR]", err);
  }
}

// ================= Async generator =================
export async function* newMigrationToken({ botToken, chatId } = {}, pollInterval = POLL_INTERVAL) {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL not defined in .env");

  const connection = new Connection(rpcUrl, { 
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0 // fix for transaction version error
  });
  console.log("[INIT] PumpSwap scanner started on RPC:", rpcUrl);

  const lastSignatures = {};
  let lastKnownSignature = null;

  while (true) {
    try {
      const now = Date.now();

      // Fetch signatures via centralized RPC limiter
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

      // Fetch transactions via centralized RPC limiter
      const txs = await Promise.all(
        recentSigs.map(sigInfo => withRpcLimit(() =>
          connection.getTransaction(sigInfo.signature)
        ))
      );

      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        const sigInfo = recentSigs[i];
        if (!tx) continue;

        for (const instr of tx.transaction.message.instructions) {
          if (!instr.programId.equals(PUMPSWAP_MIGRATION_PROGRAM_ID)) continue;

          const mint = instr.accounts && instr.accounts[0] ? new PublicKey(instr.accounts[0].toString()) : null;
          if (!mint || lastSignatures[sigInfo.signature]) continue;

          lastSignatures[sigInfo.signature] = true;

          if (Object.keys(lastSignatures).length > MAX_TRACKED) {
            const keys = Object.keys(lastSignatures).slice(0, 500);
            keys.forEach(k => delete lastSignatures[k]);
          }

          console.log("[MIGRATION_DETECTED]", mint.toBase58(), sigInfo.signature);
          sendTelegramAlert(`PumpSwap migration detected: ${mint.toBase58()}\nSignature: ${sigInfo.signature}`, botToken, chatId);

          yield { mint, signature: sigInfo.signature };
        }
      }

      await new Promise(r => setTimeout(r, pollInterval));
    } catch (err) {
      console.error("[SCANNER_ERROR]", err);
      await new Promise(r => setTimeout(r, pollInterval * 2));
    }
  }
}

// ================= SELF RUN =================
if (process.argv[1] === new URL(import.meta.url).pathname) {
  (async () => {
    for await (const { mint, signature } of newMigrationToken({ botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID })) {
      console.log("[SELF_RUN] Migration detected:", mint.toBase58(), signature);
    }
  })().catch(err => console.error(err));
}