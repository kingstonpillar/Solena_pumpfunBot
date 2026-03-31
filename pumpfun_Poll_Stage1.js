import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv'; // Load environment variables from .env
import fs from 'fs';
import fetch from 'node-fetch'; // Using fetch to send messages to Telegram
import bs58 from 'bs58'; // Base58 encoding for Solana public keys

dotenv.config();

// Solana configuration
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const bondingCandidatesFile = 'bonding_candidates.json';

// RPC URL(s) from .env
const rpcUrls = [process.env.RPC_URL_1, process.env.RPC_URL_2];
let currentRpcIndex = 0; // Start with the first RPC URL

// Telegram bot configuration from .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Curve threshold configuration
const CURVE_WATCH_THRESHOLD = parseFloat(process.env.CURVE_WATCH_THRESHOLD) || 20;
const MAX_CURVE_THRESHOLD = parseFloat(process.env.MAX_CURVE_THRESHOLD) || 50;

let memoryWatch = {};

// RPC Failover Handling
function switchRpcUrl() {
  currentRpcIndex = (currentRpcIndex + 1) % rpcUrls.length;
  console.log(`Switching to RPC URL: ${rpcUrls[currentRpcIndex]}`);
}

// Get Solana connection with failover and transaction version support
async function getConnection() {
  try {
    const connection = new Connection(rpcUrls[currentRpcIndex], {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0, // Specify max supported transaction version
    });

    // Ensure connection works
    await connection.getSlot('confirmed');
    return connection;
  } catch (error) {
    console.error(`Error connecting to RPC URL: ${rpcUrls[currentRpcIndex]}. Switching to another RPC.`);
    switchRpcUrl();
    return getConnection();
  }
}

// Function to detect mint at bonding curve level
async function detectMintAtCurve() {
  setInterval(async () => {
    const connection = await getConnection(); // Get connection with failover

    try {
      const latestBlock = await connection.getSlot('confirmed');
      const blockData = await connection.getBlock(latestBlock);
      const transactions = blockData.transactions;

      for (let tx of transactions) {
        const { transaction } = tx;

        for (let instruction of transaction.message.instructions) {
          if (instruction.programId.equals(PUMP_PROGRAM_ID)) {
            const mintAddress = instruction.data.slice(0, 32);
            const curveValue = parseFloat(instruction.data.slice(32, 36).toString());
            const mintAddressStr = bs58.encode(mintAddress);
            const fullMintAddress = mintAddressStr + "pump";

            if (curveValue >= CURVE_WATCH_THRESHOLD) {
              if (!memoryWatch[fullMintAddress]) {
                memoryWatch[fullMintAddress] = {
                  mint: fullMintAddress,
                  seenAt: new Date().toISOString(),
                  curveValue: curveValue,
                };
                console.log(`Added mint to memory watch: ${fullMintAddress} with curve value: ${curveValue}`);
                console.log(`Number of mints in memory: ${Object.keys(memoryWatch).length}`);
                await sendTelegram(`New mint detected at bonding curve: ${fullMintAddress} with curve value: ${curveValue}`);
              } else {
                memoryWatch[fullMintAddress].curveValue = Math.max(memoryWatch[fullMintAddress].curveValue, curveValue);
                memoryWatch[fullMintAddress].seenAt = new Date().toISOString();
                console.log(`Updated mint curve in memory watch: ${fullMintAddress} with curve value: ${curveValue}`);
                console.log(`Number of mints in memory: ${Object.keys(memoryWatch).length}`);
              }
            }
          }
        }
      }

      for (const mintAddressStr in memoryWatch) {
        const mintData = memoryWatch[mintAddressStr];
        const curveValue = mintData.curveValue;

        if (curveValue >= MAX_CURVE_THRESHOLD) {
          let bondingCandidates = [];
          if (fs.existsSync(bondingCandidatesFile)) {
            bondingCandidates = JSON.parse(fs.readFileSync(bondingCandidatesFile, 'utf-8'));
          }

          const mintExists = bondingCandidates.some(candidate => candidate.mint === mintAddressStr);
          if (!mintExists) {
            bondingCandidates.push({
              mint: mintAddressStr,
              seenAt: mintData.seenAt,
              curveValue: mintData.curveValue,
            });
            fs.writeFileSync(bondingCandidatesFile, JSON.stringify({ mints: bondingCandidates }, null, 2));
            await sendTelegram(`Mint exceeded max threshold and added to JSON: ${mintAddressStr}`);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching block data:', error);
    }
  }, 10000);
}

// Send Telegram alert
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: String(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }
    );

    return resp.ok;
  } catch (e) {
    console.error('Error sending Telegram message:', e);
    return false;
  }
}

// Start detection
detectMintAtCurve();