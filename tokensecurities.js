import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getCanonicalMint } from "./canonical_mint.js";

// ---------------- RPC SETUP ----------------
const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=ffce4942-e7c6-45cc-ab51-1e0ce95bb175";
const RPC_ENDPOINTS = [process.env.RPC_URL_3, process.env.RPC_URL_4].filter(Boolean);
if (!RPC_ENDPOINTS.length) throw new Error("Missing RPC_URL_3 / RPC_URL_4 in env");

const COMMITMENT = process.env.COMMITMENT || "confirmed";

// Active connection using RPC_URL_3 initially
let activeRpcUrl = RPC_ENDPOINTS[0];
let conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });

// ---------------- Helper Functions ----------------
function pickRpcCandidates() {
  return [...new Set(RPC_ENDPOINTS)];
}

function switchRpc(url) {
  activeRpcUrl = url;
  conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });
}

// Classic SPL token account layout owner offset: bytes 32..64
function readTokenAccountOwnerFromRaw(accInfo) {
  const d = accInfo?.data;
  if (!d || typeof d?.subarray !== "function" || d.length < 64) return null;
  return new PublicKey(d.subarray(32, 64)).toBase58();
}

// ---------------- Core reads ----------------
async function getMintParsedAndRaw(mintPub) {
  let lastErr = null;

  for (const url of pickRpcCandidates()) {
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      const [raw, parsedResp] = await Promise.all([
        conn.getAccountInfo(mintPub, { commitment: COMMITMENT }),
        conn.getParsedAccountInfo(mintPub, { commitment: COMMITMENT })
      ]);

      if (raw) return { raw, parsed: parsedResp?.value || null };
      continue;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  return {
    raw: null,
    parsed: null,
    err: lastErr ? String(lastErr?.message || lastErr) : null,
  };
}

// ---------------- Token-2022 Risk Check ----------------
// This function checks for risky extensions on Token-2022
function token2022RiskFromParsed(parsedInfo) {
  const exts = Array.isArray(parsedInfo?.extensions) ? parsedInfo.extensions : [];
  const riskyExtensions = [
    "transferhook",
    "confidential",
    "nontransferable",
    "transferfee",
    "withheld",
    "mintcloseauthority",
    "permanentdelegate"
  ];

  const risky = exts.some(ext => riskyExtensions.some(risk => ext.toLowerCase().includes(risk)));

  return { risky, extensions: exts };
}

// ---------------- Top10 Function using Helius ----------------
let retry_count = 0;
const max_retries = 5;

async function getTop10FromHelius(mintAddress) {
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
    retry_count++;
    if (retry_count <= max_retries) {
      const wait_time = Math.pow(2, retry_count) * 2; // Exponential backoff
      console.log(`Rate limit hit. Retrying in ${wait_time} seconds... (Attempt ${retry_count} of ${max_retries})`);
      await new Promise(resolve => setTimeout(resolve, wait_time * 1000)); // wait in seconds
      return getTop10FromHelius(mintAddress); // Retry
    } else {
      throw new Error('Max retries reached');
    }
  }

  return data?.result || null;
}

// ---------------- FINAL Function to get Top 10 and Calculate Pct ----------------
async function getTop10Pct(mintPub, commitment = "confirmed", isToken2022 = false) {
  const supplyResp = await conn.getTokenSupply(mintPub, { commitment });
  const supply = BigInt(supplyResp?.value?.amount || "0");
  if (supply <= 0n) return { ok: false, pct: null, reason: "supply_zero" };

  // Fetch top 10 holders either using Helius or Solana RPC
  let top10Data = null;

  if (isToken2022) {
    top10Data = await getTop10FromHelius(mintPub.toBase58());  // Helius call
  } else {
    try {
      const largestResp = await conn.getTokenLargestAccounts(mintPub, { commitment });  // Solana RPC call
      top10Data = Array.isArray(largestResp?.value) ? largestResp.value : [];
    } catch (e) {
      top10Data = null;
    }
  }

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

// ---------------- checkTokenSecurity ----------------
export async function checkTokenSecurity(mintOrRecord) {
  const reasons = [];
  let score = 0;

  const details = {
    input: mintOrRecord,
    rpcUsed: activeRpcUrl,
    resolver: null,
    mint: null,
    owner: null,
    decimals: null,
    distribution: null,
    mintErr: null,
  };

  // 0) Canonical mint gateway
  const canon = await getCanonicalMint(mintOrRecord, COMMITMENT);
  if (!canon?.ok || !canon.mint) {
    return {
      safe: false,
      score: 0,
      reasons: ["Unresolved mint identifier"],
      details: {
        input: mintOrRecord,
        resolver: canon?.resolver || null,
        error: canon?.error || null,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  const mintStr = String(canon.mint).trim();
  const resolverMeta = canon?.resolver || null;

  details.mint = mintStr;
  details.resolver = resolverMeta;

  let mintPub;
  try {
    mintPub = new PublicKey(mintStr);
  } catch {
    return {
      safe: false,
      score: 0,
      reasons: ["Invalid canonical mint"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  const { parsed, raw, err } = await getMintParsedAndRaw(mintPub);
  details.mintErr = err || null;

  if (!raw) {
    return {
      safe: false,
      score: 0,
      reasons: ["Mint account not found on-chain (bad mint or RPC issue)"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
        err: err || null,
      },
    };
  }

  const ownerStr = raw.owner?.toBase58?.() || null;
  details.owner = ownerStr;

  const isTokenProgram = ownerStr === TOKEN_PROGRAM_ID.toBase58();
  const isToken2022 = ownerStr === TOKEN_2022_PROGRAM_ID.toBase58();

  if (!isTokenProgram && !isToken2022) {
    return {
      safe: false,
      score: 0,
      reasons: [`Unknown token program owner: ${ownerStr || "null"}`],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        owner: ownerStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  score += 15;
  reasons.push(isTokenProgram ? "spl_token_program" : "token2022_program");

  if (!parsed) {
    return {
      safe: false,
      score: 0,
      reasons: ["Mint parsed info unavailable (RPC parsing issue)"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  const { mintAuthority, freezeAuthority, decimals, isInitialized, parsedInfo } =
    extractMintAuthorities(parsed);

  details.decimals = decimals;

  if (!isInitialized) {
    return {
      safe: false,
      score: 0,
      reasons: ["Mint not initialized"],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        decimals,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  if (mintAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`Mint authority present: ${mintAuthority}`],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        mintAuthority,
        freezeAuthority,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  score += 35;
  reasons.push("mint_authority_renounced");

  if (freezeAuthority) {
    return {
      safe: false,
      score: 0,
      reasons: [`Freeze authority present: ${freezeAuthority}`],
      details: {
        input: mintOrRecord,
        mint: mintStr,
        mintAuthority,
        freezeAuthority,
        resolver: resolverMeta,
        rpcUsed: activeRpcUrl,
      },
    };
  }

  score += 25;
  reasons.push("freeze_authority_renounced");

  if (isToken2022) {
    const r = token2022RiskFromParsed(parsedInfo);
    if (r.risky) {
      return {
        safe: false,
        score: 0,
        reasons: [`Token-2022 risky extensions: ${r.extensions.join(",") || "unknown"}`],
        details: {
          input: mintOrRecord,
          mint: mintStr,
          token2022: r,
          resolver: resolverMeta,
          rpcUsed: activeRpcUrl,
        },
      };
    }

    score += 10;
    reasons.push("token2022_no_dangerous_extensions");
  }

  const TOP10_MAX_PCT_FRAC = Number(process.env.TOP10_MAX_PCT || 0.27); // fraction
  const TOP10_MAX_PCT_PCT = TOP10_MAX_PCT_FRAC * 100; // percent

  let t10 = null;
  try {
    t10 = await rpcTryAll("top10", (c) =>
      getTop10Pct(c, mintPub, COMMITMENT, isToken2022)
    );
  } catch {
    t10 = null;
  }

  if (!t10?.ok || t10.pct == null) {
    reasons.push(`top10_unknown_${t10?.reason || "rpc_fail"}`);
    details.distribution = { reason: t10?.reason || "rpc_fail" };
  } else {
    details.distribution = { top10Pct: t10.pct, reason: t10.reason };

    if (t10.pct > TOP10_MAX_PCT_PCT) {
      details.rpcUsed = activeRpcUrl; // after failovers
      return {
        safe: false,
        score: 0,
        reasons: [
          `top10_hard_fail_${t10.pct.toFixed(2)}_gt_${TOP10_MAX_PCT_PCT.toFixed(2)}`,
        ],
        details,
      };
    }

    score += 15;
    reasons.push(`top10_ok_${t10.pct.toFixed(2)}`);
  }

  if (score > 100) score = 100;

  const SAFE_THRESHOLD = Number(process.env.SAFE_THRESHOLD || 70);
  const safe = score >= SAFE_THRESHOLD;

  details.rpcUsed = activeRpcUrl; // after any failovers
  return { safe, score, reasons, details };
}

// ---------------- Helper Functions ----------------
// Extract mint authorities from parsed info
function extractMintAuthorities(parsedValue) {
  const info = parsedValue?.data?.parsed?.info || {};
  const mintAuthority = nullIfSystem111(info?.mintAuthority ?? null);
  const freezeAuthority = nullIfSystem111(info?.freezeAuthority ?? null);
  const decimals = Number(info?.decimals ?? NaN);
  const isInitialized = info?.isInitialized === true || info?.isInitialized === "true";
  
  return { mintAuthority, freezeAuthority, decimals, isInitialized, parsedInfo: info };
}

// Helper function to check if the value is the system-defined "11111111111111111111111111111111"
function nullIfSystem111(v) {
  if (!v) return null;
  if (v === "11111111111111111111111111111111") return null;
  return v;
}