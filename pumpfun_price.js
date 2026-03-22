import { Connection, PublicKey } from "@solana/web3.js";
import { resolvePumpSwapPool } from "./poolResolver.js";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const connection = new Connection(SOLANA_RPC_URL, "confirmed");

const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

export function decodePumpBondingCurve(data) {
  if (!Buffer.isBuffer(data)) {
    throw new Error("decodePumpBondingCurve: data must be a Buffer");
  }

  if (data.length < 49) {
    throw new Error(`decodePumpBondingCurve: account too small (${data.length} bytes)`);
  }

  let offset = 0;

  const readU64 = () => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };

  const discriminator = readU64();
  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = data.readUInt8(offset) !== 0;

  return {
    discriminator,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

// You must fill this with your real PumpSwap pool layout
export function decodePumpSwapPool(data) {
  if (!Buffer.isBuffer(data)) {
    throw new Error("decodePumpSwapPool: data must be a Buffer");
  }

  // replace these offsets with your actual pool layout
  const baseReserveOffset = 0;
  const quoteReserveOffset = 8;

  const baseReserve = data.readBigUInt64LE(baseReserveOffset);
  const quoteReserve = data.readBigUInt64LE(quoteReserveOffset);

  return {
    baseReserve,
    quoteReserve,
  };
}

export async function getPumpFunPriceOnce(mint) {
  const mintPk = new PublicKey(mint);

  const [bondingCurvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPk.toBuffer()],
    PUMP_PROGRAM_ID
  );

  const curveAcc = await connection.getAccountInfo(bondingCurvePda);

  if (curveAcc) {
    const curve = decodePumpBondingCurve(curveAcc.data);

    if (!curve.complete) {
      if (curve.virtualTokenReserves === 0n) return null;

      const priceSol =
        (Number(curve.virtualSolReserves) / 1e9) /
        (Number(curve.virtualTokenReserves) / 1e6);

      return {
        source: "pumpfun_curve",
        migrated: false,
        priceSol,
      };
    }
  }

  const poolPk = await resolvePumpSwapPool(mintPk);
  if (!poolPk) return null;

  const poolAcc = await connection.getAccountInfo(poolPk);
  if (!poolAcc) return null;

  const pool = decodePumpSwapPool(poolAcc.data);

  if (pool.baseReserve === 0n) return null;

  const priceSol =
    (Number(pool.quoteReserve) / 1e9) /
    (Number(pool.baseReserve) / 1e6);

  return {
    source: "pumpswap_pool",
    migrated: true,
    priceSol,
    pool: poolPk.toBase58(),
  };
}