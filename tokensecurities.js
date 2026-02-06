// verifyTokenSecurity.js (ESM)
// Supports Pump.fun bonding-curve + PumpSwap + Raydium migrations
// Migration is BONUS, not required.
// Adds: Liquidity proof gate (bonding curve OR migrated pool reserves must exist)

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import PQueue from "p-queue";

// ---------------- RPC FAILOVER ----------------
// Priority order: RPC_URL_3 -> RPC_URL_4
const RPC_ENDPOINTS = [process.env.RPC_URL_3, process.env.RPC_URL_4].filter(Boolean);
if (RPC_ENDPOINTS.length === 0) throw new Error("Missing RPC_URL_3 / RPC_URL_4 in env");

const COMMITMENT = "confirmed";
let activeRpcUrl = RPC_ENDPOINTS[0];
let conn = new Connection(activeRpcUrl, COMMITMENT);

function pickRpcCandidates() {
  return [...new Set(RPC_ENDPOINTS)];
}

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("block height exceeded") ||
    msg.includes("node is behind")
  );
}

function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, COMMITMENT);
}

async function withRpcFailover(opName, fn) {
  const urls = pickRpcCandidates();
  let lastErr = null;

  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);
    try {
      return await fn(conn);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }

  throw new Error(
    `[RPC_FAILOVER] ${opName} failed on all RPCs. last=${String(lastErr?.message || lastErr)}`
  );
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

// ---------------- PROGRAM IDS ----------------
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Raydium
const RAYDIUM_AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

// PumpSwap (MUST set in .env)
// If not set, PumpSwap migration detection is skipped (Raydium still works).
const PUMPSWAP_PROGRAM_ID = process.env.PUMPSWAP_PROGRAM_ID
  ? new PublicKey(process.env.PUMPSWAP_PROGRAM_ID)
  : null;

const PUMPSWAP_PROGRAM_ID_2 = process.env.PUMPSWAP_PROGRAM_ID_2
  ? new PublicKey(process.env.PUMPSWAP_PROGRAM_ID_2)
  : null;

// ---------------- SETTINGS ----------------
const SAFE_THRESHOLD = Number(process.env.SAFE_THRESHOLD || 80);
const TOP10_MAX_PCT = Number(process.env.TOP10_MAX_PCT || 0.35);

// Scan depth
const PAGE_LIMIT = Number(process.env.SIG_LIMIT_MINT_SCAN || 120);
const HARD_CAP = Number(process.env.MINT_SCAN_HARD_CAP || 2000);

// Optional bonding liquidity floor
const MIN_BONDING_SOL = Number(process.env.MIN_BONDING_SOL || 0); // set e.g. 0.2 if you want

// ---------------- Liquidity proof helpers ----------------
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function deriveBondingCurvePda(mintStr) {
  const mint = new PublicKey(mintStr);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

async function getUiBal(tokenAccountStr) {
  const bal = await rpcLimited("getTokenAccountBalance", (c) =>
    c.getTokenAccountBalance(new PublicKey(tokenAccountStr))
  );

  const ui = Number(bal?.value?.uiAmountString ?? bal?.value?.uiAmount ?? "0");
  return Number.isFinite(ui) ? ui : 0;
}

async function discoverVaultsFromMigrationTx(migrationSig, tokenMintStr) {
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
  if (!post.length) return null;

  const wsol = [];
  const tok = [];

  for (const b of post) {
    if (!b?.mint || typeof b.accountIndex !== "number") continue;
    const addr = keys[b.accountIndex];
    if (!addr) continue;

    if (b.mint === WSOL_MINT) wsol.push(addr);
    if (b.mint === tokenMintStr) tok.push(addr);
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

async function checkLiquidityState(mintPub, migration) {
  const mintStr = mintPub.toBase58();

  // A) Bonding curve proof (curve PDA has SOL)
  const curvePda = deriveBondingCurvePda(mintStr);

  const curveAcc = await rpcLimited("getAccountInfo(bondingCurve)", (c) =>
    c.getAccountInfo(curvePda, COMMITMENT)
  ).catch(() => null);

  if (curveAcc) {
    const lamports = await rpcLimited("getBalance(bondingCurve)", (c) =>
      c.getBalance(curvePda, COMMITMENT)
    ).catch(() => 0);

    const sol = Number(lamports) / 1e9;

    if (Number.isFinite(sol) && sol > MIN_BONDING_SOL) {
      return {
        ok: true,
        venue: "bonding_curve",
        curve: curvePda.toBase58(),
        solLiquidity: Number(sol.toFixed(6)),
      };
    }
  }

  // B) Migrated pool proof (Raydium or PumpSwap) using vault reserves
  if (migration?.signature) {
    const vaults = await discoverVaultsFromMigrationTx(migration.signature, mintStr);
    if (!vaults) {
      return {
        ok: false,
        venue: migration.venue || "migrated",
        reason: "vault_discovery_failed",
        migration,
      };
    }

    const wsol = await getUiBal(vaults.wsolVault);
    const tok = await getUiBal(vaults.tokenVault);

    if (wsol > 0 && tok > 0) {
      return {
        ok: true,
        venue: migration.venue || "migrated",
        migration,
        reserves: { wsol, token: tok },
        vaults,
      };
    }

    return {
      ok: false,
      venue: migration.venue || "migrated",
      reason: "zero_reserves",
      reserves: { wsol, token: tok },
      vaults,
      migration,
    };
  }

  return { ok: false, venue: "unknown", reason: "no_liquidity_detected" };
}

// ---------------- HELPERS ----------------
function safeNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
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
  if (keys.length === 0) return false;

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

async function getMintAuthorities(mintPub) {
  let mintAuthority = null;
  let freezeAuthority = null;

  try {
    const mintInfo = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
      c.getParsedAccountInfo(mintPub)
    );

    const parsed = mintInfo?.value?.data?.parsed?.info || {};
    mintAuthority = parsed?.mintAuthority ?? null;
    freezeAuthority = parsed?.freezeAuthority ?? null;

    if (mintAuthority === "11111111111111111111111111111111") mintAuthority = null;
    if (freezeAuthority === "11111111111111111111111111111111") freezeAuthority = null;
  } catch {}

  return { mintAuthority, freezeAuthority };
}

// Finds origin + optional migration (Raydium or PumpSwap)
async function findPumpfunAndMigration(mintPub) {
  const mintStr = mintPub.toBase58();

  let isPumpFun = false;
  let migration = null;
  let lpMint = null;

  let before = undefined;
  let scanned = 0;

  while (scanned < HARD_CAP && (!isPumpFun || !migration)) {
    let sigInfos = [];
    try {
      sigInfos = await rpcLimited("getSignaturesForAddress(mint)", (c) =>
        c.getSignaturesForAddress(mintPub, { limit: PAGE_LIMIT, before })
      );
    } catch {
      sigInfos = [];
    }

    if (!sigInfos.length) break;

    scanned += sigInfos.length;
    before = sigInfos[sigInfos.length - 1]?.signature;

    for (const s of sigInfos) {
      const sig = s?.signature;
      if (!sig) continue;

      const tx = await getParsedTx(sig);
      if (!tx) continue;

      if (!isPumpFun && txTouchesProgramFromParsed(tx, PUMP_PROGRAM_ID)) {
        isPumpFun = true;
      }

      const touchesRaydium =
        txTouchesProgramFromParsed(tx, RAYDIUM_AMM_V4) ||
        txTouchesProgramFromParsed(tx, RAYDIUM_CPMM);

      const touchesPumpSwap =
        (PUMPSWAP_PROGRAM_ID && txTouchesProgramFromParsed(tx, PUMPSWAP_PROGRAM_ID)) ||
        (PUMPSWAP_PROGRAM_ID_2 && txTouchesProgramFromParsed(tx, PUMPSWAP_PROGRAM_ID_2));

      if ((touchesRaydium || touchesPumpSwap) && !migration) {
        migration = {
          signature: sig,
          slot: tx.slot,
          blockTime: typeof tx.blockTime === "number" ? tx.blockTime : null,
          venue: touchesRaydium ? "raydium" : "pumpswap",
        };

        const pre = new Set(
          (tx.meta?.preTokenBalances || []).map((b) => b?.mint).filter(Boolean)
        );
        const post = new Set(
          (tx.meta?.postTokenBalances || []).map((b) => b?.mint).filter(Boolean)
        );

        const candidates = [];
        for (const m of post) {
          if (!pre.has(m) && m !== mintStr) candidates.push(m);
        }
        lpMint = candidates[0] || null;
      }

      if (isPumpFun && migration) break;
    }
  }

  return { isPumpFun, migration, lpMint, scanned };
}

async function top10Concentration(mintPub) {
  try {
    const largest = await rpcLimited("getTokenLargestAccounts(mint)", (c) =>
      c.getTokenLargestAccounts(mintPub)
    );
    const arr = Array.isArray(largest?.value) ? largest.value : [];
    if (arr.length === 0) return { ok: false, pct: 1, reason: "no_holders" };

    const top10 = arr.slice(0, 10).map((x) => safeNumber(x.uiAmountString, 0));
    const top10Sum = top10.reduce((a, b) => a + b, 0);

    const supplyResp = await rpcLimited("getTokenSupply(mint)", (c) =>
      c.getTokenSupply(mintPub)
    );
    const supplyUi = safeNumber(supplyResp?.value?.uiAmountString, 0);
    if (!supplyUi || supplyUi <= 0) return { ok: false, pct: 1, reason: "supply_zero" };

    const pct = top10Sum / supplyUi;
    return { ok: pct <= TOP10_MAX_PCT, pct, supplyUi, top10Sum };
  } catch {
    return { ok: false, pct: 1, reason: "top10_check_failed" };
  }
}

// Honeypot / sellability gate
async function honeypotRiskGate(mintPub) {
  const parsedMintInfo = await rpcLimited("getParsedAccountInfo(mint)", (c) =>
    c.getParsedAccountInfo(mintPub)
  ).catch(() => null);

  const parsed = parsedMintInfo?.value?.data?.parsed?.info || {};
  let freezeAuthority = parsed?.freezeAuthority ?? null;
  if (freezeAuthority === "11111111111111111111111111111111") freezeAuthority = null;

  if (freezeAuthority) {
    return { ok: false, reason: `freeze_authority_present:${freezeAuthority}` };
  }

  const rawInfo = await rpcLimited("getAccountInfo(mint)", (c) =>
    c.getAccountInfo(mintPub)
  ).catch(() => null);

  const ownerStr = rawInfo?.owner?.toBase58?.() || null;
  const isToken2022 = ownerStr === TOKEN_2022_PROGRAM_ID.toBase58();

  const extensions = Array.isArray(parsed?.extensions) ? parsed.extensions : [];
  const extStrings = extensions.map((x) => String(x).toLowerCase());

  const dangerous =
    extStrings.some((e) => e.includes("transferhook")) ||
    extStrings.some((e) => e.includes("confidential")) ||
    extStrings.some((e) => e.includes("defaultaccountstate")) ||
    extStrings.some((e) => e.includes("nontransferable")) ||
    extStrings.some((e) => e.includes("transferfee")) ||
    extStrings.some((e) => e.includes("withheld"));

  if (isToken2022 && dangerous) {
    return {
      ok: false,
      reason: `token2022_dangerous_extensions:${extStrings.join(",") || "unknown"}`,
    };
  }

  if (isToken2022) {
    return { ok: false, reason: "token2022_blocked" };
  }

  const isTokenProgram = ownerStr === TOKEN_PROGRAM_ID.toBase58();
  if (!isTokenProgram) {
    return { ok: false, reason: `unknown_token_program_owner:${ownerStr || "null"}` };
  }

  return { ok: true, reason: "sellability_risk_ok" };
}

// ---------------- EXPORTED ----------------
export async function verifyTokenSecurity(mint) {
  const reasons = [];
  let score = 0;

  let mintPub;
  try {
    mintPub = new PublicKey(mint);
  } catch {
    return { safe: false, score: 0, reasons: ["Invalid mint"], details: {} };
  }

  // 1) Find origin + optional migration
  const { isPumpFun, migration, lpMint, scanned } = await findPumpfunAndMigration(mintPub);

  // 1) Pump.fun origin check (hard requirement)
  if (!isPumpFun) {
    return {
      safe: false,
      score: 0,
      reasons: ["Not a Pump.fun mint"],
      details: { isPumpFun, scanned },
    };
  }
  score += 20;
  reasons.push("pumpfun_origin");

  // 2) Liquidity state label (bonding curve OR migrated)
  if (migration) {
    score += 20;
    reasons.push(`migrated_${migration.venue}`);
  } else {
    reasons.push("bonding_curve_active");
  }

  // 2.5) Liquidity proof gate (bonding curve OR migrated pool must have reserves)
  const liq = await checkLiquidityState(mintPub, migration);

  if (!liq.ok) {
    return {
      safe: false,
      score: 0,
      reasons: [`liquidity_missing (${liq.reason})`],
      details: { isPumpFun, migration, scanned, liquidity: liq },
    };
  }

  // optional: small score bump for proven liquidity
  score += 5;
  reasons.push(`liquidity_ok_${liq.venue}`);

  // 3) Mint authority + freeze authority must be null
  const { mintAuthority, freezeAuthority } = await getMintAuthorities(mintPub);

  if (mintAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`mint authority NOT renounced -> ${mintAuthority}`],
      details: { mintAuthority, freezeAuthority, isPumpFun, migration, scanned },
    };
  }
  score += 15;
  reasons.push("mint_authority_null");

  if (freezeAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`freeze authority NOT renounced -> ${freezeAuthority}`],
      details: { mintAuthority, freezeAuthority, isPumpFun, migration, scanned },
    };
  }
  score += 10;
  reasons.push("freeze_authority_null");

  // 4) Honeypot / sellability gate
  const hp = await honeypotRiskGate(mintPub);
  if (!hp.ok) {
    return {
      safe: false,
      score: 0,
      reasons: [`honeypot_risk_gate_fail (${hp.reason})`],
      details: { isPumpFun, migration, lpMint, scanned, honeypotGate: hp },
    };
  }
  score += 30;
  reasons.push("honeypot_risk_gate_ok");

  // 5) Optional distribution check
  const dist = await top10Concentration(mintPub);
  if (dist.ok) {
    score += 5;
    reasons.push(`top10_ok_${dist.pct.toFixed(4)}`);
  } else {
    reasons.push(`top10_high_${dist.pct.toFixed(4)}`);
  }

  if (score > 100) score = 100;

  const safe = score >= SAFE_THRESHOLD;

  return {
    safe,
    score,
    reasons,
    details: {
      isPumpFun,
      migration, // null if bonding curve
      lpMint, // debug only
      scanned,
      distribution: dist,
      honeypotGate: hp,
      liquidity: liq,
      liquidityState: liq.venue,
      rpcUsed: activeRpcUrl,
    },
  };
}
