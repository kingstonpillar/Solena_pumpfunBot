
import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import crypto from "crypto";
import fs from "fs";
import bs58 from "bs58";
import axios from "axios"; // For telegram notification via axios
import dotenv from "dotenv";
import PQueue from "p-queue";

dotenv.config();

// Setup Solana connection using the RPC URL from the .env file
const connection = new Connection(process.env.QUICKNODE_RPC_URL, "confirmed");

// ---------------- CONFIG ----------------
const JUP_QUOTE_BASE = process.env.JUP_QUOTE_BASE || "https://api.jup.ag";
const JUP_API_KEY = process.env.JUP_API_KEY || "";
const JUP_TIMEOUT_MS = Number(process.env.JUP_TIMEOUT_MS || 12_000);

const JUP_QUOTE_INTERVAL_CAP = Number(process.env.JUP_QUOTE_INTERVAL_CAP || 8);
const JUP_QUOTE_INTERVAL_MS = Number(process.env.JUP_QUOTE_INTERVAL_MS || 1000);

const jupQueue = new PQueue({
  intervalCap: JUP_QUOTE_INTERVAL_CAP,
  interval: JUP_QUOTE_INTERVAL_MS,
  carryoverConcurrencyCount: true,
});

// ---------------- Rate Limit Logic ----------------
async function waitForJupiterRateLimit() {
  // Rate limit for Jupiter quote API (to prevent hitting rate limits)
  if (jupQueue.size >= jupQueue.intervalCap) {
    console.log("Jupiter rate limit reached, waiting...");
    await new Promise(resolve => setTimeout(resolve, JUP_QUOTE_INTERVAL_MS)); // Wait before retrying
  }
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

// ---------------- Token Helper ----------------
async function findTokenAccountAndProgram(connection, ownerPubkey, mintPubkey) {
  const spl = await connection.getParsedTokenAccountsByOwner(ownerPubkey, { programId: TOKEN_PROGRAM_ID });

  for (const a of spl.value) {
    const info = a.account.data.parsed.info;
    if (info.mint === mintPubkey.toBase58()) return { pubkey: a.pubkey, programId: TOKEN_PROGRAM_ID };
  }

  const t22 = await connection.getParsedTokenAccountsByOwner(ownerPubkey, { programId: TOKEN_2022_PROGRAM_ID });

  for (const a of t22.value) {
    const info = a.account.data.parsed.info;
    if (info.mint === mintPubkey.toBase58()) return { pubkey: a.pubkey, programId: TOKEN_2022_PROGRAM_ID };
  }

  return null;
}

// ---------------- Helper Function to Get Token Account ----------------
async function getOrCreateTokenAccount(connection, wallet, mintPubkey) {
  const found = await findTokenAccountAndProgram(connection, wallet.publicKey, mintPubkey);

  const programId = found?.programId ?? TOKEN_PROGRAM_ID;

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
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

// ---------------- Telegram Notification ----------------
async function sendTelegram(message) {
  const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  try {
    await axios.post(telegramApiUrl, {
      chat_id: chatId,
      text: message,
    });
  } catch (error) {
    console.error("Error sending Telegram message:", error);
  }
}

// ---------------- Jupiter Fetch JSON Helper ----------------
async function fetchJupJson(url, body) {
  const controller = new AbortController();  // No need to import, it's a native feature in modern environments
  const t = setTimeout(() => controller.abort(), JUP_TIMEOUT_MS); // Abort if it takes too long

  try {
    const headers = { "Content-Type": "application/json" };
    if (JUP_API_KEY) headers["x-api-key"] = JUP_API_KEY;

    const resp = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,  // Attach the signal to the fetch request
    });

    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);  // Attempt to parse the response as JSON
    } catch {
      json = { raw: text };  // If parsing fails, return the raw response
    }

    if (!resp.ok) {
      // Handle non-2xx responses
      const msg = json?.error || json?.message || text || `http_${resp.status}`;
      throw new Error(`JUP_HTTP_${resp.status}: ${msg}`);
    }

    return json;  // Return the parsed JSON response
  } finally {
    clearTimeout(t);  // Clean up the timeout
  }
}

// ---------------- Jupiter Sell Logic ----------------
async function sellAllTokens(mintAddressStr) {
  try {
    const wallet = getWallet(); 
    const mintAddress = new PublicKey(mintAddressStr);
    const { tokenAccount, programId } = await getOrCreateTokenAccount(connection, wallet, mintAddress);

    // Fetch account data
    const acct = await getAccount(connection, tokenAccount, "confirmed", programId);
    const amountToSell = Number(acct.amount);

    if (amountToSell <= 0) {
      console.log("❌ No tokens to sell");
      await sendTelegram(`SELL FAILED\nmint: ${mintAddressStr}\nNo tokens to sell`);
      return;
    }

    const receiveToken = process.env.RECEIVE_TOKEN;  // Define the token you want to receive
    const amount = amountToSell.toString();  // Amount of tokens to sell

    // Rate limiting for Jupiter API requests
    await waitForJupiterRateLimit();

    const jupQuoteUrl = `${JUP_QUOTE_BASE}/quote?inputMint=${mintAddressStr}&outputMint=${receiveToken}&amount=${amount}&slippage=0.01`;

    // Fetch quote from Jupiter
    const quoteResponse = await fetchJupJson(jupQuoteUrl);
    const quoteData = quoteResponse;

    if (quoteData.error) {
      console.error(`Error fetching Jupiter quote: ${quoteData.error}`);
      await sendTelegram(`SELL FAILED\nmint: ${mintAddressStr}\nError: ${quoteData.error}`);
      return;
    }

    const swapTransaction = quoteData.transaction;  // Assuming transaction is returned by Jupiter

    // Send the transaction
    const signature = await connection.sendTransaction(swapTransaction, [wallet]);
    console.log('Transaction Sent:', signature);

    await connection.confirmTransaction(signature, 'confirmed');
    console.log('Transaction confirmed!');
    await sendTelegram(`SELL SUCCESSFUL\nmint: ${mintAddressStr}\namount: ${amountToSell}\nsig: ${signature}`);
  } catch (error) {
    console.error("Error during token sale:", error);
    await sendTelegram(`SELL ERROR\nmint: ${mintAddressStr}\nerror: ${error.message}`);
  }
}

// Export the function
export async function executeAutoSellPumpfun(mintAddressStr) {
  await sellAllTokens(mintAddressStr);
}

// Main Execution
const mintAddressArg = process.argv[2];  

if (!mintAddressArg) {
  console.error("❌ Mint address is required!");
  process.exit(1);
}

sellAllTokens(mintAddressArg);