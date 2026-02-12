import PQueue from 'p-queue'; // Import PQueue for concurrency control

// Create a delay function to control the interval between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------- PQueue for Rate Limiting ----------------
const queue = new PQueue({ concurrency: 5 }); // Set max concurrency for requests (e.g., 5 concurrent requests)

// ---------------- Top 10 Logic ----------------
// Function to fetch top 10 holders using Helius with rate limiting via PQueue
async function getTop10FromHelius(mintAddress) {
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
async function fetchTop10WithInterval(mintAddress, intervalMs = 1000) {
  // Add a delay before fetching
  await delay(intervalMs);

  // Fetch Top 10 Data from Helius
  const top10Data = await getTop10FromHelius(mintAddress);
  
  return top10Data;
}

async function getTop10Pct(mintPub) {
  const supplyResp = await conn.getTokenSupply(mintPub);
  const supply = BigInt(supplyResp?.value?.amount || "0");

  if (supply <= 0n) return { ok: false, pct: null, reason: "supply_zero" };

  // Fetch top 10 holders using Helius with controlled rate limiting
  let top10Data = await fetchTop10WithInterval(mintPub.toBase58(), 1000); // 1000ms interval (1 second)

  if (!top10Data || top10Data.length === 0) {
    return { ok: false, pct: null, reason: "no_top10_found" };
  }

  let sumTop10 = 0n;
  top10Data.forEach(holder => {
    const amount = BigInt(holder?.amount || "0");
    sumTop10 += amount;
  });

  const pct = Number((sumTop10 * 10000n) / supply) / 100;
  return { ok: true, pct, reason: "top10_success" };
}

export async function checkTokenSecurity(mintOrRecord) {
  const reasons = [];
  let score = 0;

  // Token validation logic...

  let t10 = null;
  try {
    t10 = await getTop10Pct(mintPub);
  } catch {
    t10 = null;
  }

  // Handle top 10 result logic...
  
  return { safe, score, reasons, details };
}