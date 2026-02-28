// solPriceFetcher.js
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

// ---------------- CONFIG ----------------
const RPC_URLS = [
  process.env.RPC_URL_5 || "https://api.mainnet-beta.solana.com",
  process.env.RPC_URL_6 || "https://api.mainnet.rpc2.solana.com"
];

const SOL_PYTH_PRICE_ACCOUNT = new PublicKey(
  "J83w4HKfqxwc1ySTtwE4u2QZpM3X4PzZsZ2F1F8oVQ6F"
); // Official SOL/USD mainnet price feed

const CACHE_MS = 10_000; // cache 10 seconds

// ---------------- STATE ----------------
let cachedPrice = null;
let lastFetch = 0;
let rpcIndex = 0;

// Rate-limit 6 requests/sec
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6, concurrency: 1 });

// ---------------- UTIL ----------------
function decodePythPrice(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const price = view.getBigInt64(208, true); // offset of price
  const expo = view.getInt32(212, true);     // offset of expo
  return Number(price) * 10 ** expo;
}

// ---------------- RPC ROTATION ----------------
function nextConnection() {
  const url = RPC_URLS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  return new Connection(url, "confirmed");
}

// ---------------- FETCH FUNCTION ----------------
export async function fetchSolPriceUSD() {
  const now = Date.now();
  if (cachedPrice && now - lastFetch < CACHE_MS) return cachedPrice;

  return rpcQueue.add(async () => {
    const conn = nextConnection();
    try {
      const accountInfo = await conn.getAccountInfo(SOL_PYTH_PRICE_ACCOUNT);
      if (!accountInfo || !accountInfo.data) {
        console.warn("SOL Pyth account missing data");
        return null;
      }

      const price = decodePythPrice(accountInfo.data);
      if (!Number.isFinite(price) || price <= 0) return null;

      cachedPrice = price;
      lastFetch = now;
      return price;

    } catch (err) {
      console.error("fetchSolPriceUSD error:", err?.message || err);
      return null;
    }
  });
}