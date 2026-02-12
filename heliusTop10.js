import fetch from 'node-fetch';
import { BI, biAdd, biPct } from './bigintSafe.js';  // Import BigInt safe utilities

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

  // Check for errors in the response
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

  // Check for errors in the response
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

    // Fetch top 10 holders data from Helius
    const top10Data = await getTop10FromHelius(mintAddress);

    // Log the top10Data to inspect its structure
    console.log("Top 10 Data:", top10Data);

    // Ensure top10Data is an array
    if (!Array.isArray(top10Data)) {
      console.error("Expected top10Data to be an array, but it's not:", top10Data);
      return null;
    }

    if (top10Data.length === 0) {
      console.log("No top 10 holders found.");
      return null;
    }

    let sumTop10 = 0n;
    top10Data.forEach(holder => {
      // Log holder data for debugging
      console.log("Holder data:", holder);

      // Check if the amount is an object, if so extract the numeric value from the object
      let amount = 0n;

      if (typeof holder.amount === 'object') {  // If 'amount' is an object, check if it contains a numeric value
        console.log("Amount is an object:", holder.amount);

        // Extract the numeric value safely (fallback to 0n if missing)
        amount = BI(holder.amount?.amount || holder.amount?.uiAmount || 0n);
      } else if (typeof holder.amount === 'string' || typeof holder.amount === 'number') {
        // If 'amount' is a primitive, convert it directly to BigInt
        amount = BI(holder.amount.toString());
      }

      sumTop10 = biAdd(sumTop10, amount); // Use biAdd for safe addition
    });

    // Calculate the percentage of total supply held by the top 10 holders
    const top10Pct = biPct(sumTop10, totalSupply);  // Use biPct for safe percentage calculation
    console.log(`Top 10 holders own: ${top10Pct}% of the total supply.`);

    return top10Pct;

  } catch (err) {
    console.error("Error while calculating top 10 percentage:", err);
    return null;
  }
}