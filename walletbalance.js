// walletbalance.js — Hourly Wallet + Positions PnL Reporter (Pump.fun price module)

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

import { getPumpFunPriceOnce } from "./pumpfun_price.js";

dotenv.config();

// ================= CONFIG =================
const RPC_URL = process.env.RPC_URL || process.env.RPC_URL_5 || "https://api.mainnet-beta.solana.com";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ACTIVE_POSITIONS_FILE = path.resolve(process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json");

// run every 1 hour by default
const HEARTBEAT_MINUTES = Number(process.env.WALLET_HEARTBEAT_MINUTES || 60);

// optional: cap how many positions to print
const MAX_POSITIONS_PRINT = Number(process.env.MAX_POSITIONS_PRINT || 25);

const conn = new Connection(RPC_URL, "confirmed");

// ================= EXPORTS =================
// If other modules depend on these, keep them exported.
// You can update the logic later if you want trade sizing tied to balance.
export let currentTradeAmount = 0;
export let computeUnitPerTrade = 0;

// ================= HELPERS =================
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.log("Telegram error:", err?.message || err);
  }
}

function fmt(n, d = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0";
  return x.toFixed(d);
}

function nowStr() {
  return new Date().toLocaleString();
}

function normalizeMint(pos) {
  return pos?.mintAddress || pos?.mint || null;
}

function normalizeEntryPrice(pos) {
  const p = pos?.entryPrice ?? pos?.buyPrice ?? null;
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ================= WALLET READS =================
async function getWalletSolBalance(pubkey) {
  try {
    const lamports = await conn.getBalance(pubkey);
    return lamports / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

async function listWalletSplTokens(pubkey) {
  // Returns [{ mint, uiAmount }]
  try {
    const res = await conn.getParsedTokenAccountsByOwner(pubkey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
    const out = [];

    for (const a of res?.value || []) {
      const info = a?.account?.data?.parsed?.info;
      const mint = info?.mint;
      const ui = Number(info?.tokenAmount?.uiAmount ?? info?.tokenAmount?.uiAmountString ?? 0);
      if (mint && Number.isFinite(ui) && ui > 0) out.push({ mint, uiAmount: ui });
    }

    // highest value in wallet unknown, so sort by amount
    out.sort((x, y) => (y.uiAmount - x.uiAmount));
    return out;
  } catch {
    return [];
  }
}

function getWalletTokenAmount(walletTokens, mint) {
  const found = walletTokens.find((t) => t.mint === mint);
  return found ? Number(found.uiAmount) : 0;
}

// ================= POSITIONS REPORT =================
async function buildPositionsReport(walletTokens) {
  const positions = safeReadJson(ACTIVE_POSITIONS_FILE, []);
  const list = Array.isArray(positions) ? positions : [];

  if (list.length === 0) {
    return {
      lines: ["No active positions in active_positions.json"],
      totalValueSol: 0,
      totalCostSol: 0,
    };
  }

  const lines = [];
  let totalValueSol = 0;
  let totalCostSol = 0;

  const sliced = list.slice(0, MAX_POSITIONS_PRINT);

  for (const pos of sliced) {
    const mint = normalizeMint(pos);
    if (!mint) continue;

    const entryPrice = normalizeEntryPrice(pos);
    const tokenAmt = getWalletTokenAmount(walletTokens, mint);

    // Price from Pump.fun vault method
    // getPumpFunPriceOnce expects record.mint and record.migration.signature (unless vault already cached)
    const priceRes = await getPumpFunPriceOnce({
      mint,
      migration: pos?.migration || pos?.raydium?.rawTx ? pos.migration : pos?.migration, // keep simple
    }).catch(() => ({ error: "price_fetch_failed" }));

    const priceSOL = priceRes?.priceSOL;
    const hasPrice = Number.isFinite(priceSOL) && priceSOL > 0;

    const estValueSol = hasPrice ? tokenAmt * priceSOL : 0;

    // If you stored amountSol at entry, use it as cost basis.
    // Otherwise approximate cost basis = tokenAmt * entryPrice.
    const amountSol = Number(pos?.amountSol ?? pos?.amount ?? 0);
    const hasAmountSol = Number.isFinite(amountSol) && amountSol > 0;
    const estCostSol = hasAmountSol
      ? amountSol
      : (entryPrice && tokenAmt ? tokenAmt * entryPrice : 0);

    totalValueSol += estValueSol;
    totalCostSol += estCostSol;

    let pct = null;
    if (entryPrice && hasPrice) {
      pct = ((priceSOL - entryPrice) / entryPrice) * 100;
    }

    const pctStr = pct == null ? "n/a" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    const priceStr = hasPrice ? fmt(priceSOL, 10) : "n/a";

    lines.push(
      `• \`${mint}\`\n` +
      `  amt: *${fmt(tokenAmt, 4)}* | entry: *${entryPrice ? fmt(entryPrice, 10) : "n/a"}* | now: *${priceStr}*\n` +
      `  pnl: *${pctStr}* | value≈ *${fmt(estValueSol, 4)} SOL*`
    );
  }

  if (list.length > MAX_POSITIONS_PRINT) {
    lines.push(`…and ${list.length - MAX_POSITIONS_PRINT} more positions not shown`);
  }

  return { lines, totalValueSol, totalCostSol };
}

// ================= MAIN HEARTBEAT =================
export async function sendHourlyWalletReport() {
  if (!WALLET_ADDRESS) {
    console.log("WALLET_ADDRESS missing in env");
    return;
  }

  const walletPub = new PublicKey(WALLET_ADDRESS);

  const solBal = await getWalletSolBalance(walletPub);
  const walletTokens = await listWalletSplTokens(walletPub);

  const { lines, totalValueSol, totalCostSol } = await buildPositionsReport(walletTokens);

  const pnlSol = totalValueSol - totalCostSol;
  const pnlPct = totalCostSol > 0 ? (pnlSol / totalCostSol) * 100 : null;

  const header =
    `⏱ *Wallet Report*\n\n` +
    `👛 Wallet: \`${WALLET_ADDRESS}\`\n` +
    `💰 SOL: *${fmt(solBal, 6)}*\n` +
    `📦 Positions: *${safeReadJson(ACTIVE_POSITIONS_FILE, []).length || 0}*\n\n`;

  const totals =
    `📊 *Positions Totals*\n` +
    `Value≈ *${fmt(totalValueSol, 4)} SOL*\n` +
    `Cost≈ *${fmt(totalCostSol, 4)} SOL*\n` +
    `PnL≈ *${fmt(pnlSol, 4)} SOL*` +
    (pnlPct == null ? "" : ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`) +
    `\n\n`;

  const footer = `🕒 ${nowStr()}`;

  const body = lines.join("\n\n");
  const msg = header + totals + body + "\n\n" + footer;

  await sendTelegram(msg);
  console.log("[WALLET] report sent");
}

// ================= LOOP (start/stop + NO overlap) =================
let walletTimer = null;
let walletTickRunning = false;

async function runWalletTick(label) {
  if (walletTickRunning) return;

  walletTickRunning = true;
  try {
    await sendHourlyWalletReport();
  } catch (e) {
    console.error(`[walletbalance] ${label} error:`, e?.message || e);
  } finally {
    walletTickRunning = false;
  }
}

// Public API for index.js / PM2
export function startWalletReporter() {
  if (walletTimer) return;

  console.log("[walletbalance] started", { HEARTBEAT_MINUTES });

  // run once immediately (non-blocking)
  void runWalletTick("initial tick");

  // schedule
  walletTimer = setInterval(() => {
    void runWalletTick("loop tick");
  }, HEARTBEAT_MINUTES * 60 * 1000);
}

export async function stopWalletReporter(reason = "manual") {
  if (!walletTimer) return;

  clearInterval(walletTimer);
  walletTimer = null;

  // wait for in-flight tick to finish
  while (walletTickRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[walletbalance] stopped", { reason });
}

// Backward compatible aliases
export const startLoop = startWalletReporter;
export const stopLoop = stopWalletReporter;

// NODE direct entry
if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log("[NODE] walletbalance.js running");
  startWalletReporter();
}