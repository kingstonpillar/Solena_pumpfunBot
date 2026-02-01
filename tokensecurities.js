        
import { Connection, PublicKey } from "@solana/web3.js";
import PQueue from "p-queue";

// Hardcoded Helius RPC
const RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=ffce4942-e7c6-45cc-ab51-1e0ce95bb175";

const conn = new Connection(RPC_URL, "confirmed");

// Pump.fun program id
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Raydium program ids (mainnet)
const RAYDIUM_AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

// Solana incinerator address
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

// Settings
const SIG_LIMIT_MINT_SCAN = 120;      // how many mint-related txs to scan
const MIN_LP_BURN_PCT = 0.95;         // LP burn requirement
const SAFE_THRESHOLD = 80;            // final score threshold
const TOP10_MAX_PCT = 0.35;           // optional distribution rule

// RPC limiter
const q = new PQueue({
  intervalCap: 8,
  interval: 1000,
  carryoverConcurrencyCount: true,
});

function rpcLimited(fn) {
  return q.add(fn);
}

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
    return await rpcLimited(() =>
      conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 })
    );
  } catch {
    return null;
  }
}

async function getMintAuthorities(mintPub) {
  let mintAuthority = null;
  let freezeAuthority = null;

  try {
    const mintInfo = await rpcLimited(() => conn.getParsedAccountInfo(mintPub));
    const parsed = mintInfo?.value?.data?.parsed?.info || {};

    mintAuthority = parsed?.mintAuthority ?? null;
    freezeAuthority = parsed?.freezeAuthority ?? null;

    if (mintAuthority === "11111111111111111111111111111111") mintAuthority = null;
    if (freezeAuthority === "11111111111111111111111111111111") freezeAuthority = null;
  } catch {
    // leave nulls, caller will handle
  }

  return { mintAuthority, freezeAuthority };
}

// Scan mint txs. Confirm pump.fun origin, detect migration tx, and attempt to extract LP mint.
async function findPumpfunAndMigration(mintPub) {
  const mintStr = mintPub.toBase58();

  let sigInfos = [];
  try {
    sigInfos = await rpcLimited(() =>
      conn.getSignaturesForAddress(mintPub, { limit: SIG_LIMIT_MINT_SCAN })
    );
  } catch {
    sigInfos = [];
  }

  let isPumpFun = false;
  let migration = null;
  let lpMint = null;

  for (const s of sigInfos || []) {
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

    if (touchesRaydium && !migration) {
      migration = {
        signature: sig,
        slot: tx.slot,
        blockTime: typeof tx.blockTime === "number" ? tx.blockTime : null,
      };

      // Heuristic LP mint extraction: find "new mint" in postTokenBalances not in preTokenBalances
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

  return { isPumpFun, migration, lpMint };
}

async function getLargestTokenAccountOwner(tokenAccountPubkey) {
  try {
    const info = await rpcLimited(() => conn.getParsedAccountInfo(tokenAccountPubkey));
    return info?.value?.data?.parsed?.info?.owner || null;
  } catch {
    return null;
  }
}

async function checkLpBurn(lpMintStr) {
  try {
    const lpMintPub = new PublicKey(lpMintStr);

    const supplyResp = await rpcLimited(() => conn.getTokenSupply(lpMintPub));
    const supplyUi = safeNumber(supplyResp?.value?.uiAmountString, 0);
    if (!Number.isFinite(supplyUi) || supplyUi <= 0) {
      return { ok: false, reason: "lp_supply_zero" };
    }

    const largest = await rpcLimited(() => conn.getTokenLargestAccounts(lpMintPub));
    const top = largest?.value?.[0];

    if (!top?.address || !top?.uiAmountString) {
      return { ok: false, reason: "lp_largest_missing" };
    }

    const topAmt = safeNumber(top.uiAmountString, 0);
    const pct = topAmt / supplyUi;

    const owner = await getLargestTokenAccountOwner(top.address);
    if (!owner) {
      return { ok: false, reason: "lp_owner_unknown", pct };
    }

    const burned = owner === INCINERATOR.toBase58() && pct >= MIN_LP_BURN_PCT;

    return {
      ok: burned,
      reason: burned ? "lp_burned" : "lp_not_burned",
      pct,
      owner,
      supplyUi,
      topAmt,
      topTokenAccount: top.address.toBase58(),
    };
  } catch {
    return { ok: false, reason: "lp_burn_check_failed" };
  }
}

// Optional distribution check. Not "liquidity", just concentration.
async function top10Concentration(mintPub) {
  try {
    const largest = await rpcLimited(() => conn.getTokenLargestAccounts(mintPub));
    const arr = Array.isArray(largest?.value) ? largest.value : [];
    if (arr.length === 0) return { ok: false, pct: 1, reason: "no_holders" };

    // Sum top 10 ui amounts
    const top10 = arr.slice(0, 10).map((x) => safeNumber(x.uiAmountString, 0));
    const top10Sum = top10.reduce((a, b) => a + b, 0);

    // Need total supply to get pct
    const supplyResp = await rpcLimited(() => conn.getTokenSupply(mintPub));
    const supplyUi = safeNumber(supplyResp?.value?.uiAmountString, 0);
    if (!supplyUi || supplyUi <= 0) return { ok: false, pct: 1, reason: "supply_zero" };

    const pct = top10Sum / supplyUi;
    return { ok: pct <= TOP10_MAX_PCT, pct, supplyUi, top10Sum };
  } catch {
    return { ok: false, pct: 1, reason: "top10_check_failed" };
  }
}

// Exported
export async function verifyTokenSecurity(mint) {
  const reasons = [];
  let score = 0;

  const mintPub = (() => {
    try { return new PublicKey(mint); } catch { return null; }
  })();

  if (!mintPub) return { safe: false, score: 0, reasons: ["Invalid mint"], details: {} };

  // 1) Pump.fun origin + migration + LP mint discovery
  const { isPumpFun, migration, lpMint } = await findPumpfunAndMigration(mintPub);

  if (!isPumpFun) {
    return { safe: false, score: 0, reasons: ["Not a Pump.fun mint"], details: { isPumpFun } };
  }
  score += 20;
  reasons.push("pumpfun_origin");

  if (!migration) {
    return { safe: false, score: 0, reasons: ["Not migrated to Raydium yet"], details: { isPumpFun, migration: null } };
  }
  score += 20;
  reasons.push("migrated");

  // 2) Mint authority and freeze authority must be null
  const { mintAuthority, freezeAuthority } = await getMintAuthorities(mintPub);

  if (mintAuthority) {
    return { safe: false, score: 0, reasons: [`mint authority NOT renounced -> ${mintAuthority}`], details: { mintAuthority, freezeAuthority } };
  }
  score += 15;
  reasons.push("mint_authority_null");

  if (freezeAuthority) {
    return { safe: false, score: 0, reasons: [`freeze authority NOT renounced -> ${freezeAuthority}`], details: { mintAuthority, freezeAuthority } };
  }
  score += 10;
  reasons.push("freeze_authority_null");

  // 3) LP burn required
  if (!lpMint) {
    return {
      safe: false,
      score: 0,
      reasons: ["LP mint not detected yet"],
      details: { isPumpFun, migration, lpMint: null },
    };
  }

  const burn = await checkLpBurn(lpMint);
  if (!burn.ok) {
    return {
      safe: false,
      score: 0,
      reasons: [`LP not burned (${burn.reason})`],
      details: { isPumpFun, migration, lpMint, burn },
    };
  }

  score += 30;
  reasons.push("lp_burned");

  // 4) Optional distribution score (not a hard fail)
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
      migration,
      lpMint,
      lpBurnPct: burn.pct,
      lpTopOwner: burn.owner,
      distribution: dist,
    },
  };
}
