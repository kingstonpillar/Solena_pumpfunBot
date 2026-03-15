// pumpswapMigrationScanner.js
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { withRpcLimit } from "./rpcLimiter.js";

dotenv.config();

const PUMPSWAP_MIGRATION_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const lastSignatures = {};
let lastKnownSignature = null;
const MAX_TRACKED = 1000;

async function sendTelegramAlert(message, botToken, chatId) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    console.log("[TELEGRAM] Sending alert:", message);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    console.log("[TELEGRAM] Alert sent successfully.");
  } catch (err) {
    console.error("[TELEGRAM_ERROR]", err);
  }
}

export async function* newMigrationToken(telegram = {}, pollInterval = 1200) {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL not defined in .env");

  const connection = new Connection(rpcUrl);
  console.log("[INIT] Scanner initialized with RPC:", rpcUrl);
  console.log("[INIT] Monitoring PumpSwap migration program:", PUMPSWAP_MIGRATION_PROGRAM_ID.toBase58());

  while (true) {
    try {
      const now = Date.now();
      console.log("[POLL] Starting new poll cycle at", new Date(now).toISOString());

      const signatures = await withRpcLimit(() =>
        connection.getSignaturesForAddress(PUMPSWAP_MIGRATION_PROGRAM_ID, { limit: 20 })
      );
      console.log(`[POLL] Retrieved ${signatures.length} signatures.`);

      // Filter only new signatures
      const newSigs = lastKnownSignature
        ? signatures.filter(s => s.signature > lastKnownSignature)
        : signatures;

      if (newSigs.length > 0) lastKnownSignature = newSigs[0].signature;
      if (newSigs.length === 0) {
        console.log("[POLL] No new signatures this cycle.");
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      // Filter signatures older than 30 seconds before fetching transactions
      const recentSigs = newSigs.filter(s => s.blockTime && now - s.blockTime * 1000 <= 30 * 1000);
      if (recentSigs.length === 0) {
        console.log("[POLL] No recent signatures to process.");
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      // Fetch transactions in parallel
      const txs = await Promise.all(
        recentSigs.map(sigInfo =>
          withRpcLimit(() => connection.getTransaction(sigInfo.signature, { commitment: "confirmed" }))
        )
      );

      txs.forEach((tx, index) => {
        const sigInfo = recentSigs[index];
        if (!tx) {
          console.log("[TX] Transaction not found or not confirmed:", sigInfo.signature);
          return;
        }

        const instructions = tx.transaction.message.instructions;

        instructions.forEach(instr => {
          // Only process instructions from PumpSwap migration program
          if (!instr.programId.equals(PUMPSWAP_MIGRATION_PROGRAM_ID)) return;

          // Parse mint from first account
          const mint = instr.accounts && instr.accounts[0] ? new PublicKey(instr.accounts[0].toString()) : null;
          if (!mint) return;

          if (lastSignatures[sigInfo.signature]) return;

          console.log(`[MIGRATION_DETECTED] Token: ${mint.toBase58()} | Signature: ${sigInfo.signature}`);

          // Send Telegram alert
          if (telegram?.botToken && telegram?.chatId) {
            const message = `PumpSwap migration detected: ${mint.toBase58()}\nSignature: ${sigInfo.signature}`;
            sendTelegramAlert(message, telegram.botToken, telegram.chatId);
          }

          lastSignatures[sigInfo.signature] = true;

          // Limit memory growth
          if (Object.keys(lastSignatures).length > MAX_TRACKED) {
            const keys = Object.keys(lastSignatures).slice(0, 500);
            keys.forEach(k => delete lastSignatures[k]);
          }

          // Yield detected migration
          yield { mint, signature: sigInfo.signature };
        });
      });

      console.log(`[POLL] Polling cycle complete. Waiting ${pollInterval}ms for next poll.`);
      await new Promise(r => setTimeout(r, pollInterval));
    } catch (err) {
      console.error("[POLLING_ERROR]", err);
      console.log(`[POLL] Waiting ${pollInterval * 2}ms before retry.`);
      await new Promise(r => setTimeout(r, pollInterval * 2));
    }
  }
}