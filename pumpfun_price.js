import "dotenv/config";
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

// Pump.fun bonding curve PDA
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
function deriveBondingCurvePda(mint) {
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPk.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// PumpSwap program id (set it explicitly, don’t guess)
const PUMPSWAP_PROGRAM_ID = new PublicKey(
  process.env.PUMPSWAP_PROGRAM_ID || "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

// Optional: Raydium programs if you still want them
const RAYDIUM_AMM_V4 = process.env.RAYDIUM_AMM_V4 ? new PublicKey(process.env.RAYDIUM_AMM_V4) : null;
const RAYDIUM_CPMM = process.env.RAYDIUM_CPMM ? new PublicKey(process.env.RAYDIUM_CPMM) : null;

// ---------------- helpers ----------------
async function getUiBal(tokenAccount) {
  const bal = await rpcLimited("getTokenAccountBalance", (c) =>
    c.getTokenAccountBalance(new PublicKey(tokenAccount))
  );
  const ui = Number(bal?.value?.uiAmountString ?? bal?.value?.uiAmount ?? "0");
  return Number.isFinite(ui) ? ui : 0;
}

async function getMintDecimals(mintPk) {
  const info = await rpcLimited("getParsedAccountInfo(mint)", (c) => c.getParsedAccountInfo(mintPk));
  const d = info?.value?.data?.parsed?.info?.decimals;
  return Number.isFinite(Number(d)) ? Number(d) : 0;
}

// Convert BigInt / 10^decimals to JS float safely (good enough for price display)
function bigIntToDecimalFloat(x, decimals) {
  const s = x.toString();
  if (decimals <= 0) return Number(s);
  if (s.length <= decimals) {
    const frac = s.padStart(decimals, "0");
    return Number(`0.${frac}`);
  }
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals);
  // limit fractional length to avoid huge floats
  return Number(`${i}.${f.slice(0, 12)}`);
}

// ---------------- BONDING CURVE PRICE (FIXED) ----------------
// Flexible reserve scan: find two u64s that look like reserves.
// This avoids hardcoding a single struct layout.
function parseBondingCurveAccountFlexible(data) {
  const buf = Buffer.from(data);
  const readU64At = (off) => {
    if (off + 8 > buf.length) return null;
    return buf.readBigUInt64LE(off);
  };

  // try offsets after discriminator (8 bytes)
  for (let off = 8; off + 16 <= buf.length; off += 8) {
    const a = readU64At(off);
    const b = readU64At(off + 8);
    if (a === null || b === null) continue;

    // basic plausibility filters
    if (a > 0n && b > 0n) {
      // virtualSolReserves usually in lamports, keep it under very large bound
      const maxLamports = 10_000_000_000_000_000n; // 10^16 lamports
      if (b < maxLamports) {
        // treat a=virtualToken, b=virtualSol (matches your original assumption)
        return { virtualTokenReserves: a, virtualSolReserves: b, offset: off };
      }
    }
  }
  return null;
}

async function getBondingCurvePriceByMint(mintStr) {
  const mintPk = new PublicKey(mintStr);
  const curvePda = deriveBondingCurvePda(mintPk);

  const acc = await rpcLimited("getAccountInfo(bondingCurve)", (c) =>
    c.getAccountInfo(curvePda, COMMITMENT)
  );

  if (!acc?.data) return { error: "bonding_curve_account_missing", bondingCurve: curvePda.toBase58() };

  const parsed = parseBondingCurveAccountFlexible(acc.data);
  if (!parsed) return { error: "curve_parse_failed", bondingCurve: curvePda.toBase58() };

  const { virtualTokenReserves, virtualSolReserves } = parsed;
  if (virtualTokenReserves <= 0n || virtualSolReserves <= 0n) {
    return { error: "invalid_curve_reserves", bondingCurve: curvePda.toBase58(), parsed };
  }

  const decimals = await getMintDecimals(mintPk);

  const sol = bigIntToDecimalFloat(virtualSolReserves, 9); // lamports -> SOL
  const tok = bigIntToDecimalFloat(virtualTokenReserves, decimals);

  if (!Number.isFinite(sol) || !Number.isFinite(tok) || tok <= 0) {
    return { error: "curve_price_math_failed", bondingCurve: curvePda.toBase58(), sol, tok, decimals };
  }

  return {
    priceSOL: sol / tok,
    source: "bonding_curve",
    bondingCurve: curvePda.toBase58(),
    reserves: {
      virtualSolLamports: virtualSolReserves.toString(),
      virtualTokenBaseUnits: virtualTokenReserves.toString(),
      decimals,
    },
  };
}

// ---------------- MIGRATION DISCOVERY (NEW) ----------------
function normalizeAccountKeys(message) {
  const ak = message?.accountKeys;
  if (!Array.isArray(ak)) return [];
  return ak.map((k) => (k?.pubkey ? k.pubkey : k)).filter(Boolean);
}

function txTouchesProgramFromParsed(tx, programId) {
  if (!programId) return false;
  const msg = tx?.transaction?.message;
  if (!msg) return false;

  const keys = normalizeAccountKeys(msg);
  const target = programId.toBase58();

  const programIdAt = (idx) => {
    const pk = keys[idx];
    if (!pk) return null;
    return pk.toBase58 ? pk.toBase58() : String(pk);
  };

  const check = (ix) =>
    ix && typeof ix.programIdIndex === "number" && programIdAt(ix.programIdIndex) === target;

  const outer = Array.isArray(msg.instructions) ? msg.instructions : [];
  if (outer.some(check)) return true;

  const innerGroups = Array.isArray(tx?.meta?.innerInstructions) ? tx.meta.innerInstructions : [];
  for (const g of innerGroups) {
    const inner = Array.isArray(g?.instructions) ? g.instructions : [];
    if (inner.some(check)) return true;
  }

  return false;
}

async function getParsedTx(sig) {
  try {
    return await rpcLimited("getParsedTransaction", (c) =>
      c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 })
    );
  } catch {
    return null;
  }
}

async function findMigrationSignature(mintPk) {
  const PAGE_LIMIT = Number(process.env.SIG_LIMIT_MINT_SCAN || 120);
  const HARD_CAP = Number(process.env.MINT_SCAN_HARD_CAP || 2000);

  let before = undefined;
  let scanned = 0;

  while (scanned < HARD_CAP) {
    const sigInfos = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
      c.getSignaturesForAddress(mintPk, { limit: PAGE_LIMIT, before })
    ).catch(() => []);

    if (!sigInfos.length) break;

    scanned += sigInfos.length;
    before = sigInfos[sigInfos.length - 1]?.signature;

    for (const s of sigInfos) {
      const sig = s?.signature;
      if (!sig) continue;

      const tx = await getParsedTx(sig);
      if (!tx) continue;

      const touchesPumpSwap = txTouchesProgramFromParsed(tx, PUMPSWAP_PROGRAM_ID);
      const touchesRaydium =
        (RAYDIUM_AMM_V4 && txTouchesProgramFromParsed(tx, RAYDIUM_AMM_V4)) ||
        (RAYDIUM_CPMM && txTouchesProgramFromParsed(tx, RAYDIUM_CPMM));

      if (touchesPumpSwap || touchesRaydium) {
        return {
          signature: sig,
          venue: touchesPumpSwap ? "pumpswap" : "raydium",
          scanned,
        };
      }
    }
  }

  return null;
}

// ---------------- MIGRATION PRICE (UNCHANGED, BUT AUTO-FILLED) ----------------
async function discoverVaults(migrationSig, tokenMint) {
  const tx = await rpcLimited("getTransaction(migration)", (c) =>
    c.getTransaction(migrationSig, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 1,
    })
  );

  if (!tx?.meta || !tx?.transaction?.message) return null;

  const keys = tx.transaction.message.accountKeys.map((k) =>
    k?.toBase58 ? k.toBase58() : String(k)
  );

  const post = Array.isArray(tx.meta.postTokenBalances) ? tx.meta.postTokenBalances : [];

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

async function getMigratedPrice(mintStr, migrationSig) {
  let vaults = VAULT_CACHE.get(mintStr);

  if (!vaults) {
    vaults = await discoverVaults(migrationSig, mintStr);
    if (!vaults) return { error: "vault_discovery_failed" };
    VAULT_CACHE.set(mintStr, vaults);
  }

  const wsol = await getUiBal(vaults.wsolVault);
  const tok = await getUiBal(vaults.tokenVault);

  if (wsol <= 0 || tok <= 0) return { error: "zero_reserves", vaults, reserves: { wsol, tok } };

  return {
    priceSOL: wsol / tok,
    source: "migration_pool",
    reserves: { wsol, token: tok },
    vaults,
  };
}

// ---------------- PUBLIC API ----------------
export async function getPumpFunPriceOnce(record) {
  const mintStr = record?.mint;
  if (!mintStr) return { error: "missing_mint" };

  // 1) Bonding curve first (robust)
  const curveRes = await getBondingCurvePriceByMint(mintStr);
  if (curveRes?.priceSOL && Number.isFinite(curveRes.priceSOL) && curveRes.priceSOL > 0) {
    return {
      priceSOL: Number(curveRes.priceSOL.toPrecision(10)),
      source: "bonding_curve",
      reserves: curveRes.reserves,
      bondingCurve: curveRes.bondingCurve,
    };
  }

  // 2) Migration: use provided sig, else auto-discover it
  let sig = record?.migration?.signature;
  let venue = record?.migration?.venue;

  if (!sig) {
    const found = await findMigrationSignature(new PublicKey(mintStr));
    if (found?.signature) {
      sig = found.signature;
      venue = found.venue;
    }
  }

  if (!sig) {
    return {
      error: "price_unavailable",
      curveError: curveRes?.error,
      migrationError: "missing_migration_signature",
    };
  }

  const migRes = await getMigratedPrice(mintStr, sig);
  if (migRes?.priceSOL) {
    return {
      priceSOL: Number(migRes.priceSOL.toPrecision(10)),
      source: `migration_pool_${venue || "unknown"}`,
      reserves: migRes.reserves,
      vaults: migRes.vaults,
      migration: { signature: sig, venue: venue || null },
      curveError: curveRes?.error,
    };
  }

  return {
    error: "price_unavailable",
    curveError: curveRes?.error,
    migrationError: migRes?.error || "migration_failed",
    migration: { signature: sig, venue: venue || null },
  };
}