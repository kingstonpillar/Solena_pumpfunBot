import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";
import pkg from "@raydium-io/raydium-sdk"; // Default import
const { swap } = pkg;  // Now we use the `swap` method from the default export
import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import crypto from "crypto";
import fs from "fs";
import bs58 from "bs58";
import axios from "axios";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Get the RPC URL from the .env file
const rpcUrl = process.env.QUICKNODE_RPC_URL;
if (!rpcUrl) {
  throw new Error("❌ QUICKNODE_RPC_URL missing in .env");
}

// Setup Solana connection using the RPC URL from the .env file
const connection = new Connection(rpcUrl, "confirmed");

// ---------------- Wallet decrypt ----------------
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

// ---------------- Dynamic Token Selling ----------------
async function sellAllTokens(mintAddressStr) {
  try {
    const wallet = getWallet();  // Get wallet from decrypted private key
    const mintAddress = new PublicKey(mintAddressStr);  // Parse mint address from input argument

    // Retrieve token account for the mint (You should already have a token account for the mint)
    const tokenAccountAddress = await getTokenAccount(wallet, mintAddress);

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

    // Get the liquidity pool for the token and SOL (Raydium or Serum pool address)
    const poolAddress = new PublicKey("<Raydium Pool Address for the token and SOL>");

    // Create the transaction to swap the token for SOL
    const transaction = new Transaction().add(
      swap({
        fromTokenAccount: tokenAccountAddress,  // Token account to sell from
        toTokenAccount: solAccountAddress,      // Account to receive SOL
        amount: amountToSell,                   // Amount to swap (in smallest unit)
        poolAddress: poolAddress,               // Liquidity pool for token to SOL swap
        wallet: wallet.publicKey                // The wallet signing the transaction
      })
    );

    // Send and confirm the transaction
    const signature = await connection.sendTransaction(transaction, [wallet], { skipPreflight: false });
    console.log("Transaction signature:", signature);

    // Confirm the transaction
    await connection.confirmTransaction(signature, "confirmed");
    console.log("Transaction confirmed!");

    // Send Telegram notification about successful sale
    await sendTelegram(`SELL SUCCESSFUL\nmint: ${mintAddressStr}\namount: ${amountToSell}\nsig: ${signature}`);
  } catch (error) {
    console.error("Error during token sale:", error);
    await sendTelegram(`SELL ERROR\nmint: ${mintAddressStr}\nerror: ${error.message}`);
  }
}

// ---------------- Helper Function to Get Token Account ----------------

async function getTokenAccount(wallet, mintAddress) {
  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: mintAddress });
  if (tokenAccounts.value.length === 0) {
    throw new Error("❌ No token account found for this mint address.");
  }
  return tokenAccounts.value[0].pubkey;  // Return the first token account
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