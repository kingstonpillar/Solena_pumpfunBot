import dotenv from 'dotenv'; // Load environment variables from .env
import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import fetch from 'node-fetch'; // Using fetch to send messages to Telegram
import bs58 from 'bs58'; // Base58 encoding for Solana public keys

// Load environment variables
dotenv.config();

// Set the program ID of the bonding curve
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');  // Example ID
const bondingCandidatesFile = 'bonding_candidates.json';

// Load RPC URLs from the environment variables
const rpcUrls = [process.env.RPC_URL_1, process.env.RPC_URL_2];
let currentRpcIndex = 0; // Start with the first RPC URL

// Telegram bot configuration from .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Load curve threshold configuration from .env
const CURVE_WATCH_THRESHOLD = parseFloat(process.env.CURVE_WATCH_THRESHOLD) || 20; // 20% curve threshold
const MAX_CURVE_THRESHOLD = parseFloat(process.env.MAX_CURVE_THRESHOLD) || 50; // Max threshold for saving mint to JSON

// In-memory storage for mints above the watch threshold
let memoryWatch = {};

// Function to switch to the next RPC URL in case of failure
function switchRpcUrl() {
  currentRpcIndex = (currentRpcIndex + 1) % rpcUrls.length;
  console.log(`Switching to RPC URL: ${rpcUrls[currentRpcIndex]}`);
}

// Create a function to fetch connection, with failover
async function getConnection() {
  try {
    const connection = new Connection(rpcUrls[currentRpcIndex], 'confirmed');
    // Try a simple request to ensure connection works
    await connection.getSlot('confirmed');
    return connection;
  } catch (error) {
    console.error(`Error connecting to RPC URL: ${rpcUrls[currentRpcIndex]}. Switching to another RPC.`);
    switchRpcUrl(); // Switch to the next RPC URL
    return getConnection(); // Retry with the new RPC URL
  }
}

// Function to detect the mint at bonding curve level
async function detectMintAtCurve() {
  // Polling every 10 seconds for new blocks (adjust as necessary)
  setInterval(async () => {
    const connection = await getConnection(); // Get connection with failover

    try {
      // Get the latest block
      const latestBlock = await connection.getSlot('confirmed');
      const blockData = await connection.getBlock(latestBlock);
      const transactions = blockData.transactions;

      // Loop through each transaction to find mints
      for (let tx of transactions) {
        const { transaction } = tx;
        
        // Check for mint operation (adjust based on the mint program ID)
        for (let instruction of transaction.message.instructions) {
          if (instruction.programId.equals(PUMP_PROGRAM_ID)) {
            // Assuming the mint address and curve data are encoded in the instruction data
            const mintAddress = instruction.data.slice(0, 32); // Extract the first 32 bytes for the mint address
            const curveValue = parseFloat(instruction.data.slice(32, 36).toString()); // Extract curve value

            // Convert mint address to Base58
            const mintAddressStr = bs58.encode(mintAddress); // Base58 encoded mint address

            // Add "pump" suffix if necessary
            const fullMintAddress = mintAddressStr + "pump"; // Appending "pump" to the mint address

            // If the curve value exceeds the watch threshold, store it in memory
            if (curveValue >= CURVE_WATCH_THRESHOLD) {
              // If not in memory, add it with the current timestamp
              if (!memoryWatch[fullMintAddress]) {
                memoryWatch[fullMintAddress] = {
                  mint: fullMintAddress,
                  seenAt: new Date().toISOString(), // Current timestamp
                  curveValue: curveValue,
                };
                console.log(`Added mint to memory watch: ${fullMintAddress} with curve value: ${curveValue}`);
                
                // Log number of mints in memory
                console.log(`Number of mints in memory: ${Object.keys(memoryWatch).length}`);

                // Send Telegram alert
                await sendTelegram(`New mint detected at bonding curve: ${fullMintAddress} with curve value: ${curveValue}`);
              } else {
                // If it's in memory, update the curve value and timestamp
                memoryWatch[fullMintAddress].curveValue = Math.max(memoryWatch[fullMintAddress].curveValue, curveValue);
                memoryWatch[fullMintAddress].seenAt = new Date().toISOString();
                console.log(`Updated mint curve in memory watch: ${fullMintAddress} with curve value: ${curveValue}`);
                
                // Log number of mints in memory
                console.log(`Number of mints in memory: ${Object.keys(memoryWatch).length}`);
              }
            }
          }
        }
      }

      // Repoll memory to check if any mint exceeds the max threshold
      for (const mintAddressStr in memoryWatch) {
        const mintData = memoryWatch[mintAddressStr];
        const curveValue = mintData.curveValue;

        if (curveValue >= MAX_CURVE_THRESHOLD) {
          // If the curve value exceeds the max threshold, write it to JSON
          let bondingCandidates = [];
          if (fs.existsSync(bondingCandidatesFile)) {
            bondingCandidates = JSON.parse(fs.readFileSync(bondingCandidatesFile, 'utf-8'));
          }

          // Add mint object to JSON, ensuring uniqueness
          const mintExists = bondingCandidates.some(candidate => candidate.mint === mintAddressStr);
          if (!mintExists) {
            bondingCandidates.push({
              mint: mintAddressStr,
              seenAt: mintData.seenAt, // Add the seenAt timestamp
              curveValue: mintData.curveValue, // Store the curve value
            });
            fs.writeFileSync(bondingCandidatesFile, JSON.stringify({ mints: bondingCandidates }, null, 2));

            // Send Telegram alert
            await sendTelegram(`Mint exceeded max threshold and added to JSON: ${mintAddressStr}`);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching block data:', error);
    }
  }, 10000); // Poll every 10 seconds
}

// Function to send a Telegram alert
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