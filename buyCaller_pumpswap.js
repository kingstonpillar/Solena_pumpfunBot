// buyCaller_pumpswap.js
import { startScanner } from "./pumpswapMigrationScanner.js";
import { checkTokenSecurity } from "./tokensecurities.js";
import { checkToken2022ExtensionsSafety } from "./token2022ExtensionsGate.js";
import { executeAmmMigrationBuy } from "./swapexecutorAMM_pumpswap.js"; // <- real executor
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import dotenv from "dotenv";

dotenv.config();

// ------------------ CONNECTION ------------------
const conn = new Connection(process.env.RPC_URL_3, { commitment: "processed" });

console.log("PumpSwap migration processor running... waiting for migrations.");

// ------------------ SCANNER CALLBACK ------------------
startScanner(({ mint, signature }) => {
  console.log("=== Migration Detected ===");
  console.log("Token Mint:", mint.toBase58());
  console.log("Signature:", signature);

  // Run async tasks without awaiting
  checkTokenSecurity(mint.toBase58(), conn)
    .then(securityRes => {
      console.log("[SECURITY]", securityRes);
      if (!securityRes.safe) {
        console.log("[BLOCKED] Failed basic security check:", mint.toBase58());
        return;
      }

      return conn.getAccountInfo(mint);
    })
    .then(mintInfo => {
      if (!mintInfo) return;

      if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return checkToken2022ExtensionsSafety(conn, mint.toBase58())
          .then(token2022Safe => {
            console.log("[TOKEN-2022 RESULT]", token2022Safe);
            if (!token2022Safe.ok) {
              console.log("[BLOCKED] Token-2022 unsafe:", mint.toBase58());
              return;
            }

            return executeAmmMigrationBuy({
              mint,
              amountRaw: process.env.SOL_TO_SPEND || undefined,
              slippageFrac: 0.005,
            }).then(buyResult => {
              console.log("[BUY_SUCCESS]", buyResult);
            }).catch(err => {
              console.error("[BUY_FAILED]", err.message);
            });
          });
      } else {
        return executeAmmMigrationBuy({
          mint,
          amountRaw: process.env.SOL_TO_SPEND || undefined,
          slippageFrac: 0.005,
        }).then(buyResult => {
          console.log("[BUY_SUCCESS]", buyResult);
        }).catch(err => {
          console.error("[BUY_FAILED]", err.message);
        });
      }
    })
    .catch(err => {
      console.error("[PROCESS_ERROR]", err);
    });
});