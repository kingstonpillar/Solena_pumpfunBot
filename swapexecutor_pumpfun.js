import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import bs58 from "bs58";
import fetch from "node-fetch";
import { PublicKey, Connection, Keypair, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import PQueue from "p-queue";
import { getAccount, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getPumpFunPriceOnce } from "./pumpfun_price.js";
import { fetchSolPriceUSD } from './solPriceFetcher.js';
dotenv.config();

// ---------------- CONFIG ----------------
const COMMITMENT = "confirmed";  // Removed up.COMMITMENT, set default directly

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ACTIVE_POSITIONS_FILE = path.resolve(process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json");
const MAX_ENTRY = Number(process.env.MAX_ENTRY || 1);
const DRY_RUN = String(process.env.DRY_RUN || "true") === "true";
const INPUT_SOL = Number(process.env.BUY_INPUT_SOL || 50);  // Amount of SOL to spend
const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 150);
const JUP_QUOTE_BASE = process.env.JUP_QUOTE_BASE || "https://api.jup.ag";
const JUP_API_KEY = process.env.JUP_API_KEY || "";
const JUP_TIMEOUT_MS = Number(process.env.JUP_TIMEOUT_MS || 12_000);

const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

// Use SIGNER_URL_1 and SIGNER_URL_2 from environment variables
const SIGNER_URL_1 = process.env.SIGNER_URL_1 || "";
const SIGNER_URL_2 = process.env.SIGNER_URL_2 || "";

function pickRpcCandidates() {
  // Only use SIGNER_URL_1 and SIGNER_URL_2 from environment variables
  const candidates = [SIGNER_URL_1, SIGNER_URL_2].filter(Boolean);  // Filters out any undefined or null URLs

  if (candidates.length === 0) {
    throw new Error("❌ Missing SIGNER URLs in environment variables");
  }

  return candidates;
}

// Get the available RPC candidates (only SIGNER_URL_1 and SIGNER_URL_2)
let candidates = pickRpcCandidates();  
let activeRpcUrl = candidates[0];  // Default to the first URL from the candidates
let conn = new Connection(activeRpcUrl, 'confirmed');  // Create the connection using the active RPC URL

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("node is behind") ||
    msg.includes("block height exceeded")
  );
}

function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, 'confirmed');
}

// Handle RPC failover with PQueue rate-limited requests
async function withRpcFailover(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      // Using PQueue to ensure rate limiting and concurrency control
      return await rpcQueue.add(() => fn(conn));  // Add function to queue
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
      continue;
    }
  }

  const msg = String(lastErr?.message || lastErr || "unknown_error");
  throw new Error(`[RPC_FAILOVER] ${opName} failed on all RPCs. last=${msg}`);
}

// -------------------- WATCHER --------------------

let watcherActive = true;

export async function startWatcher() {
  watcherActive = true;
  await sendTelegram("🟢 Liquidity Watcher Started");
}

export async function stopWatcher() {
  watcherActive = false;
  await sendTelegram("🔴 Liquidity Watcher Stopped");
}

// ---------------- Wallet Decrypt Function ----------------
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
  if (!encrypted) throw new Error("❌ ENCRYPTED_KEY missing in .env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("❌ Passphrase file missing.");

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

// Helper function to load positions from active_positions.json
function loadActivePositions() {
  return safeReadJson(ACTIVE_POSITIONS_FILE, []);
}

// Helper function to write data to active_positions.json
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// Helper function to read JSON safely
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

// ---------------- max positions guard ----------------
export async function resumeWatcherIfBelowMax() {
  const active = loadActivePositions();
  if (active.length >= MAX_ENTRY) {
    await stopWatcher();
    return { ok: false, reason: "max_entry_reached", count: active.length };
  }
  await startWatcher();
  return { ok: true, count: active.length };
}

// ---------------- Jupiter Helper----------------
function lamportsFromSol(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 1e9);
}

async function getMintDecimals(mintPk) {
  const info = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mintPk, COMMITMENT)
  );
  const decimals = info?.value?.data?.parsed?.info?.decimals;
  if (!Number.isFinite(decimals)) throw new Error("mint decimals unavailable");
  return Number(decimals);
}

function jupLimited(fn) {
  return jupQueue.add(fn);
}

// ---------------- Token Account Creation ----------------
async function getOrCreateTokenAccount(conn, wallet, mintPubkey) {
  const found = await findTokenAccountAndProgram(conn, wallet.publicKey, mintPubkey);
  const programId = found?.programId ?? TOKEN_PROGRAM_ID;

  if (!found) {
    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      wallet,
      mintPubkey,
      wallet.publicKey,
      false,
      "confirmed",
      undefined,
      programId
    );
    return { tokenAccount: ata.address, programId };
  }

  return found;
}

// Find token account
async function findTokenAccountAndProgram(conn, ownerPubkey, mintPubkey) {
  const spl = await conn.getParsedTokenAccountsByOwner(ownerPubkey, { programId: TOKEN_PROGRAM_ID });
  for (const a of spl.value) {
    const info = a.account.data.parsed.info;
    if (info.mint === mintPubkey.toBase58()) return { pubkey: a.pubkey, programId: TOKEN_PROGRAM_ID };
  }

  const t22 = await conn.getParsedTokenAccountsByOwner(ownerPubkey, { programId: TOKEN_2022_PROGRAM_ID });
  for (const a of t22.value) {
    const info = a.account.data.parsed.info;
    if (info.mint === mintPubkey.toBase58()) return { pubkey: a.pubkey, programId: TOKEN_2022_PROGRAM_ID };
  }

  return null; // Return null if no account found
}


// -------------------- Buy Logic --------------------
// -------------------- Buy Logic --------------------
async function buyTokens(mintAddressStr) {
  const wallet = getWallet(); // Retrieve wallet from environment (decrypt private key)
  const mintAddress = new PublicKey(mintAddressStr); // Meme coin mint address (output token)

  // Create or fetch the associated token account for the meme coin (output token)
  const { tokenAccount } = await getOrCreateTokenAccount(conn, wallet, mintAddress);

  // Amount of SOL to spend (this is the value from .env or any defined input)
  const inputSOL = Number(process.env.BUY_INPUT_SOL || 50); // How much SOL you want to spend

  // Fetch the token price in SOL (from getPumpFunPriceOnce for meme token)
  const priceRes = await getPumpFunPriceOnce({ mint: mintAddressStr }).catch((e) => ({
    priceSOL: null,
    source: "pumpfun_price_error",
    error: String(e?.message || e || "pumpfun_price_failed"),
  }));

  const tokenPriceSOL = Number(priceRes?.priceSOL); // Token price in SOL

  if (!tokenPriceSOL) {
    throw new Error("❌ Unable to fetch token price from PumpFun");
  }

  // Fetch the current price of SOL in USDC (using an API like CoinGecko)
  const solPriceInUSDC = await getSOLPriceInUSDC();  // Function to fetch SOL price in USDC

  // Convert token price from SOL to USDC
  const tokenPriceUSDC = tokenPriceSOL * solPriceInUSDC;

  if (!tokenPriceUSDC) {
    throw new Error("❌ Failed to convert SOL price to USDC");
  }

  // Calculate how much of the token you can buy based on the price in USDC
  const amountBought = inputSOL * solPriceInUSDC / tokenPriceUSDC;  // Amount in tokens (calculated based on USDC)

  // Store the token account in active_positions.json for future reference
  const activePositions = loadActivePositions();
  activePositions.push({
    mintAddress: mintAddressStr,
    tokenAccount: tokenAccount.toBase58(),  // Save the token account address
    amount: amountBought,  // Amount bought (calculated dynamically)
  });

  // Save the updated list of active positions to active_positions.json
  atomicWrite(ACTIVE_POSITIONS_FILE, activePositions);

  console.log(`Token account for ${mintAddressStr} saved to active_positions.json. Amount bought: ${amountBought}`);
}
// -------------------- SOL PRICE USD--------------------
async function getSOLPriceInUSDC() {
  try {
    // Fetch the SOL price in USD using Pyth price feed or another reliable source
    const price = await fetchSolPriceUSD(); // Example using a custom function to fetch SOL price
    if (price === null) {
      throw new Error("Failed to fetch SOL price.");
    }
    return price;  // Return SOL price in USD
  } catch (error) {
    console.error("Error fetching SOL price:", error);
    throw new Error("Failed to fetch SOL price.");
  }
}
// ---------------- Telegram Notification ----------------
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (error) {
    console.error("Error sending Telegram message:", error);
  }
}

async function fetchJupJson(url, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), JUP_TIMEOUT_MS);

  try {
    const headers = { "Content-Type": "application/json" };
    if (JUP_API_KEY) headers["x-api-key"] = JUP_API_KEY;

    const resp = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await resp.text();
    let json;

    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!resp.ok) {
      const msg = json?.error || json?.message || text || `http_${resp.status}`;
      throw new Error(`JUP_HTTP_${resp.status}: ${msg}`);
    }

    return json;
  } finally {
    clearTimeout(t);
  }
}

function resolveMintStrict(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("mint missing");
  return new PublicKey(raw).toBase58();
}

function solMint() {
  // Returning the SOL (Solana) mint address, SOL is the native currency and doesn't have a mint address like other tokens
  return new PublicKey("So11111111111111111111111111111111111111112");  // SOL mint address placeholder on Solana
}

// ---------------- Buy Logic ----------------
export async function executePumpfunBuyFromBonding({ candidate, slippageBps = DEFAULT_SLIPPAGE_BPS } = {}) {
  if (!candidate?.mint) throw new Error("candidate.mint missing");

  const gate = await resumeWatcherIfBelowMax();
  if (!gate.ok) {
    return { signature: null, ok: false, reason: gate.reason, activeCount: gate.count };
  }

  const wallet = getWallet();
  const user = wallet.publicKey;

  const inputSOL = Number(process.env.BUY_INPUT_SOL || 50); // How much SOL you want to spend

  // Resolve canonical mint (strip "pump" if present)
  let outMintStr;
  try {
    outMintStr = resolveMintStrict(candidate.mint);
  } catch (e) {
    return { signature: null, ok: false, reason: `bad_mint:${String(e?.message || e)}` };
  }

  const inMint = new PublicKey("So11111111111111111111111111111111111111112"); // SOL mint address
  const outMint = outMintStr;  // This is the mint address for the meme token (which is dynamically passed)

  // Ensure token account creation for the input token (e.g., SOL)
  const { tokenAccount: sourceTokenAccount } = await getOrCreateTokenAccount(conn, wallet, new PublicKey(inMint));

  // 1.5) Await Pump.fun price for entry price logging (preferred)
  const priceRes = await getPumpFunPriceOnce(candidate).catch((e) => ({
    priceSOL: null,
    source: "pumpfun_price_error",
    error: String(e?.message || e || "pumpfun_price_failed"),
  }));

  const pumpPriceSOL = Number(priceRes?.priceSOL);
  let buyPriceSOL = Number.isFinite(pumpPriceSOL) && pumpPriceSOL > 0 ? pumpPriceSOL : null;

  // Track where entry price came from
  let buyPriceSource = buyPriceSOL ? (priceRes?.source || "pumpfun_price") : "jupiter_quote";

  // 2) Quote (rate-limited)
  const quote = await jupLimited(async () => {
    const url =
      `${JUP_QUOTE_BASE}/swap/v1/quote` +
      `?inputMint=${encodeURIComponent(inMint)}` +
      `&outputMint=${encodeURIComponent(outMint)}` +
      `&amount=${encodeURIComponent(String(lamportsIn))}` +
      `&slippageBps=${encodeURIComponent(String(slippageBps))}` +
      `&onlyDirectRoutes=false`;

    return fetchJupJson(url);
  }).catch((e) => {
    return { _err: String(e?.message || e || "quote_failed") };
  });

  if (!quote || quote._err) {
    return { signature: null, ok: false, reason: `quote_failed:${quote?._err || "unknown"}` };
  }

  const outAmountRaw = Number(quote?.outAmount || 0);
  if (!Number.isFinite(outAmountRaw) || outAmountRaw <= 0) {
    return { signature: null, ok: false, reason: "quote_out_amount_invalid" };
  }

  // Fallback to quote implied price ONLY if pump.fun price was unavailable
  if (buyPriceSOL == null) {
    try {
      const decimals = await getMintDecimals(new PublicKey(outMint));
      const outUi = outAmountRaw / Math.pow(10, decimals);
      if (Number.isFinite(outUi) && outUi > 0) {
        buyPriceSOL = Number(inputSol) / outUi;
        buyPriceSource = "jupiter_quote";
      }
    } catch (e) {
      console.error("Error getting mint decimals:", e);
    }
  }

  // 3) DRY RUN path, no swap
  if (DRY_RUN) {
    const count = addActivePosition({
      buyLabel: `Buy ${loadActivePositions().length + 1}`,
      mint: outMintStr,
      bondingCurve: candidate.bondingCurve || null,
      buyPriceSOL: buyPriceSOL ?? 0,
      inputSol: Number(inputSol),
      signature: "DRY_RUN",
      walletAddress: user.toBase58(),
      openedAt: new Date().toISOString(),
      dryRun: true,
      priceSource: buyPriceSource,
      pumpPriceSOL: Number.isFinite(pumpPriceSOL) ? pumpPriceSOL : null,
    });

    if (count >= MAX_ENTRY) await stopWatcher();

    return {
      signature: "DRY_RUN",
      ok: true,
      dryRun: true,
      buyPriceSOL: buyPriceSOL ?? null,
      inputSol: Number(inputSol),
      rpcUsed: activeRpcUrl,
      quoteOutAmount: String(quote.outAmount),
      routePlanLen: Array.isArray(quote.routePlan) ? quote.routePlan.length : 0,
    };
  }

  // 4) Build swap tx (rate-limited)
  const swapBody = {
    quoteResponse: quote,
    userPublicKey: user.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: process.env.JUP_PRIORITY_FEE_LAMPORTS
      ? Number(process.env.JUP_PRIORITY_FEE_LAMPORTS)
      : "auto",
  };

  const swapResp = await jupLimited(async () => {
    const url = `${JUP_QUOTE_BASE}/swap/v1/swap`;
    return fetchJupJson(url, swapBody);
  }).catch((e) => {
    return { _err: String(e?.message || e || "swap_build_failed") };
  });

  if (!swapResp || swapResp._err) {
    return { signature: null, ok: false, reason: `swap_build_failed:${swapResp?._err || "unknown"}` };
  }

  const swapTxB64 = swapResp?.swapTransaction;
  if (!swapTxB64) {
    return { signature: null, ok: false, reason: "swapTransaction_missing" };
  }

  // 5) Sign and send the swap transaction
  let sig = null;
  try {
    const txBuf = Buffer.from(swapTxB64, "base64");
    const vtx = VersionedTransaction.deserialize(txBuf);
    vtx.sign([wallet]);

    sig = await rpcLimited("sendRawTransaction(jupiter)", (c) =>
      c.sendRawTransaction(vtx.serialize(), { skipPreflight: false })
    );

    await rpcLimited("confirmTransaction(jupiter)", (c) =>
      c.confirmTransaction(sig, COMMITMENT)
    );
  } catch (e) {
    await sendTelegram(`BUY ERROR: ${String(e?.message || e)}`);
    return { signature: null, ok: false, reason: `send_failed:${String(e?.message || e)}`, rpcUsed: activeRpcUrl };
  }

  // 6) Record position with token account and amount
  const amountBought = inputUSDC / tokenPriceUSDC;

  const count = addActivePosition({
    buyLabel: `Buy ${loadActivePositions().length + 1}`,
    mint: outMintStr,
    bondingCurve: candidate.bondingCurve || null,
    buyPriceSOL: buyPriceSOL ?? 0,
    inputSol: Number(inputSol),
    signature: sig,
    walletAddress: user.toBase58(),
    openedAt: new Date().toISOString(),
    dryRun: false,
    priceSource: buyPriceSource,
    pumpPriceSOL: Number.isFinite(pumpPriceSOL) ? pumpPriceSOL : null,
    quoteOutAmount: String(quote.outAmount),
    tokenAccount: tokenAccount.toBase58(), 
    amountBought: amountBought, 
  });

  if (count >= MAX_ENTRY) {
    await stopWatcher();
  }

  await sendTelegram(`BUY SUCCESSFUL\nmint: ${outMintStr}\namount: ${inputUSDC} USDC\nsignature: ${sig}`);

  return {
    signature: sig,
    ok: true,
    buyPriceSOL: buyPriceSOL ?? null,
    inputSol: Number(inputSol),
    rpcUsed: activeRpcUrl,
    quoteOutAmount: String(quote.outAmount),
    routePlanLen: Array.isArray(quote.routePlan) ? quote.routePlan.length : 0,
  };
}