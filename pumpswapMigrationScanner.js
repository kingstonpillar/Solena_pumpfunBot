// pumpswapMigrationScanner.js
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const PUMPSWAP_MIGRATION_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const lastSignatures = {};

async function sendTelegramAlert(message, botToken, chatId) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
  } catch (err) {
    console.error("[TELEGRAM_ERROR]", err);
  }
}

/**
 * Async generator scanner for PumpSwap migrations.
 * Yields `mint` as PublicKey, compatible with consuming module.
 */
export async function* newMigrationToken(telegram = {}, pollInterval = 1000) {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL not defined in .env");

  const connection = new Connection(rpcUrl);

  while (true) {
    try {
      const now = Date.now();

      const signatures = await connection.getSignaturesForAddress(
        PUMPSWAP_MIGRATION_PROGRAM_ID,
        { limit: 20 }
      );

      for (const sigInfo of signatures.reverse()) {
        const txTime = sigInfo.blockTime ? sigInfo.blockTime * 1000 : now;
        if (now - txTime > 30 * 1000) continue;

        if (lastSignatures[sigInfo.signature]) continue;

        const tx = await connection.getTransaction(sigInfo.signature, { commitment: "confirmed" });
        if (!tx) continue;

        const instructions = tx.transaction.message.instructions;
        for (const instr of instructions) {
          const tokenMintStr = instr.data.toString();
          if (tokenMintStr) {
            const mint = new PublicKey(tokenMintStr); // yield as PublicKey
            console.log("[MIGRATION_DETECTED]", mint.toBase58(), sigInfo.signature);

            if (telegram?.botToken && telegram?.chatId) {
              const message = `🚨 PumpSwap migration detected: ${mint.toBase58()}\nSignature: ${sigInfo.signature}`;
              await sendTelegramAlert(message, telegram.botToken, telegram.chatId);
            }

            lastSignatures[sigInfo.signature] = true;

            // Yield mint as PublicKey and signature
            yield { mint, signature: sigInfo.signature };
          }
        }
      }

      await new Promise(r => setTimeout(r, pollInterval));
    } catch (err) {
      console.error("[POLLING_ERROR]", err);
      await new Promise(r => setTimeout(r, pollInterval * 2));
    }
  }
}