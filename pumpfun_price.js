import { Connection, PublicKey } from "@solana/web3.js";
import { PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { resolvePumpSwapPool } from "./poolresolver.js";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const pumpAmmSdk = new PumpAmmSdk(connection);

const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

export function decodePumpBondingCurve(data) {
  if (!Buffer.isBuffer(data)) {
    throw new Error("decodePumpBondingCurve: data must be a Buffer");
  }

  if (data.length < 49) {
    throw new Error(
      `decodePumpBondingCurve: account too small (${data.length} bytes)`
    );
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

export function calcPumpCurvePriceSol(curve, tokenDecimals = 6) {
  if (!curve) return null;
  if (curve.virtualTokenReserves === 0n) return null;
  if (curve.virtualSolReserves === 0n) return null;

  return (
    (Number(curve.virtualSolReserves) / 1e9) /
    (Number(curve.virtualTokenReserves) / 10 ** tokenDecimals)
  );
}

export async function calcPumpSwapPriceFromVaults(poolPk) {
  const poolData = await pumpAmmSdk.fetchPool(poolPk);

  const [baseBal, quoteBal] = await Promise.all([
    connection.getTokenAccountBalance(poolData.poolBaseTokenAccount),
    connection.getTokenAccountBalance(poolData.poolQuoteTokenAccount),
  ]);

  const baseAmount = Number(baseBal.value.amount);
  const quoteAmount = Number(quoteBal.value.amount);
  const baseDecimals = baseBal.value.decimals;
  const quoteDecimals = quoteBal.value.decimals;

  if (!baseAmount || !quoteAmount) return null;

  const priceInQuote =
    (quoteAmount / 10 ** quoteDecimals) /
    (baseAmount / 10 ** baseDecimals);

  return {
    priceInQuote,
    baseAmountRaw: baseAmount,
    quoteAmountRaw: quoteAmount,
    baseDecimals,
    quoteDecimals,
    poolData,
  };
}

export async function getPumpFunPriceOnce(mint) {
  const mintPk =
    mint instanceof PublicKey ? mint : new PublicKey(String(mint).trim());

  const [bondingCurvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPk.toBuffer()],
    PUMP_PROGRAM_ID
  );

  const curveAcc = await connection.getAccountInfo(bondingCurvePda);

  if (curveAcc) {
    const curve = decodePumpBondingCurve(curveAcc.data);

    if (!curve.complete) {
      const priceSol = calcPumpCurvePriceSol(curve, 6);

      return {
        source: "pumpfun_curve",
        migrated: false,
        priceSol,
        curve,
      };
    }
  }

  const poolPk = await resolvePumpSwapPool(mintPk);
  if (!poolPk) {
    throw new Error("Migrated token but PumpSwap pool was not resolved");
  }

  const amm = await calcPumpSwapPriceFromVaults(poolPk);
  if (!amm) {
    throw new Error("Failed to calculate PumpSwap price from pool vaults");
  }

  return {
    source: "pumpswap_pool",
    migrated: true,
    priceSol: amm.priceInQuote, // assumes quote side is WSOL/SOL
    pool: poolPk.toBase58(),
    baseVault: amm.poolData.poolBaseTokenAccount.toBase58(),
    quoteVault: amm.poolData.poolQuoteTokenAccount.toBase58(),
    reserves: {
      baseAmountRaw: amm.baseAmountRaw,
      quoteAmountRaw: amm.quoteAmountRaw,
      baseDecimals: amm.baseDecimals,
      quoteDecimals: amm.quoteDecimals,
    },
  };
}