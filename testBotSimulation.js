import dotenv from "dotenv";
import { SolanaDeepBuyBot } from "./buyCaller_pumpswap.js";

dotenv.config();

const mintArg = process.argv[2];
if (!mintArg) {
  console.error("Usage: node testBotSimulation.js <TOKEN_MINT>");
  process.exit(1);
}

(async () => {
  const bot = new SolanaDeepBuyBot(mintArg);

  console.log(`\n=== Starting limited simulation for ${mintArg} ===\n`);

  const TICKS_TO_RUN = 5; // Number of simulation steps
  let tickCount = 0;

  while (tickCount < TICKS_TO_RUN) {
    try {
      const result = await bot.tickAndReturn();

      // Print bot's internal state and reason for each tick
      console.log(
        `[TICK ${tickCount + 1}] State: ${result.state}, Reason: ${result.reason}, MarketCap: ${result.marketCap}, RSI: ${bot.lastRSI || "N/A"}`
      );

      // Wait for the bot's polling interval before next tick
      await new Promise((r) => setTimeout(r, bot.config.pollIntervalMs));

      tickCount++;
    } catch (err) {
      console.error("[SIMULATION_CRASH]", err);
      break;
    }
  }

  console.log("\n=== Simulation finished ===\n");
})();