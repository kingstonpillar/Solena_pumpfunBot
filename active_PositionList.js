
// active_PositionList.js (ESM)
// Reads active_positions.json, pulls current Pump.fun price, computes % PnL per token,
// and sends a numbered summary to Telegram every 45 minutes with NO overlapping ticks.

import "dotenv/config";
import fs from "fs";
import path from "path";
import PQueue from "p-queue";
import fetch from "node-fetch";
import bs58 from "bs58";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";

const ACTIVE_POSITIONS_FILE = path.resolve(
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json"
);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const INTERVAL_MS = Number(process.env.POSITION_ALERT_INTERVAL_MS || 45 * 60 * 1000);

const PRICE_INTERVAL_CAP = Number(process.env.PRICE_INTERVAL_CAP || 6);
const PRICE_INTERVAL_MS = Number(process.env.PRICE_INTERVAL_MS || 1000);

const priceQueue = new PQueue({
  intervalCap: PRICE_INTERVAL_CAP,
  interval: PRICE_INTERVAL_MS,
  carryoverConcurrencyCount: true,
});

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function is32ByteBase58(s) {
  try {
    return bs58.decode(String(s)).length === 32;
  } catch {
    return false;
  }
}

function pickMintFromPos(pos) {
  const a = String(pos?.mintAddress || "").trim();
  const b = String(pos?.mint || "").trim();

  // Prefer mintAddress if valid (your file has the real one there)
  if (a && is32ByteBase58(a)) return a;
  if (b && is32ByteBase58(b)) return b;

  return "";
}

function pickEntryPriceFromPos(pos) {
  // Accept both schemas: buyPriceSOL (new) or entryPrice (your current file)
  const a = Number(pos?.buyPriceSOL);
  if (Number.isFinite(a) && a > 0) return a;

  const b = Number(pos?.entryPrice);
  if (Number.isFinite(b) && b > 0) return b;

  return null;
}

function pctChange(entryPrice, currentPrice) {
  const a = Number(entryPrice);
  const b = Number(currentPrice);
  if (!Number.isFinite(a) || a <= 0) return null;
  if (!Number.isFinite(b) || b <= 0) return null;
  return ((b - a) / a) * 100;
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: String(text),
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchOnePosition(pos) {
  const mint = pickMintFromPos(pos);
  if (!mint) {
    return { ok: false, err: "missing_or_invalid_mint", raw: pos?.mintAddress || pos?.mint || null };
  }

  const entry = pickEntryPriceFromPos(pos);

  const candidate = {
    mint,
    bondingCurve: pos?.bondingCurve || pos?.curve || null,
  };

  const priceRes = await getPumpFunPriceOnce(candidate).catch((e) => ({
    priceSOL: null,
    source: "pumpfun_price_error",
    error: String(e?.message || e || "pumpfun_price_failed"),
  }));

  const cur = Number(priceRes?.priceSOL);
  const pnlPct = entry == null ? null : pctChange(entry, cur);

  return {
    ok: true,
    mint,
    entryPriceSOL: entry,
    currentPriceSOL: Number.isFinite(cur) ? cur : null,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
    openedAt: pos?.openedAt || pos?.timestamp || null,
    priceSource: priceRes?.source || "pumpfun_price",
    error: priceRes?.error || null,
  };
}

function buildMessage(rows) {
  const now = new Date().toISOString();

  if (!rows.length) {
    return `Active Positions PnL\nTime: ${now}\n\nNo active positions found.`;
  }

  const sorted = [...rows].sort((a, b) => {
    const ap = Number.isFinite(a?.pnlPct) ? a.pnlPct : -Infinity;
    const bp = Number.isFinite(b?.pnlPct) ? b.pnlPct : -Infinity;
    return bp - ap;
  });

  const blocks = [];
  let i = 1;

  for (const r of sorted) {
    if (!r.ok) {
      blocks.push(`Mints ${i}\nERROR\n${r.err}\nraw=${r.raw ?? "n/a"}`);
      i += 1;
      continue;
    }

    const pnl = r.pnlPct == null ? "n/a" : `${r.pnlPct.toFixed(2)}%`;

    blocks.push(
      `Mints ${i}\n` +
      `${r.mint}\n` +
      `Present Profit=${pnl}`
    );

    i += 1;
  }

  return `Active Positions PnL\nTime: ${now}\n\n${blocks.join("\n\n")}`;
}

async function runOnce() {
  const arr = safeReadJson(ACTIVE_POSITIONS_FILE, []);
  const positions = Array.isArray(arr) ? arr : [];

  const tasks = positions.map((p) => priceQueue.add(() => fetchOnePosition(p)));
  const results = await Promise.all(tasks);

  const msg = buildMessage(results);
  await sendTelegram(msg);

  console.log("[active_PositionList] sent", { count: results.length });
}

let timer = null;
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await runOnce();
  } catch (e) {
    const err = String(e?.message || e || "unknown_error");
    console.error("[active_PositionList] tick error:", err);
    await sendTelegram(`⚠️ active_PositionList error\n${err}`);
  } finally {
    tickRunning = false;
  }
}

export async function startActivePositionList() {
  if (timer) return;

  console.log("[active_PositionList] started", {
    file: ACTIVE_POSITIONS_FILE,
    intervalMs: INTERVAL_MS,
    priceIntervalCap: PRICE_INTERVAL_CAP,
    priceIntervalMs: PRICE_INTERVAL_MS,
  });

  await tick();

  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
}

export async function stopActivePositionList(reason = "manual") {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("[active_PositionList] stopped", { reason });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startActivePositionList();
}
