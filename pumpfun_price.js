import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

// ---------------- RPC FAILOVER ----------------
const RPC_URL_20 = process.env.RPC_URL_20;
const RPC_URL_30 = process.env.RPC_URL_30;

if (!RPC_URL_20 && !RPC_URL_30) {
  throw new Error("❌ Missing RPC_URL_20 / RPC_URL_30 in .env");
}

const COMMITMENT = "confirmed";

const RPC_LIST = [RPC_URL_20, RPC_URL_30].filter(Boolean);
let activeRpcIndex = 0;

let conn = new Connection(RPC_LIST[activeRpcIndex], COMMITMENT);

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("node is behind")
  );
}

async function withRpcFailover(opName, fn) {
  let lastErr = null;

  for (let i = 0; i < RPC_LIST.length; i++) {
    const idx = (activeRpcIndex + i) % RPC_LIST.length;
    const url = RPC_LIST[idx];

    if (idx !== activeRpcIndex) {
      activeRpcIndex = idx;
      conn = new Connection(url, COMMITMENT);
    }

    try {
      return await fn(conn);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }

  throw new Error(`[RPC_FAILOVER] ${opName} failed: ${String(lastErr?.message || lastErr)}`);
}

// ---------------- PQUEUE ----------------
const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  return q.add(() => withRpcFailover(opName, fn));
}

// ---------------- CONSTANTS ----------------
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const VAULT_CACHE = new Map();

// ---------------- helpers ----------------
async function getUiBal(tokenAccount) {
  const bal = await rpcLimited("getTokenAccountBalance", (c) =>
    c.getTokenAccountBalance(new PublicKey(tokenAccount))
  );

  const ui = Number(bal?.value?.uiAmountString ?? bal?.value?.uiAmount ?? "0");
  return Number.isFinite(ui) ? ui : 0;
}

// ---------------- BONDING CURVE PRICE ----------------
function parseBondingCurveAccount(data) {
  const buf = Buffer.from(data);
  let offset = 8; // discriminator

  const readU64 = () => {
    const v = buf.readBigUInt64LE(offset);
    offset += 8;
    return Number(v);
  };

  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();

  return { virtualTokenReserves, virtualSolReserves };
}

async function getBondingCurvePrice(record) {
  const curve = record?.bondingCurve;
  if (!curve) return { error: "missing_bonding_curve" };

  const acc = await rpcLimited("getAccountInfo(bondingCurve)", (c) =>
    c.getAccountInfo(new PublicKey(curve), COMMITMENT)
  );

  if (!acc?.data) return { error: "bonding_curve_account_missing" };

  const { virtualTokenReserves, virtualSolReserves } =
    parseBondingCurveAccount(acc.data);

  if (virtualTokenReserves <= 0 || virtualSolReserves <= 0) {
    return { error: "invalid_curve_reserves" };
  }

  return {
    priceSOL: virtualSolReserves / virtualTokenReserves,
    source: "bonding_curve",
    reserves: {
      virtualSol: virtualSolReserves,
      virtualToken: virtualTokenReserves,
    },
  };
}

// ---------------- MIGRATION PRICE ----------------
async function discoverVaults(migrationSig, tokenMint) {
  const tx = await rpcLimited("getTransaction(migration)", (c) =>
    c.getTransaction(migrationSig, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 1,
    })
  );

  if (!tx?.meta || !tx?.transaction?.message) return null;

  const keys = tx.transaction.message.accountKeys.map((k) =>
    k.pubkey ? k.pubkey.toBase58() : k.toBase58()
  );

  const post = Array.isArray(tx.meta.postTokenBalances)
    ? tx.meta.postTokenBalances
    : [];

  const wsol = [];
  const tok = [];

  for (const b of post) {
    if (!b?.mint || typeof b.accountIndex !== "number") continue;
    const addr = keys[b.accountIndex];
    if (!addr) continue;

    if (b.mint === WSOL_MINT) wsol.push(addr);
    if (b.mint === tokenMint) tok.push(addr);
  }

  if (!wsol.length || !tok.length) return null;

  let bestW = { addr: null, ui: 0 };
  for (const a of new Set(wsol)) {
    const ui = await getUiBal(a);
    if (ui > bestW.ui) bestW = { addr: a, ui };
  }

  let bestT = { addr: null, ui: 0 };
  for (const a of new Set(tok)) {
    const ui = await getUiBal(a);
    if (ui > bestT.ui) bestT = { addr: a, ui };
  }

  if (!bestW.addr || !bestT.addr) return null;
  return { wsolVault: bestW.addr, tokenVault: bestT.addr };
}

async function getMigratedPrice(record) {
  const mint = record?.mint;
  const sig = record?.migration?.signature;
  if (!sig) return { error: "missing_migration_signature" };

  let vaults = VAULT_CACHE.get(mint);

  if (!vaults) {
    vaults = await discoverVaults(sig, mint);
    if (!vaults) return { error: "vault_discovery_failed" };
    VAULT_CACHE.set(mint, vaults);
  }

  const wsol = await getUiBal(vaults.wsolVault);
  const tok = await getUiBal(vaults.tokenVault);

  if (wsol <= 0 || tok <= 0) {
    return { error: "zero_reserves" };
  }

  return {
    priceSOL: wsol / tok,
    source: "migration_pool",
    reserves: { wsol, token: tok },
    vaults,
  };
}

// ---------------- PUBLIC API ----------------
export async function getPumpFunPriceOnce(record) {
  if (!record?.mint) return { error: "missing_mint" };

  // 1) Bonding curve first
  const curveRes = await getBondingCurvePrice(record);
  if (curveRes?.priceSOL) {
    return {
      priceSOL: Number(curveRes.priceSOL.toPrecision(10)),
      source: "bonding_curve",
      reserves: curveRes.reserves,
    };
  }

  // 2) Migration fallback
  const migRes = await getMigratedPrice(record);
  if (migRes?.priceSOL) {
    return {
      priceSOL: Number(migRes.priceSOL.toPrecision(10)),
      source: "migration_pool",
      reserves: migRes.reserves,
      vaults: migRes.vaults,
    };
  }

  return {
    error: "price_unavailable",
    curveError: curveRes?.error,
    migrationError: migRes?.error,
  };
}