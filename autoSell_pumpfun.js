// autoSell_pumpfun.js (ESM)
// Pump.fun sell executor using PumpPortal trade-local (returns tx for your local signing).
// Sends Telegram alert on successful sell confirmation.
//
// Env additions:
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID

import fs from "fs";
import crypto from "crypto";
import bs58 from "bs58";
import dotenv from "dotenv";
import fetch from "node-fetch";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";

import { getAssociatedTokenAddress } from "@solana/spl-token";

dotenv.config();

const RPC_URL =
  process.env.RPC_URL_5 || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const DEFAULT_SLIPPAGE_PCT = Number(process.env.SELL_SLIPPAGE_PCT || 10); // percent
const DEFAULT_PRIORITY_FEE = Number(process.env.SELL_PRIORITY_FEE || 0.00001); // SOL
const DEFAULT_POOL = process.env.SELL_POOL || "pump"; // "pump" | "auto" | etc

const COMMITMENT = process.env.COMMITMENT || "confirmed";

// ---- Telegram ----
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch {}
}

function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWallet() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) {
    throw new Error("Passphrase file missing: " + passphrasePath);
  }

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secret = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secret);
}

async function assertTokenBalance(conn, owner, mint) {
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner);
  const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
  const ui = Number(bal?.value?.uiAmount || 0);
  if (ui <= 0) {
    throw new Error(`No token balance for mint ${mint}`);
  }
  return ui;
}

function mustMint(m) {
  if (!m || typeof m !== "string") throw new Error("mint is required (string)");
  return m.trim();
}

export async function executeAutoSellPumpfun({
  mint,
  amount = "100%", // can be "100%" or token amount (number/string)
  slippagePct = DEFAULT_SLIPPAGE_PCT,
  priorityFee = DEFAULT_PRIORITY_FEE,
  pool = DEFAULT_POOL,
} = {}) {
  const m = mustMint(mint);

  const wallet = getWallet();
  const publicKey = wallet.publicKey.toBase58();

  const body = {
    publicKey,
    action: "sell",
    mint: m,
    amount: String(amount),
    denominatedInSol: "false",
    slippage: Number(slippagePct),
    priorityFee: Number(priorityFee),
    pool: String(pool || "pump"),
  };

  // DRY RUN
  if (DRY_RUN) {
    await sendTelegram(
      `🟡 DRY_RUN sell skipped\nmint: ${m}\namount: ${String(amount)}\npool: ${String(pool || "pump")}`
    );
    return {
      ok: true,
      dryRun: true,
      wouldPostTo: "https://pumpportal.fun/api/trade-local",
      requestBody: body,
      note: "DRY_RUN=true so no tx was requested/signed/sent",
    };
  }

  // 1) Request unsigned tx bytes from PumpPortal
  const resp = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    await sendTelegram(
      `🔴 SELL request failed\nmint: ${m}\nstatus: ${resp.status}\nmsg: ${txt || resp.statusText}`
    );
    throw new Error(`trade-local failed ${resp.status}: ${txt || resp.statusText}`);
  }

  const buf = await resp.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(buf));

  // 2) Sign locally
  tx.sign([wallet]);

  // 3) Send via your RPC
  const conn = new Connection(RPC_URL, COMMITMENT);

  // check balance before sending (your logic)
  const uiBal = await assertTokenBalance(conn, wallet.publicKey, m);

  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction(sig, COMMITMENT);

  // ✅ Only here = confirmed success
  await sendTelegram(
    `✅ SELL CONFIRMED\nmint: ${m}\namount: ${String(amount)}\npreBal(ui): ${uiBal}\npool: ${String(pool)}\nslippage%: ${Number(slippagePct)}\npriorityFee: ${Number(priorityFee)}\nsig: ${sig}`
  );

  return {
    ok: true,
    dryRun: false,
    signature: sig,
    mint: m,
    soldAmount: String(amount),
    slippagePct: Number(slippagePct),
    priorityFee: Number(priorityFee),
    pool: String(pool),
  };
}