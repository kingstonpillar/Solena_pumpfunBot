// index.js (ESM)
// Master runner for modules (start/stop, no overlap inside modules)
//
// Modules:
// - buycaller_bonding.js
// - Sellcaller_pumpfun.js
// - walletbalance.js
// - pumpfun_Poll_Stage1.js
// - Crash-protection.js
// - active_PositionList.js

import "dotenv/config";

import { startBuyCaller, stopBuyCaller } from "./buyCaller_bonding.js";
import { startSellCaller, stopSellCaller } from "./Sellcaller_pumpfun.js";
import { startWalletReporter, stopWalletReporter } from "./walletbalance.js";
import { startBondingDetector, stopBondingDetector } from "./pumpfun_Poll_Stage1.js";
import { startCrashProtection, stopCrashProtection } from "./Crash-protection.js";
import {
  startActivePositionList,
  stopActivePositionList,
} from "./active_PositionList.js";

const ENABLED = {
  crashProtection: String(process.env.ENABLE_CRASH_PROTECTION || "true") === "true",
  bondingDetector: String(process.env.ENABLE_STAGE1_DETECTOR || "true") === "true",
  buyCaller: String(process.env.ENABLE_BUYCALLER || "true") === "true",
  sellCaller: String(process.env.ENABLE_SELLCALLER || "true") === "true",
  walletReporter: String(process.env.ENABLE_WALLET_REPORTER || "true") === "true",
  activePositionList: String(process.env.ENABLE_ACTIVE_POSITION_LIST || "true") === "true",
};

// ---------------- Master start/stop ----------------
let started = false;

export async function startAll() {
  if (started) return;
  started = true;

  console.log("[index] starting modules", ENABLED);

  if (ENABLED.crashProtection) startCrashProtection();

  if (ENABLED.bondingDetector) await startBondingDetector();

  if (ENABLED.buyCaller) startBuyCaller();

  if (ENABLED.sellCaller) startSellCaller();

  if (ENABLED.walletReporter) startWalletReporter();

  if (ENABLED.activePositionList) await startActivePositionList();

  console.log("[index] all started");
}

export async function stopAll(reason = "manual") {
  if (!started) return;
  started = false;

  console.log("[index] stopping modules", { reason });

  // Stop in reverse order (downstream first)
  await stopActivePositionList(reason).catch(() => {});

  await stopWalletReporter(reason).catch(() => {});

  await stopSellCaller(reason).catch(() => {});

  await stopBuyCaller(reason).catch(() => {});

  await stopBondingDetector(reason).catch(() => {});

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

// ---------------- Node direct entry ----------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  void startAll();
}
