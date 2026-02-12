import fetch from 'node-fetch';
import { BI, biAdd, biPct } from './bigintSafe.js';  // Use BigInt safe utilities from bigintSafe.js

// Replace with your Helius API key
const HELIUS_API_KEY = "ffce4942-e7c6-45cc-ab51-1e0ce95bb175"; // Your Helius API key

// Function to fetch top 10 token holders from Helius
export async function getTop10FromHelius(mintAddress) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenLargestAccounts',
      params: [mintAddress],
    }),
  });

  const data = await response.json();

  if (data?.error) {
    console.error("Error fetching top 10 accounts:", data.error.message);
    return null;
  }

  return data?.result || null;
}

// Function to fetch the token supply from Helius
export async function getTokenSupplyFromHelius(mintAddress) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenSupply',
      params: [mintAddress],
    }),
  });

  const data = await response.json();

  if (data?.error) {
    console.error("Error fetching token supply:", data.error.message);
    return null;
  }

  return data?.result?.value || null;
}

// Main function to fetch top 10 and calculate percentage of total supply
export async function Top10PCT(mintAddress) {
  try {
    // Fetch total supply of the token using Helius
    const supply = await getTokenSupplyFromHelius(mintAddress);

    if (!supply) {
      console.log("Failed to fetch token supply.");
      return null;
    }

    const totalSupply = BI(supply); // Use BI to safely convert to BigInt
    console.log('Total Supply:', totalSupply.toString()); // Debug log for total supply

    // Fetch top 10 holders data from Helius
    const top10Data = await getTop10FromHelius(mintAddress);

    // Ensure top10Data is an array
    if (!Array.isArray(top10Data)) {
      console.error("Expected top10Data to be an array, but it's not:", top10Data);
      return null;
    }

    let sumTop10 = 0n; // Initialize sum as BigInt
    top10Data.forEach(holder => {
      let amount = 0n;

      if (typeof holder.amount === 'object') {
        // If 'amount' is an object, handle it safely
        amount = BI(holder.amount?.amount || holder.amount?.uiAmount || 0n);
      } else {
        // Handle the case where amount is a primitive
        amount = BI(holder.amount.toString());
      }

      sumTop10 = biAdd(sumTop10, amount); // Safely add the holder's amount to sum
    });

    console.log("Sum of Top 10:", sumTop10.toString()); // Debug log for sum of top 10 holders

    // Calculate the percentage of total supply held by the top 10 holders
    const top10Pct = biPct(sumTop10, totalSupply);
    console.log(`Top 10 holders own: ${top10Pct}% of the total supply.`);

    return top10Pct;

  } catch (err) {
    console.error("Error while calculating top 10 percentage:", err);
    return null;
  }
}