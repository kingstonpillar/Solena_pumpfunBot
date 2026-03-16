// index.js (ESM)
// Master runner for modules (start/stop, no overlap inside modules)
//
// Modules:
// - buyCaller_bonding.js
// - SellCaller_pumpfun.js
// - walletbalance.js
// - Crash-protection.js
// - active_PositionList.js
// - dexscreenerScanner.js

import "dotenv/config";

import { startBuyCaller, stopBuyCaller } from "./buyCaller_bonding.js";
import { startSellCaller, stopSellCaller } from "./sellCaller_pumpfun.js";
import { startWalletReporter, stopWalletReporter } from "./walletbalance.js";
import { startCrashProtection, stopCrashProtection } from "./crash-protection.js";
import { startActivePositionList, stopActivePositionList } from "./active_PositionList.js";
import { startDexScanner, stopDexScanner } from "./dexscreenerScanner.js"; // <- correct API

const ENABLED = {
  crashProtection: String(process.env.ENABLE_CRASH_PROTECTION || "true") === "true",
  // bondingDetector removed
  buyCaller: String(process.env.ENABLE_BUYCALLER || "true") === "true",
  sellCaller: String(process.env.ENABLE_SELLCALLER || "true") === "true",
  walletReporter: String(process.env.ENABLE_WALLET_REPORTER || "true") === "true",
  activePositionList: String(process.env.ENABLE_ACTIVE_POSITION_LIST || "true") === "true",
  dexscreenerScanner: String(process.env.ENABLE_DEXSCREENER || "true") === "true",
};

// ---------------- Master start/stop ----------------
let started = false;

export async function startAll() {
  if (started) return;
  started = true;

  console.log("[index] starting modules", ENABLED);

  if (ENABLED.crashProtection) startCrashProtection();

  if (ENABLED.buyCaller) startBuyCaller();

  if (ENABLED.sellCaller) startSellCaller();

  if (ENABLED.walletReporter) startWalletReporter();

  if (ENABLED.activePositionList) await startActivePositionList();

  if (ENABLED.dexscreenerScanner) await startDexScanner(); // <- using proper module API

  console.log("[index] all started");
}

export async function stopAll(reason = "manual") {
  if (!started) return;
  started = false;

  console.log("[index] stopping modules", { reason });

  // Stop in reverse order
  await stopActivePositionList(reason).catch(() => {});
  await stopWalletReporter(reason).catch(() => {});
  await stopSellCaller(reason).catch(() => {});
  await stopBuyCaller(reason).catch(() => {});
  if (ENABLED.dexscreenerScanner) await stopDexScanner(); // <- stop DexScanner cleanly
  // Bonding detector removed
  await stopCrashProtection(reason).catch(() => {});

  console.log("[index] all stopped");
}

// ---------------- Process hooks ----------------
function bindSignals() {
  const shutdown = async (sig) => {
    console.log(`[index] received ${sig}, shutting down...`);
    await stopAll(sig);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bindSignals();

// Always start when index.js is executed
void startAll();