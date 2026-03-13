import {
  Connection,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import bs58 from "bs58";
import PQueue from "p-queue";
import BN from "bn.js";

import {
  OnlinePumpSdk,
  PUMP_SDK,
  canonicalPumpPoolPda,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import { PumpAmmSdk, OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";

const POOL_CACHE = new Map();

// ---------------- RPC FAILOVER + PQUEUE ----------------

const RPC_URL_5 = process.env.RPC_URL_5 || "";
const RPC_URL_6 = process.env.RPC_URL_6 || "";
const COMMITMENT = process.env.COMMITMENT || "confirmed";

const RPC_CANDIDATES = [...new Set([RPC_URL_5, RPC_URL_6].filter(Boolean))];
if (!RPC_CANDIDATES.length) throw new Error("RPC_URL_5 or RPC_URL_6 is required");

const rpcQueue = new PQueue({
  concurrency: Number(process.env.RPC_CONCURRENCY || 4),
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  const code = e?.code;
  return (
    code === 429 ||
    code === -32005 ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("service unavailable")
  );
}

async function withRpcFailover(opName, fn) {
  let lastErr = null;
  for (const url of RPC_CANDIDATES) {
    const conn = new Connection(url, COMMITMENT);
    try {
      return await fn(conn, url);
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }
  throw new Error(`[RPC_FAILOVER] ${opName} failed. last=${String(lastErr?.message || lastErr)}`);
}

function rpcLimited(opName, fn) {
  return rpcQueue.add(() => withRpcFailover(opName, fn));
}

// ---------------- DECRYPTION AND WALLET LOADING ----------------
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWallet() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("Passphrase file missing: " + passphrasePath);

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  const secret = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secret);
}

// ------------------ TELEGRAM NOTIFICATION ------------------
async function sendTelegram(message) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: String(message), disable_web_page_preview: true }),
    });
  } catch (error) {
    console.error("Error sending Telegram message:", error?.message || error);
  }
}

// ---------------- TX SENDERS ----------------
// ---------------- TX SENDERS ----------------
async function sendV0TxWithConn(conn, instructions, signers) {
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash(COMMITMENT);

  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign(signers);

  const sig = await conn.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    COMMITMENT
  );

  if (conf.value.err) {
    throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  }

  return sig;
}
// ---------------- RESOLVER ONCHAIN ----------------
async function resolvePumpSwapPoolByMintOnChain(conn, mintPk) {
  const mintKey = mintPk.toBase58();

  if (POOL_CACHE.has(mintKey)) {
    return POOL_CACHE.get(mintKey);
  }

  console.log(`🔎 Resolving PumpSwap pool on-chain for mint: ${mintKey}`);

  const onlineAmmSdk = new OnlinePumpAmmSdk(conn);

  // Fast deterministic canonical pool derivation
  const poolPk = canonicalPumpPoolPda(mintPk);

  // Validate that this pool actually exists on-chain
  const pool = await onlineAmmSdk.fetchPool(poolPk);
  if (!pool) {
    throw new Error(`Canonical PumpSwap pool not found on-chain for ${mintKey}`);
  }

  // Defensive check: canonical pool should use this mint as baseMint
  if (
    pool.baseMint &&
    typeof pool.baseMint.equals === "function" &&
    !pool.baseMint.equals(mintPk)
  ) {
    throw new Error(
      `Canonical pool baseMint mismatch for ${mintKey}: ${pool.baseMint.toBase58()}`
    );
  }

  console.log(`✅ Found PumpSwap pool on-chain: ${poolPk.toBase58()}`);

  POOL_CACHE.set(mintKey, poolPk);
  return poolPk;
}
// ---------------- RESOLVER OFFCHAIN ----------------
async function resolvePumpSwapPoolByMintViaDexScreener(mintPk) {
  const mintKey = mintPk.toBase58();

  if (POOL_CACHE.has(mintKey)) {
    return POOL_CACHE.get(mintKey);
  }

  console.log(`🔎 Resolving PumpSwap pool via DexScreener for mint: ${mintKey}`);

  const url = `https://api.dexscreener.com/latest/dex/tokens/${mintKey}`;
  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": process.env.HTTP_UA || "Solena_pumpfunBot/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`DexScreener lookup failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

  
const pumpSwapPair = pairs.find((p) =>
  p?.chainId === "solana" &&
  String(p?.dexId || "").toLowerCase() === "pumpswap" &&
  p?.pairAddress
);
  if (!pumpSwapPair) {
    throw new Error(`PumpSwap pool not found on DexScreener for ${mintKey}`);
  }

  const poolPk = new PublicKey(pumpSwapPair.pairAddress);

  console.log(`✅ Found PumpSwap pool via DexScreener: ${poolPk.toBase58()}`);

  POOL_CACHE.set(mintKey, poolPk);
  return poolPk;
}

async function tryResolvePumpSwapPoolByMint(conn, mintPk) {
  try {
    const poolPk = await resolvePumpSwapPoolByMintOnChain(conn, mintPk);
    return { poolPk, source: "onchain" };
  } catch (e) {
    console.log(
      `ℹ️ On-chain pool resolution not available yet for ${mintPk.toBase58()}: ${String(e?.message || e)}`
    );
  }

  try {
    const poolPk = await resolvePumpSwapPoolByMintViaDexScreener(mintPk);
    return { poolPk, source: "dexscreener" };
  } catch (e) {
    console.log(
      `ℹ️ Pool resolution not available yet for ${mintPk.toBase58()}: ${String(e?.message || e)}`
    );
    return { poolPk: null, source: null };
  }
}

// ---------------- PUMP CURVE SELL ----------------
async function buildCurveSellIxs({
  conn,
  mint,
  user,
  tokenAccount,
  slippageBps,
  amountRaw,
}) {
  const onlineSdk = new OnlinePumpSdk(conn);
  const global = await onlineSdk.fetchGlobal();

  const tokenAccPk =
    tokenAccount instanceof PublicKey ? tokenAccount : new PublicKey(tokenAccount);

  const storedAtaInfo = await conn.getAccountInfo(tokenAccPk, "confirmed");
  if (!storedAtaInfo) {
    throw new Error(`Stored token account does not exist on chain: ${tokenAccPk.toBase58()}`);
  }

  console.log("[CURVE_STORED_ATA_OK]", {
    tokenAccount: tokenAccPk.toBase58(),
    owner: storedAtaInfo.owner.toBase58(),
    dataLen: storedAtaInfo.data?.length || 0,
  });

  console.log("[CURVE_SELL_INPUT]", {
    mint: mint.toBase58(),
    user: user.toBase58(),
    tokenAccount: tokenAccPk.toBase58(),
    amountRaw: String(amountRaw),
  });

  let sellState;

  console.log("[CURVE_FETCH_SELLSTATE_START]", {
    mint: mint.toBase58(),
    user: user.toBase58(),
    tokenAccount: tokenAccPk.toBase58(),
  });

  if (typeof onlineSdk.fetchSellState === "function") {
    sellState = await onlineSdk.fetchSellState(mint, user, storedAtaInfo.owner);
  } else if (typeof onlineSdk.fetchBuyState === "function") {
    sellState = await onlineSdk.fetchBuyState(mint, user, storedAtaInfo.owner);
  } else {
    throw new Error("OnlinePumpSdk missing fetchSellState/fetchBuyState");
  }

  console.log("[CURVE_FETCH_SELLSTATE_OK]", {
    hasBondingCurveAccountInfo: !!sellState?.bondingCurveAccountInfo,
    hasBondingCurve: !!sellState?.bondingCurve,
    hasAssociatedUserAccountInfo: !!sellState?.associatedUserAccountInfo,
  });

  console.log("[CURVE_FETCH_SELLSTATE_ACCOUNTS]", {
    derivedHasAssociatedUserAccountInfo: !!sellState?.associatedUserAccountInfo,
  });

  const { bondingCurveAccountInfo, bondingCurve } = sellState;

  const quotedSolAmount = getSellSolAmountFromTokenAmount({
    global,
    bondingCurve,
    amount: new BN(String(amountRaw)),
  });

  console.log("[CURVE_SELL_QUOTE]", {
    mint: mint.toBase58(),
    amountRaw: String(amountRaw),
    quotedSolAmount: quotedSolAmount.toString(),
  });

  console.log("[CURVE_SELL_FINAL_INPUT]", {
    mint: mint.toBase58(),
    user: user.toBase58(),
    amountRaw: String(amountRaw),
    amountRawDigits: String(amountRaw).length,
    tokenProgram: storedAtaInfo.owner.toBase58(),
    quotedSolAmount: quotedSolAmount.toString(),
  });

  const sellIxs = await PUMP_SDK.sellInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint,
    user,
    amount: new BN(String(amountRaw)),
    solAmount: quotedSolAmount,
    slippage: Math.max(1, Math.floor(slippageBps / 100)),
    tokenProgram: storedAtaInfo.owner,
  });

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...sellIxs,
  ];
}

// ---------------- PUMP CURVE SELL Split----------------
export async function executeCurveSellWithSplit({
  conn,
  mintPk,
  user,
  tokenAccount,
  slippageBps,
  amountRaw,
  maxChunk = 50_000_000_000,
}) {
  let remaining = new BN(String(amountRaw));
  const results = [];

  while (remaining.gt(new BN(0))) {
    const chunk = BN.min(remaining, new BN(maxChunk));
    console.log(`[CURVE_SELL] Trying chunk=${chunk.toString()} remaining=${remaining.toString()} maxChunk=${String(maxChunk)}`);

    try {
      const ixs = await buildCurveSellIxs({
        conn,
        mint: mintPk,
        user: user.publicKey,
        tokenAccount,
        slippageBps,
        amountRaw: chunk,
      });

      const sig = await sendV0TxWithConn(conn, ixs, [user]);

      console.log(`[CURVE_SELL] Success chunk=${chunk.toString()} tx=${sig}`);
      results.push({ ok: true, chunk: chunk.toString(), signature: sig });

      remaining = remaining.sub(chunk);
    } catch (e) {
      const msg = String(e?.message || e);
      console.log(`[CURVE_SELL] Failed chunk=${chunk.toString()} error=${msg}`);

      const isOverflow =
        msg.includes("Overflow") ||
        msg.includes("0x1788") ||
        msg.includes("Error Code: Overflow");

      if (isOverflow && chunk.gt(new BN(1))) {
        const newChunk = chunk.div(new BN(2));
        maxChunk = newChunk.toNumber();
        console.log(`[CURVE_SELL] Splitting chunk into ${newChunk.toString()}`);
      } else {
        results.push({ ok: false, chunk: chunk.toString(), reason: msg });
        break;
      }
    }
  }

  return results;
}

// ---------------- AMM SELL Split----------------
export async function executeAmmSellWithSplit({
  conn,
  ammPool,
  user,
  userTokenAccount,
  amountRaw,
  maxChunk = 50_000_000_000,
  slippageFrac = 0.003,
}) {
  let remaining = new BN(String(amountRaw));
  const results = [];

  while (remaining.gt(new BN(0))) {
    const chunk = BN.min(remaining, new BN(maxChunk));
    console.log(`[AMM_SELL] Trying chunk=${chunk.toString()} remaining=${remaining.toString()} maxChunk=${String(maxChunk)}`);

    try {
      const swapState = await new OnlinePumpAmmSdk(conn).swapSolanaState(
        ammPool,
        user.publicKey,
        userTokenAccount,
        undefined
      );

      const instructions = await new PumpAmmSdk(conn).sellBaseInput(
        swapState,
        chunk,
        slippageFrac
      );

      if (!instructions?.length) {
        throw new Error("AMM sell build returned no instructions");
      }

      const sig = await sendV0TxWithConn(conn, instructions, [user]);

      console.log(`[AMM_SELL] Success chunk=${chunk.toString()} tx=${sig}`);
      results.push({ ok: true, chunk: chunk.toString(), signature: sig });

      remaining = remaining.sub(chunk);
    } catch (e) {
      const msg = String(e?.message || e);
      console.log(`[AMM_SELL] Failed chunk=${chunk.toString()} error=${msg}`);

      const isOverflow =
        msg.includes("Overflow") ||
        msg.includes("0x1788") ||
        msg.includes("Error Code: Overflow");

      if (isOverflow && chunk.gt(new BN(1))) {
        const newChunk = chunk.div(new BN(2));
        maxChunk = newChunk.toNumber();
        console.log(`[AMM_SELL] Splitting chunk into ${newChunk.toString()}`);
      } else {
        results.push({ ok: false, chunk: chunk.toString(), reason: msg });
        break;
      }
    }
  }

  return results;
}

// ------------------ AUTO SELL ----------------

export async function executeAutoSellPumpfun({
  mint,
  tokenAccount,
  amountRaw,
  slippageBps = 300,
  ammPoolPublicKey,
}) {
  if (!mint || !tokenAccount || !amountRaw) throw new Error("Missing required params");

  const wallet = getWallet();
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const tokenAccPk = tokenAccount instanceof PublicKey ? tokenAccount : new PublicKey(tokenAccount);

  console.log("[SELL_SIZE_DEBUG]", {
    mint: mintPk.toBase58(),
    tokenAccount: tokenAccPk.toBase58(),
    amountRaw: String(amountRaw),
    amountRawDigits: String(amountRaw).length,
  });

  return rpcLimited("autoSellPumpfun", async (conn) => {
    let poolPk = ammPoolPublicKey
      ? ammPoolPublicKey instanceof PublicKey
        ? ammPoolPublicKey
        : new PublicKey(ammPoolPublicKey)
      : null;

    // ---------------- AMM SELL ----------------
    if (poolPk) {
      try {
        const slippageFrac = Math.max(0.001, Number(slippageBps) / 10_000);

        const results = await executeAmmSellWithSplit({
          conn,
          ammPool: poolPk,
          user: wallet,
          userTokenAccount: tokenAccPk,
          amountRaw,
          slippageFrac,
        });

        if (results.every(r => r.ok)) {
          await sendTelegram(
            `✅ AutoSell Success (AMM)\nMint: ${mintPk.toBase58()}\nPool: ${poolPk.toBase58()}\nAmount(raw): ${amountRaw}\nTxs: ${results.map(r => r.signature).join(", ")}`
          );
          return { ok: true, mode: "amm", signatures: results.map(r => r.signature), pool: poolPk.toBase58() };
        } else {
          console.log("ℹ️ AMM sell partially failed, will try curve fallback.");
        }
      } catch (e) {
        console.log(`ℹ️ AMM sell failed, will try curve fallback: ${String(e?.message || e)}`);
      }
    }

    // ---------------- CURVE SELL ----------------
    let curveFailureReason = null;
    try {
      const results = await executeCurveSellWithSplit({
        conn,
        mintPk,
        user: wallet,
        tokenAccount: tokenAccPk,
        slippageBps,
        amountRaw,
      });

      if (results.every(r => r.ok)) {
        await sendTelegram(
          `✅ AutoSell Success (CURVE)\nMint: ${mintPk.toBase58()}\nAmount(raw): ${amountRaw}\nTxs: ${results.map(r => r.signature).join(", ")}`
        );
        return { ok: true, mode: "curve", signatures: results.map(r => r.signature), pool: null };
      } else {
        curveFailureReason = results.find(r => !r.ok)?.reason || "Unknown";
        console.log(`ℹ️ Curve sell partially failed: ${curveFailureReason}`);
      }
    } catch (curveErr) {
      curveFailureReason = String(curveErr?.message || curveErr);
      console.log(`ℹ️ Curve sell failed: ${curveFailureReason}`);
    }

    // ---------------- DYNAMIC AMM RESOLVE ----------------
    if (!poolPk) {
      const resolved = await tryResolvePumpSwapPoolByMint(conn, mintPk);
      poolPk = resolved.poolPk;

      if (poolPk) {
        console.log(`✅ Dynamically resolved PumpSwap pool (${resolved.source}): ${poolPk.toBase58()}`);

        try {
          const slippageFrac = Math.max(0.001, Number(slippageBps) / 10_000);

          const results = await executeAmmSellWithSplit({
            conn,
            ammPool: poolPk,
            user: wallet,
            userTokenAccount: tokenAccPk,
            amountRaw,
            slippageFrac,
          });

          if (results.every(r => r.ok)) {
            await sendTelegram(
              `✅ AutoSell Success (AMM_AFTER_RESOLVE)\nMint: ${mintPk.toBase58()}\nPool: ${poolPk.toBase58()}\nAmount(raw): ${amountRaw}\nTxs: ${results.map(r => r.signature).join(", ")}`
            );

            return { ok: true, mode: "amm", signatures: results.map(r => r.signature), pool: poolPk.toBase58() };
          } else {
            return { ok: false, retryable: true, mode: "amm_pending_or_failed", pool: poolPk.toBase58(), reason: results.find(r => !r.ok)?.reason || "Partial failure" };
          }
        } catch (ammErr) {
          const msg = String(ammErr?.message || ammErr);
          console.log(`ℹ️ AMM sell after resolve failed too: ${msg}`);
          return { ok: false, retryable: true, mode: "amm_pending_or_failed", pool: poolPk.toBase58(), reason: msg };
        }
      }
    }

    // ---------------- FINAL FAILURE ----------------
    return { ok: false, retryable: true, mode: poolPk ? "amm_pending_or_failed" : "curve_failed", pool: poolPk ? poolPk.toBase58() : null, reason: curveFailureReason || "Curve sell failed and no valid AMM fallback succeeded" };
  });
}