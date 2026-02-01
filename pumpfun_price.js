import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL =
  process.env.RPC_URL_5 ||
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const conn = new Connection(RPC_URL, "confirmed");

const WSOL_MINT = "So11111111111111111111111111111111111111112";

const VAULT_CACHE = new Map();

// ---------------- helpers ----------------
async function getUiBal(tokenAccount) {
  const bal = await conn.getTokenAccountBalance(new PublicKey(tokenAccount));
  const ui = Number(bal?.value?.uiAmountString ?? bal?.value?.uiAmount ?? "0");
  return Number.isFinite(ui) ? ui : 0;
}

// ---------------- BONDING CURVE PRICE ----------------
// Pump.fun bonding curve account layout (known, stable)
function parseBondingCurveAccount(data) {
  // skip discriminator (8 bytes)
  const buf = Buffer.from(data);
  let offset = 8;

  const readU64 = () => {
    const v = buf.readBigUInt64LE(offset);
    offset += 8;
    return Number(v);
  };

  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();

  return {
    virtualTokenReserves,
    virtualSolReserves,
  };
}

async function getBondingCurvePrice(record) {
  const curve = record?.bondingCurve;
  if (!curve) return { error: "missing_bonding_curve" };

  const acc = await conn.getAccountInfo(new PublicKey(curve), "confirmed");
  if (!acc?.data) return { error: "bonding_curve_account_missing" };

  const { virtualTokenReserves, virtualSolReserves } =
    parseBondingCurveAccount(acc.data);

  if (virtualTokenReserves <= 0 || virtualSolReserves <= 0) {
    return { error: "invalid_curve_reserves" };
  }

  const priceSOL = virtualSolReserves / virtualTokenReserves;

  return {
    priceSOL,
    source: "bonding_curve",
    reserves: {
      virtualSol: virtualSolReserves,
      virtualToken: virtualTokenReserves,
    },
  };
}

// ---------------- MIGRATION PRICE (your existing logic) ----------------
async function discoverVaults(migrationSig, tokenMint) {
  const tx = await conn.getTransaction(migrationSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 1,
  });
  if (!tx?.meta || !tx?.transaction?.message) return null;

  const keys = tx.transaction.message.accountKeys.map(k =>
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
/**
 * Returns price immediately when called.
 * Supports bonding curve FIRST, then migration fallback.
 */
export async function getPumpFunPriceOnce(record) {
  if (!record?.mint) return { error: "missing_mint" };

  // 1️⃣ Try bonding curve price (pre-migration)
  const curveRes = await getBondingCurvePrice(record);
  if (curveRes?.priceSOL) {
    return {
      priceSOL: Number(curveRes.priceSOL.toPrecision(10)),
      source: "bonding_curve",
      reserves: curveRes.reserves,
    };
  }

  // 2️⃣ Fallback to migration price
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