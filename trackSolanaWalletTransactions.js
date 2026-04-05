 //trackSolanaWalletTransactions.js
import { Connection, PublicKey } from '@solana/web3.js';

// Solana RPC URL (mainnet)
const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';  // Public Solana RPC endpoint
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// The wallet address to track (replace with your wallet address)
const walletPublicKey = new PublicKey('8q4HU6uHV9ViAkpjbdavnkM2njAPPq6h88P4rBHchb2F');

// Function to get the last 10 confirmed transactions for the wallet
async function getTransactions(walletAddress) {
  try {
    const transactions = await connection.getConfirmedSignaturesForAddress(
      walletAddress, 
      { limit: 10 }  // You can adjust this limit to fetch more or fewer transactions
    );
    return transactions;
  } catch (error) {
    console.error('Error fetching transactions:', error);
  }
}

// Function to fetch detailed transaction information by signature
async function getTransactionDetails(signature) {
  try {
    const transaction = await connection.getConfirmedTransaction(signature);
    return transaction;
  } catch (error) {
    console.error('Error fetching transaction details:', error);
  }
}

// Main function to monitor the wallet and print transaction details
async function trackWalletTransactions() {
  const transactions = await getTransactions(walletPublicKey);

  if (transactions) {
    console.log(`Found ${transactions.length} transactions for wallet ${walletPublicKey.toString()}:`);
    for (const tx of transactions) {
      console.log(`Transaction signature: ${tx.signature}`);
      
      // Get detailed transaction info
      const txDetails = await getTransactionDetails(tx.signature);
      console.log('Transaction Details:', txDetails);
    }
  }
}

// Track the wallet transactions every 1 minute (adjust as needed)
setInterval(() => {
  trackWalletTransactions();
}, 60000);  // 60000 ms = 1 minutes