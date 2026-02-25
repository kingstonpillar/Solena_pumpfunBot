import * as splToken from '@solana/spl-token';  // Import the whole package
const { Token, TOKEN_PROGRAM_ID } = splToken;  // Destructure Token and TOKEN_PROGRAM_ID

import pkg from '@orca-so/sdk'; 
const { Orca, Network } = pkg;  // Destructure Orca and Network from the package

import { Connection, PublicKey, Keypair } from '@solana/web3.js';  
import crypto from 'crypto';
import fs from 'fs';
import bs58 from 'bs58';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Setup Solana connection using the RPC URL from the .env file
const connection = new Connection(process.env.QUICKNODE_RPC_URL, "confirmed");

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

// ---------------- Helper Function to Get Token Account ----------------
async function getOrCreateTokenAccount(wallet, mintAddress) {
  const token = new Token(connection, mintAddress, TOKEN_PROGRAM_ID, wallet);
  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: mintAddress });

  if (tokenAccounts.value.length === 0) {
    console.log("No token account found. Creating new token account...");
    const newTokenAccount = await token.createAssociatedTokenAccount(wallet.publicKey);
    console.log("Token account created:", newTokenAccount.toString());
    return newTokenAccount;
  } else {
    const tokenAccountPubkey = tokenAccounts.value[0].pubkey;
    console.log("Found token account:", tokenAccountPubkey.toString());
    return tokenAccountPubkey;
  }
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

// ---------------- Dynamic Token Selling ----------------
async function sellAllTokens(mintAddressStr) {
  try {
    const wallet = getWallet(); 
    const mintAddress = new PublicKey(mintAddressStr);
    const tokenAccountAddress = await getOrCreateTokenAccount(wallet, mintAddress);  

    const token = new Token(connection, mintAddress, TOKEN_PROGRAM_ID, wallet);
    const balance = await token.getAccountInfo(tokenAccountAddress);
    const amountToSell = balance.amount.toNumber();  

    if (amountToSell <= 0) {
      console.log("❌ No tokens to sell");
      await sendTelegram(`SELL FAILED\nmint: ${mintAddressStr}\nNo tokens to sell`);
      return;
    }

    const solAccountAddress = wallet.publicKey;
    const orca = Orca.getInstance(Network.MAINNET);
    const receiveToken = process.env.RECEIVE_TOKEN;  
    const usdcToken = orca.getToken(receiveToken);  // Use dynamic RECEIVE_TOKEN
    const solToken = orca.getToken('SOL');  

    const pool = await orca.getPool(usdcToken, solToken);  

    const userTokenAccount = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: mintAddress });
    const userTokenAccountPubkey = userTokenAccount.value[0].pubkey;

    const swapTransaction = await pool.swap({
      userTokenAccount: userTokenAccountPubkey,
      amount: amountToSell,
      slippage: 0.01, 
    });

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