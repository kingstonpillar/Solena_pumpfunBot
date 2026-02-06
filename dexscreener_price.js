import fetch from "node-fetch";

export async function getPriceUsdFromDexscreener(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[DexScreener HTTP ${res.status}] ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];

  // Prefer Solana pairs, then highest liquidity
  const solPairs = pairs.filter(
    (p) => (p.chainId || "").toLowerCase() === "solana"
  );

  const sorted = (solPairs.length ? solPairs : pairs).sort((a, b) => {
    const la = Number(a?.liquidity?.usd || 0);
    const lb = Number(b?.liquidity?.usd || 0);
    return lb - la;
  });

  const best = sorted[0];
  const priceUsd = Number(best?.priceUsd);

  if (!Number.isFinite(priceUsd)) {
    throw new Error(`No priceUsd found on DexScreener for mint=${mint}`);
  }

  return { priceUsd, pair: best };
}