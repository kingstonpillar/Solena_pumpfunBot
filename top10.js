import PQueue from 'p-queue'; // Import PQueue for concurrency control

// Create a delay function to control the interval between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------- PQueue for Rate Limiting ----------------
const queue = new PQueue({ concurrency: 5 }); // Set max concurrency for requests (e.g., 5 concurrent requests)

// ---------------- Top 10 Logic ----------------
// Function to fetch top 10 holders using Helius with rate limiting via PQueue
export async function getTop10FromHelius(mintAddress) {
  const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=ffce4942-e7c6-45cc-ab51-1e0ce95bb175";

  // Queue the request to Helius and control the concurrency
  return await queue.add(async () => {
    const response = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [mintAddress],
      }),
    });

    const data = await response.json();

    if (data?.error?.message?.includes('Too many requests')) {
      throw new Error('Max retries reached');
    }

    return data?.result || null;
  });
}

// ---------------- Helper Functions for Delay and Rate Limiting ----------------
export async function fetchTop10WithInterval(mintAddress, intervalMs = 1000) {
  // Add a delay before fetching
  await delay(intervalMs);

  // Fetch Top 10 Data from Helius
  const top10Data = await getTop10FromHelius(mintAddress);
  
  return top10Data;
}