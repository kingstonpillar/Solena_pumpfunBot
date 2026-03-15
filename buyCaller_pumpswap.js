import { newMigrationToken } from "./pumpswapMigrationScanner.js";
import { checkTokenSecurity } from "./tokensecurities.js";
import { checkToken2022ExtensionsSafety } from "./token2022ExtensionsGate.js";
import { executeAmmMigrationBuy } from "./swapexecutorAMM_pumpswap.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const conn = new Connection(process.env.RPC_URL_3, { commitment: "processed" });

(async () => {
  console.log("PumpSwap migration scanner running... waiting for migrations.");

  for await (const { mint, signature } of newMigrationToken({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  })) {
    console.log("=== Migration Detected ===");
    console.log("Token Mint:", mint.toBase58());
    console.log("Signature:", signature);

    try {
      // Step 1: Basic security check (applies to all tokens)
      const securityRes = await checkTokenSecurity(mint.toBase58(), conn);
      console.log("[SECURITY]", securityRes);
      if (!securityRes.safe) {
        console.log("[BLOCKED] Failed basic security check:", mint.toBase58());
        continue;
      }

      // Step 2: Conditional Token-2022 extra check
      let token2022Safe = { ok: true, reason: "not_token2022" };
      const mintInfo = await conn.getAccountInfo(mint);

      if (mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        console.log("[TOKEN-2022] Detected, checking extensions...");
        token2022Safe = await checkToken2022ExtensionsSafety(conn, mint.toBase58());
        console.log("[TOKEN-2022 RESULT]", token2022Safe);

        if (!token2022Safe.ok) {
          console.log("[BLOCKED] Token-2022 unsafe:", mint.toBase58());
          continue;
        }
      }

      // Step 3: Execute AMM buy
      try {
        const buyResult = await executeAmmMigrationBuy({
          mint,
          amountRaw: process.env.SOL_TO_SPEND || undefined,
          slippageFrac: 0.005,
        });
        console.log("[BUY_SUCCESS]", buyResult);
      } catch (err) {
        console.error("[BUY_FAILED]", err.message);
      }

    } catch (err) {
      console.error("[PROCESS_ERROR]", err);
      continue;
    }
  }
})();