import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import fs from "fs";
import crypto from "crypto";
import bs58 from "bs58";
import dotenv from "dotenv";
import PQueue from "p-queue";
import { PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { getPumpFunPriceOnce } from './pumpfun_price.js';
import BN from "bn.js";

dotenv.config();

const ACTIVE_POSITIONS_FILE =
  process.env.ACTIVE_POSITIONS_FILE || "./active_positions.json";

// ---------------- RPC ----------------
const SIGNER_URL_1 = process.env.SIGNER_URL_1;
const SIGNER_URL_2 = process.env.SIGNER_URL_2;
if (!SIGNER_URL_1 || !SIGNER_URL_2) throw new Error("Missing RPC URLs");

let activeRpcUrl = SIGNER_URL_1;
let connection = new Connection(activeRpcUrl, "confirmed");

const rpcQueue = new PQueue({
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 8),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000),
  carryoverConcurrencyCount: true,
});

function switchRpc(url) {
  activeRpcUrl = url;
  connection = new Connection(activeRpcUrl, "confirmed");
}

function isRetryableRpcError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up")
  );
}

async function withRpcFailover(opName, fn) {
  const urls = [SIGNER_URL_1, SIGNER_URL_2];
  let lastErr = null;
  for (const url of urls) {
    if (activeRpcUrl !== url) switchRpc(url);
    try {
      return await rpcQueue.add(() => fn(connection));
    } catch (e) {
      lastErr = e;
      if (!isRetryableRpcError(e)) break;
    }
  }
  throw new Error(`[RPC_FAILOVER] ${opName} failed. Last: ${String(lastErr?.message || lastErr)}`);
}

// ---------------- WALLET ----------------
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
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in .env");
  const passphrase = fs.readFileSync(process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass", "utf8").trim();
  return Keypair.fromSecretKey(bs58.decode(decryptPrivateKey(encrypted, passphrase)));
}

// ---------------- TX ----------------
async function sendV0Tx(instructions, signers) {
  return withRpcFailover("sendV0Tx", async (conn) => {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign(signers);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  });
}

// ---------------- ATA HELPER ----------------
export async function getOrCreateATAIx(connection, walletPubkey, mintPubkey) {
  const mintInfo = await connection.getAccountInfo(mintPubkey, "confirmed");
  if (!mintInfo) throw new Error(`❌ Mint account not found: ${mintPubkey.toBase58()}`);

  let tokenProgramId;
  if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    tokenProgramId = TOKEN_2022_PROGRAM_ID;
    console.log("🧾 Mint uses Token-2022 program");
  } else if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    tokenProgramId = TOKEN_PROGRAM_ID;
    console.log("🧾 Mint uses standard SPL Token program");
  } else throw new Error(`❌ Unknown mint owner: ${mintInfo.owner.toBase58()}`);

  const ata = await getAssociatedTokenAddress(
    mintPubkey,
    walletPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log(`🧾 Derived ATA: ${ata.toBase58()}`);
  const ataInfo = await connection.getAccountInfo(ata, "confirmed");

  let ataIx = null;
  if (!ataInfo) {
    console.log(`🧾 ATA missing. Will create: ${ata.toBase58()} (tokenProgram=${tokenProgramId.toBase58()})`);
    ataIx = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: walletPubkey, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: walletPubkey, isSigner: false, isWritable: false },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]) // CreateIdempotent
    });
  } else {
    console.log(`✅ ATA already exists: ${ata.toBase58()}`);
  }

  return { ata, tokenProgramId, ix: ataIx, created: !!ataIx };
}

// ---------------- ACTIVE POSITIONS ----------------
function addActivePosition(position) {
  const positions = loadActivePositions();
  positions.push(position);
  atomicWrite(ACTIVE_POSITIONS_FILE, positions);
  return positions.length;
}

function loadActivePositions() {
  return safeReadJson(ACTIVE_POSITIONS_FILE, []);
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

// ---------------- AMM MIGRATION BUY ----------------
// ---------------- AMM MIGRATION BUY ----------------
export async function executeAmmMigrationBuy({
  ammPoolPublicKey,
  mint,
  amountRaw,          // raw token units or SOL to spend
  slippageFrac = 0.005 // default 0.5%
}) {
  if (!ammPoolPublicKey || !mint || !amountRaw)
    throw new Error("Missing required params for AMM migration buy");

  const wallet = getWallet();
  const poolPk = ammPoolPublicKey instanceof PublicKey ? ammPoolPublicKey : new PublicKey(ammPoolPublicKey);
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);

  return withRpcFailover("executeAmmMigrationBuy", async (conn) => {
    const ammSdk = new PumpAmmSdk({ connection: conn });

    // ------------------ ENSURE WALLET ATA ------------------
    const { ata, ix: createAtaIx } = await getOrCreateATAIx(conn, wallet.publicKey, mintPk);
    if (createAtaIx) {
      console.log("✅ Creating USER ATA in dedicated transaction");
      await sendV0Tx(
        [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
          createAtaIx,
        ],
        [wallet]
      );
    } else {
      console.log(`✅ Using existing USER ATA ${ata.toBase58()}`);
    }

    // ------------------ PRICE CALCULATION ------------------
    const priceRes = await getPumpFunPriceOnce({ mint: mintPk }).catch((e) => ({
      priceSOL: null,
      source: "pumpfun_price_error",
      error: String(e?.message || e),
    }));

    const buyPriceSOL = Number(priceRes?.priceSOL);
    if (!Number.isFinite(buyPriceSOL) || buyPriceSOL <= 0) {
      throw new Error("❌ Failed to get valid price for Pumpfun token");
    }

    // Convert SOL to raw token amount
    const solToSpend = Number(process.env.SOL_TO_SPEND || "0.01");
    const solAmountLamports = BigInt(Math.floor(solToSpend * 1e9));
    const solAmountBN = new BN(solAmountLamports.toString());

    // Fetch global & feeConfig for conversion
    const onlineSdk = new OnlinePumpSdk(conn);
    const global = await onlineSdk.fetchGlobal();
    const feeConfig = await onlineSdk.fetchFeeConfig();

    const tokenOut = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: solAmountLamports, // placeholder, AMM does not use bonding curve
      bondingCurve: null,
      amount: solAmountBN,
      isNewBondingCurve: true,
    });

    console.log(
      `AMM Migration | SOL in: ${solAmountLamports} lamports | tokenOut(raw): ${tokenOut.toString()} | priceSOL: ${buyPriceSOL}`
    );

    // ------------------ AMM BUY ------------------
    const swapState = await ammSdk.swapSolanaState(poolPk, ata);
    const { instructions } = await ammSdk.buyBaseInput(swapState, BigInt(tokenOut.toString()), slippageFrac);
    if (!instructions || !instructions.length) throw new Error("AMM buy returned empty instructions");

    const signature = await sendV0Tx(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ...instructions,
      ],
      [wallet]
    );

    console.log(`✅ AMM Migration Buy confirmed: https://solscan.io/tx/${signature}`);

    // ------------------ SAVE POSITION ------------------
    const position = {
      pool: poolPk.toBase58(),
      mint: mintPk.toBase58(),
      tokenAccount: ata.toBase58(), // Use the auto-created wallet ATA
      amountRaw: tokenOut.toString(),
      buyPriceSOL,
      signature,
      dateAdded: new Date().toISOString(),
    };

    addActivePosition(position);

    return position;
  });
}