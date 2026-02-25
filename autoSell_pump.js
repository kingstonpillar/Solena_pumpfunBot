import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as splToken from '@solana/spl-token';
const { Token, TOKEN_PROGRAM_ID } = splToken;
import pkg from "@orca-so/sdk";  // Import Orca SDK
const { Orca, Network } = pkg;
import crypto from "crypto";
import fs from "fs";
import bs58 from "bs58";
import axios from "axios";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Get the RPC URL and receive token from .env
const rpcUrl = process.env.QUICKNODE_RPC_URL;
const receiveToken = process.env.RECEIVE_TOKEN;  // This is either USDC or SOL, based on .env configuration

if (!rpcUrl) {
  throw new Error("❌ QUICKNODE_RPC_URL missing in .env");
}
if (!receiveToken) {
  throw new Error("❌ RECEIVE_TOKEN missing in .env");
}

// Setup Solana connection using the RPC URL from the .env file
const connection = new Connection(rpcUrl, "confirmed");

// ---------------- Wallet Decrypt ----------------
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

// ---------------- Helper Function to Get Token Account ----------------
async function getOrCreateTokenAccount(wallet, mintAddress) {
  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: mintAddress });

  if (tokenAccounts.value.length === 0) {
    // Token account not found, create one
    console.log("No token account found. Creating new token account...");

    const token = new Token(connection, mintAddress, TOKEN_PROGRAM_ID, wallet);
    
    // Create a new token account
    const newTokenAccount = await token.createAccount(wallet.publicKey);
    console.log("Token account created:", newTokenAccount.toString());
    return newTokenAccount;
  } else {
    // Token account found, return it
    const tokenAccountPubkey = tokenAccounts.value[0].pubkey;
    console.log("Found token account:", tokenAccountPubkey.toString());
    return tokenAccountPubkey;
  }
}

// ---------------- Dynamic Token Selling ----------------
async function sellAllTokens(mintAddressStr) {
  try {
    const wallet = getWallet();  // Get wallet from decrypted private key
    const mintAddress = new PublicKey(mintAddressStr);  // Parse mint address from input argument

    // Retrieve or create token account for the mint
    const tokenAccountAddress = await getOrCreateTokenAccount(wallet, mintAddress);

    // Create the token instance for the provided mint address
    const token = new Token(connection, mintAddress, TOKEN_PROGRAM_ID, wallet);

    // Fetch the token balance dynamically
    const balance = await token.getAccountInfo(tokenAccountAddress);
    const amountToSell = balance.amount.toNumber();  // Get the balance in the smallest unit (e.g., 1 token = 1000000 units for 6 decimals)

    if (amountToSell <= 0) {
      console.log("❌ No tokens to sell");
      await sendTelegram(`SELL FAILED\nmint: ${mintAddressStr}\nNo tokens to sell`);
      return;
    }

    // Define the SOL receiving account
    const solAccountAddress = wallet.publicKey;

    // Setup Orca for swapping
    const orca = Orca.getInstance(Network.MAINNET);

    // Dynamically select the receiving token based on the .env variable
    const receiveTokenObject = orca.getToken(receiveToken);  // Dynamically use either USDC or SOL
    const pool = await orca.getPool(receiveTokenObject, solAccountAddress);

    // Get the user’s token account
    const userTokenAccount = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: mintAddress });
    const userTokenAccountPubkey = userTokenAccount.value[0].pubkey;

    // Perform the swap (swap USDC or SOL based on receiveToken)
    const swapTransaction = await pool.swap({
      userTokenAccount: userTokenAccountPubkey,  // The token account to swap from
      amount: amountToSell,                      // Amount of tokens to swap (in smallest unit)
      slippage: 0.01                             // Slippage tolerance (1%)
    });

    // Send the transaction
    const signature = await connection.sendTransaction(swapTransaction, [wallet]);
    console.log('Transaction Sent:', signature);

    // Wait for confirmation
    await connection.confirmTransaction(signature, 'confirmed');
    console.log('Transaction confirmed!');

    // Send Telegram notification about successful sale
    await sendTelegram(`SELL SUCCESSFUL\nmint: ${mintAddressStr}\namount: ${amountToSell}\nsig: ${signature}`);
  } catch (error) {
    console.error("Error during token sale:", error);
    await sendTelegram(`SELL ERROR\nmint: ${mintAddressStr}\nerror: ${error.message}`);
  }
}

// ---------------- Exported Public API ----------------

// This function can be called by other modules
export async function executeAutoSellPumpfun(mintAddressStr) {
  await sellAllTokens(mintAddressStr);
}

// ---------------- Main Execution ----------------

// Get the mint address from arguments
const mintAddressArg = process.argv[2];  // Fetch the mint address from command line argument

if (!mintAddressArg) {
  console.error("❌ Mint address is required!");
  process.exit(1);
}

// Call the sellAllTokens function with the provided mint address
sellAllTokens(mintAddressArg);