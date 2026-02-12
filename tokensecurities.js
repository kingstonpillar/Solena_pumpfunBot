import dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getCanonicalMint } from "./canonical_mint.js";
import PQueue from 'p-queue'; // Import PQueue for rate limiting
import { Top10PCT } from './heliusTop10.js';  // Import Top10PCT to calculate top 10 percentage

// ---------------- Define pickRpcCandidates() ----------------
function pickRpcCandidates() {
  return [process.env.RPC_URL_3, process.env.RPC_URL_4].filter(Boolean); // Choose which RPC URLs to use
}

// ---------------- RPC SETUP ----------------
const RPC_ENDPOINTS = pickRpcCandidates(); // Use pickRpcCandidates to get the RPCs
if (!RPC_ENDPOINTS.length) throw new Error("Missing RPC_URL_3 / RPC_URL_4 in env");

const COMMITMENT = process.env.COMMITMENT || "confirmed";

// Active connection using the first RPC URL from pickRpcCandidates
let activeRpcUrl = RPC_ENDPOINTS[0];
let conn = new Connection(activeRpcUrl, { commitment: COMMITMENT });

// ---------------- PQueue for Rate Limiting ----------------
const queue = new PQueue({ concurrency: 5 }); // Set max concurrency for requests (e.g., 5 concurrent requests)

// ---------------- Timeout Handling ----------------
const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms));

// ---------------- Delay function to implement interval ----------------
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));  // Delay function

// ---------------- Classic SPL token account layout ----------------
function readTokenAccountOwnerFromRaw(accInfo) {
  const d = accInfo?.data;
  if (!d || typeof d?.subarray !== "function" || d.length < 64) return null;
  return new PublicKey(d.subarray(32, 64)).toBase58();
}

// ---------------- Core reads ----------------
async function getMintParsedAndRaw(mintPub) {
  let lastErr = null;

  for (const url of pickRpcCandidates()) {  // Here we are using pickRpcCandidates()
    if (activeRpcUrl !== url) switchRpc(url);

    try {
      // Queue the Solana RPC calls with PQueue for rate-limiting
      const [raw, parsedResp] = await queue.add(async () => {
        // Add timeout handling for RPC calls
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout

        try {
          const [raw, parsedResp] = await Promise.all([
            conn.getAccountInfo(mintPub, { commitment: COMMITMENT, signal: controller.signal }),  // RPC request 1
            conn.getParsedAccountInfo(mintPub, { commitment: COMMITMENT, signal: controller.signal })  // RPC request 2
          ]);

          clearTimeout(timeoutId); // Clear the timeout once the request completes
          return [raw, parsedResp];
        } catch (e) {
          clearTimeout(timeoutId); // Clear the timeout in case of error
          throw e;
        }
      });

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

  const risky = exts.some(ext => {
    if (typeof ext === "string") {
      return riskyExtensions.some(risk => ext.toLowerCase().includes(risk));
    }
    return false; // If it's not a string, return false
  });

  return { risky, extensions: exts };
}

// ---------------- FINAL Function to get Top 10 and Calculate Pct ----------------

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
  
  
// Get Top 10 Data from Helius for both token types
if (t10?.pct == null) {
  // If pct is null, just skip it or handle as needed
  reasons.push("top10_pct_unknown");
  details.distribution = { reason: "pct_unknown" };
} else {
  // Log the actual top10 percentage for debugging
  console.log('Top 10 percentage calculated:', t10.pct);

  details.distribution = { top10Pct: t10.pct, reason: t10.reason };

  // Check if top 10 percentage exceeds the threshold
  if (t10.pct > 0.27) { // MAX top 10 percent threshold
    // If the percentage exceeds 27%, it's considered unsafe
    details.rpcUsed = activeRpcUrl; // after failovers
    return {
      safe: false,
      score: 0,
      reasons: [
        `top10_exceeds_threshold_${t10.pct.toFixed(2)}_gt_0.27`,
      ],
      details,
    };
  }

  // If it's within the safe range, increment the score
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