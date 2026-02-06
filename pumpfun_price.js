// pumpfun_price.js (ESM)
// Pump.fun bonding curve spot price (virtual reserves) + auto-detect migration to Raydium/PumpSwap
// If migrated: compute pool price from vault reserves (WSOL/token) using migration tx signature discovery

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

// ---------------- RPC FAILOVER ----------------
const RPC_URL_20 = process.env.RPC_URL_20;
const RPC_URL_30 = process.env.RPC_URL_30;

if (!RPC_URL_20 && !RPC_URL_30) {
  throw new Error("Missing RPC_URL_20 / RPC_URL_30 in .env");
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
    msg.includes("node is behind") ||
    msg.includes("block height exceeded")
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
      console.log(`[RPC] switched -> ${url}`);
    }

    try {
      return await fn(conn);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
      console.log(`[RPC] retryable error on ${url}: ${String(e?.message || e)}`);
    }
  }

  throw new Error(`[RPC_FAILOVER] ${opName} failed: ${String(lastErr?.message || lastErr)}`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[TIMEOUT] ${label} after ${ms}ms`)), ms)
    ),
  ]);
}

const q = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function rpcLimited(opName, fn) {
  const timeoutMs = Number(process.env.RPC_TIMEOUT_MS || 15000);
  return q.add(() => withTimeout(withRpcFailover(opName, fn), timeoutMs, opName));
}

// ---------------- CONSTANTS ----------------
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const VAULT_CACHE = new Map();

// Pump.fun program id
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// bondingCurve account discriminator (Pump.fun)
const BONDING_CURVE_DISCRIM = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);

function deriveBondingCurvePda(mint) {
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPk.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// ---------------- Migration detection (Raydium + PumpSwap) ----------------
// Raydium program ids
const RAYDIUM_AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

// PumpSwap program ids from env (set these)
const PUMPSWAP_PROGRAM_ID = process.env.PUMPSWAP_PROGRAM_ID
  ? new PublicKey(process.env.PUMPSWAP_PROGRAM_ID)
  : null;

const PUMPSWAP_PROGRAM_ID_2 = process.env.PUMPSWAP_PROGRAM_ID_2
  ? new PublicKey(process.env.PUMPSWAP_PROGRAM_ID_2)
  : null;

// Scan settings (tune if needed)
const SIG_PAGE_LIMIT = Number(process.env.SIG_LIMIT_MINT_SCAN || 120);
const SIG_HARD_CAP = Number(process.env.MINT_SCAN_HARD_CAP || 1500);

// Cache migration per mint to avoid re-scanning
const MIGRATION_CACHE = new Map();

// ---------------- helpers ----------------
async function getUiBal(tokenAccount) {
  const bal = await rpcLimited("getTokenAccountBalance", (c) =>
    c.getTokenAccountBalance(new PublicKey(tokenAccount))
  );
  const ui = Number(bal?.value?.uiAmountString ?? bal?.value?.uiAmount ?? "0");
  return Number.isFinite(ui) ? ui : 0;
}

async function getMintDecimals(mintPub) {
  const info = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mintPub)
  ).catch(() => null);
  const dec = info?.value?.data?.parsed?.info?.decimals;
  return Number.isFinite(Number(dec)) ? Number(dec) : 0;
}

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
  if (!keys.length) return false;

  const target = programId.toBase58();

  const programIdAt = (idx) => {
    const pk = keys[idx];
    if (!pk) return null;
    return pk.toBase58 ? pk.toBase58() : String(pk);
  };

  const check = (ix) => {
    if (!ix || typeof ix.programIdIndex !== "number") return false;
    return programIdAt(ix.programIdIndex) === target;
  };

  const outer = Array.isArray(msg.instructions) ? msg.instructions : [];
  if (outer.some(check)) return true;

  const innerGroups = Array.isArray(tx?.meta?.innerInstructions)
    ? tx.meta.innerInstructions
    : [];

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

async function findMigrationForMint(mintPub) {
  const mintStr = mintPub.toBase58();
  if (MIGRATION_CACHE.has(mintStr)) return MIGRATION_CACHE.get(mintStr);

  console.log(`[mig-scan] start mint=${mintStr} limit=${SIG_HARD_CAP}`);

  let before = undefined;
  let scanned = 0;

  while (scanned < SIG_HARD_CAP) {
    const sigInfos = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
      c.getSignaturesForAddress(mintPub, { limit: SIG_PAGE_LIMIT, before })
    ).catch(() => []);

    if (!sigInfos.length) break;

    scanned += sigInfos.length;
    before = sigInfos[sigInfos.length - 1]?.signature;

    if (scanned % 240 === 0) {
      console.log(`[mig-scan] progress scanned=${scanned} before=${before}`);
    }

    for (const s of sigInfos) {
      const sig = s?.signature;
      if (!sig) continue;

      const tx = await getParsedTx(sig);
      if (!tx) continue;

      const touchesRaydium =
        txTouchesProgramFromParsed(tx, RAYDIUM_AMM_V4) ||
        txTouchesProgramFromParsed(tx, RAYDIUM_CPMM);

      const touchesPumpSwap =
        (PUMPSWAP_PROGRAM_ID && txTouchesProgramFromParsed(tx, PUMPSWAP_PROGRAM_ID)) ||
        (PUMPSWAP_PROGRAM_ID_2 && txTouchesProgramFromParsed(tx, PUMPSWAP_PROGRAM_ID_2));

      if (touchesRaydium || touchesPumpSwap) {
        const migration = {
          signature: sig,
          slot: tx.slot,
          blockTime: typeof tx.blockTime === "number" ? tx.blockTime : null,
          venue: touchesRaydium ? "raydium" : "pumpswap",
          scanned,
        };

        MIGRATION_CACHE.set(mintStr, migration);
        console.log(`[mig-scan] FOUND venue=${migration.venue} sig=${sig} scanned=${scanned}`);
        return migration;
      }
    }
  }

  const res = { signature: null, venue: null, scanned };
  MIGRATION_CACHE.set(mintStr, res);
  console.log(`[mig-scan] not found scanned=${scanned}`);
  return res;
}

// ---------------- Bonding curve parser ----------------
// Full curve layout:
// discriminator [8]
// virtualTokenReserves u64
// virtualSolReserves   u64
// realTokenReserves    u64
// realSolReserves      u64
// tokenTotalSupply     u64
// complete             bool
function parseBondingCurveState(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 8 + 8 * 5 + 1) return { error: "curve_data_too_small" };

  const disc = buf.subarray(0, 8);
  if (!disc.equals(BONDING_CURVE_DISCRIM)) {
    return { error: "invalid_curve_discriminator" };
  }

  let off = 8;
  const readU64 = () => {
    const v = buf.readBigUInt64LE(off);
    off += 8;
    return v;
  };

  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = buf.readUInt8(off) !== 0;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

// Spot price on curve should use VIRTUAL reserves
function calcCurveSpotPriceSOL(virtualSolLamports, virtualTokenBaseUnits, decimals) {
  const sol = Number(virtualSolLamports) / 1e9;
  const tok = Number(virtualTokenBaseUnits) / Math.pow(10, decimals);

  if (!Number.isFinite(sol) || !Number.isFinite(tok)) return null;
  if (sol <= 0 || tok <= 0) return null;

  return sol / tok;
}

// ---------------- BONDING CURVE PRICE ----------------
async function getBondingCurvePrice(mintStr) {
  const mintPub = new PublicKey(mintStr);
  const curvePda = deriveBondingCurvePda(mintPub);

  console.log(`[curve] pda=${curvePda.toBase58()}`);

  const acc = await rpcLimited("getAccountInfo(bondingCurve)", (c) =>
    c.getAccountInfo(curvePda, COMMITMENT)
  ).catch(() => null);

  if (!acc?.data) {
    return { error: "bonding_curve_account_missing", bondingCurve: curvePda.toBase58() };
  }

  const state = parseBondingCurveState(acc.data);
  if (state?.error) {
    return { error: state.error, bondingCurve: curvePda.toBase58() };
  }

  const decimals = await getMintDecimals(mintPub);

  const priceSOL = calcCurveSpotPriceSOL(
    state.virtualSolReserves,
    state.virtualTokenReserves,
    decimals
  );

  console.log(
    `[curve] complete=${state.complete} vSOL=${state.virtualSolReserves.toString()} vTOK=${state.virtualTokenReserves.toString()} dec=${decimals}`
  );

  if (!priceSOL) {
    return {
      error: "invalid_virtual_reserves",
      reserves: {
        virtualSolLamports: state.virtualSolReserves.toString(),
        virtualTokenBaseUnits: state.virtualTokenReserves.toString(),
        realSolLamports: state.realSolReserves.toString(),
        realTokenBaseUnits: state.realTokenReserves.toString(),
        tokenTotalSupply: state.tokenTotalSupply.toString(),
        decimals,
        complete: state.complete,
      },
      bondingCurve: curvePda.toBase58(),
    };
  }

  return {
    priceSOL: Number(priceSOL.toPrecision(12)),
    source: "bonding_curve",
    reserves: {
      virtualSolLamports: state.virtualSolReserves.toString(),
      virtualTokenBaseUnits: state.virtualTokenReserves.toString(),
      decimals,
      complete: state.complete,
    },
    bondingCurve: curvePda.toBase58(),
  };
}

// ---------------- MIGRATION PRICE ----------------
async function discoverVaults(migrationSig, tokenMint) {
  console.log(`[mig] discoverVaults sig=${migrationSig}`);

  const tx = await rpcLimited("getTransaction(migration)", (c) =>
    c.getTransaction(migrationSig, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 1,
    })
  ).catch(() => null);

  if (!tx?.meta || !tx?.transaction?.message) return null;

  const keys = tx.transaction.message.accountKeys.map((k) =>
    k?.toBase58 ? k.toBase58() : String(k)
  );

  const post = Array.isArray(tx.meta.postTokenBalances) ? tx.meta.postTokenBalances : [];
  if (!post.length) return null;

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

  console.log(`[mig] vaults wsol=${bestW.addr} (${bestW.ui}) tok=${bestT.addr} (${bestT.ui})`);
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

  console.log(`[mig] reserves wsol=${wsol} tok=${tok}`);

  if (wsol <= 0 || tok <= 0) return { error: "zero_reserves" };

  const priceSOL = wsol / tok;
  if (!Number.isFinite(priceSOL) || priceSOL <= 0) return { error: "invalid_pool_price" };

  return {
    priceSOL: Number(priceSOL.toPrecision(12)),
    source: "migration_pool",
    reserves: { wsol, token: tok },
    vaults,
  };
}

// ---------------- PUBLIC API ----------------
export async function getPumpFunPriceOnce(record) {
  if (!record?.mint) return { error: "missing_mint" };

  console.log(`[price] mint=${record.mint}`);

  // 1) Bonding curve first
  const curveRes = await getBondingCurvePrice(record.mint);
  if (curveRes?.priceSOL) return curveRes;

  console.log(`[price] curve failed -> ${curveRes?.error}`);

  // 2) If migration signature not provided, auto-discover it
  let migSig = record?.migration?.signature || null;

  if (!migSig) {
    const mintPub = new PublicKey(record.mint);
    const mig = await findMigrationForMint(mintPub);

    if (mig?.signature) {
      migSig = mig.signature;
      record.migration = {
        ...(record.migration || {}),
        signature: mig.signature,
        venue: mig.venue,
      };
      console.log(`[price] auto migration -> venue=${mig.venue} sig=${mig.signature}`);
    } else {
      return {
        error: "price_unavailable",
        curveError: curveRes?.error,
        curveDebug: curveRes?.reserves || null,
        migrationError: "missing_migration_signature_and_not_found",
        migrationScan: mig,
      };
    }
  }

  // 3) Migration fallback using discovered signature
  const migRes = await getMigratedPrice(record);
  if (migRes?.priceSOL) return migRes;

  console.log(`[price] migration failed -> ${migRes?.error}`);

  return {
    error: "price_unavailable",
    curveError: curveRes?.error,
    curveDebug: curveRes?.reserves || null,
    migrationError: migRes?.error,
  };
}
