import fetch from 'node-fetch';

// Replace with your Helius API key
const HELIUS_API_KEY = "ffce4942-e7c6-45cc-ab51-1e0ce95bb175"; // Your Helius API key

// Function to fetch top 10 token holders from Helius
export async function getTop10FromHelius(mintAddress) {
  const url = "https://mainnet.helius-rpc.com/?api-key=" + HELIUS_API_KEY;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [mintAddress], // Dynamically passed mint address
      }),
    });

    const data = await response.json();

    // Check for errors in the response
    if (data?.error) {
      console.error("Error fetching top 10 accounts:", data.error.message);
      return null;
    }

    // Check if result is present and an array
    const top10Data = data?.result;
    if (!Array.isArray(top10Data) || top10Data.length === 0) {
      console.error("No top 10 data found or data is not in the expected format.");
      return null;
    }

    // Check compatibility of each holder data (must have amount field)
    for (const holder of top10Data) {
      if (!holder?.amount || isNaN(holder.amount)) {
        console.error("Invalid holder data: Missing or invalid 'amount'.", holder);
        return null;
      }
    }

    // Return the top 10 accounts
    return top10Data;
  } catch (error) {
    console.error("Error fetching top 10 accounts:", error.message);
    return null;
  }
}