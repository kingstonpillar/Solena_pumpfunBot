// deep-buy-solana-bot-pumpswap-final.js
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { checkTokenSecurity } from "./tokensecurities.js";
import { checkToken2022ExtensionsSafety } from "./token2022ExtensionsGate.js";
import { executeAmmMigrationBuy } from "./swapexecutorAMM_pumpswap.js";
import { withRpcLimit } from "./rpcLimiter.js";
import { withHttpLimit } from "./httpLimiter.js";

dotenv.config();

const State = {
  FETCH_MARKET_DATA: "FETCH_MARKET_DATA",
  CHECK_ATH_MARKETCAP: "CHECK_ATH_MARKETCAP",
  CHECK_RETRACEMENT: "CHECK_RETRACEMENT",
  CHECK_RETEST: "CHECK_RETEST",
  CHECK_DEEP_BUY: "CHECK_DEEP_BUY",
  CHECK_LIQUIDITY: "CHECK_LIQUIDITY",
  CHECK_MIGRATION_AGE: "CHECK_MIGRATION_AGE",
  CHECK_RSI: "CHECK_RSI",
  TRIGGER_BUY: "TRIGGER_BUY"
};

// ------------------ TELEGRAM ALERT INLINE ------------------
async function sendTelegram(message) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[TELEGRAM_SKIPPED] Missing token or chat ID");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log("[TELEGRAM_FAIL] Status:", res.status, text);
      return;
    }

    console.log("[TELEGRAM_SENT]", message);
  } catch (err) {
    console.log("[TELEGRAM_ERROR]", err.message);
  }
}


export class SolanaDeepBuyBot {
  constructor(tokenMint) {
    this.connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
    this.tokenMint = tokenMint;
    this.currentState = State.FETCH_MARKET_DATA;

    this.config = {
      minAthMarketCapUsd: 50000,
      minRetracementPct: 60,
      minLiquidityUsd: 15000,
      maxMigrationAgeHours: 24,

      maxSignaturesToScan: 20,

      whaleBuyUsd: 200,
      minUniqueBuyers: 2,
      minTotalBuyUsd: 5000,
      minWhaleCount: 1,

      pollIntervalMs: 7000,

      minRetests: 2,

      rsiPeriod: 14,
      rsiOversold: 30,
      rsiBuyMin: 30,
      rsiBuyMax: 50
    };

    this.market = null;
    this.pairAddress = null;
    this.hasBought = false;
    this.isBlocked = false;
    this.athMarketCap = 0;
    this.currentMarketCap = 0;
    this.retracementPct = 0;

    this.deepBuySummary = null;

    this.retestHistory = [];
    this.rsiHistory = [];
    this.wasOversold = false;
    this.lastRSI = null;
  }

  async tickAndReturn() {
    const tickResult = await this.tick();

    return {
      ok: tickResult.ok,
      mint: this.tokenMint,
      state: this.currentState,
      hasBought: this.hasBought,
      isBlocked: this.isBlocked,
      marketCap: this.currentMarketCap,
      pairAddress: this.pairAddress,
      retracementPct: this.retracementPct,
      reason: !tickResult.ok
        ? "ERROR"
        : this.hasBought
        ? "BOUGHT"
        : this.isBlocked
        ? "BLOCKED"
        : "TRACKING",
      error: tickResult.error || null,
      time: Date.now()
    };
  }

  async tick() {
    try {
      switch (this.currentState) {
        case State.FETCH_MARKET_DATA:
          await this.fetchMarketData();
          break;

        case State.CHECK_ATH_MARKETCAP:
          this.checkAthMarketCap();
          break;

        case State.CHECK_RETRACEMENT:
          this.checkRetracement();
          break;

        case State.CHECK_RETEST:
          this.checkRetest();
          break;

        case State.CHECK_DEEP_BUY:
          await this.checkDeepBuy();
          break;

        case State.CHECK_LIQUIDITY:
          this.checkLiquidity();
          break;

        case State.CHECK_MIGRATION_AGE:
          this.checkMigrationAge();
          break;

        case State.CHECK_RSI:
          this.checkRSI();
          break;

        case State.TRIGGER_BUY:
          await this.triggerBuy();
          break;

        default:
          this.reset();
      }

      return { ok: true };
    } catch (err) {
      console.error("Tick error:", err.message);
      this.reset();
      return { ok: false, error: err.message };
    }
  }

  reset() {
    this.currentState = State.FETCH_MARKET_DATA;

    this.market = null;
    this.pairAddress = null;

    this.currentMarketCap = 0;
    this.retracementPct = 0;

    this.deepBuySummary = null;

    this.retestHistory = [];
    this.wasOversold = false;
    this.lastRSI = null;
  }

  async fetchMarketData() {
    const pair = await this.fetchDexScreenerPair(this.tokenMint);

    if (!pair) {
      console.log("No PumpSwap pair found.");
      return;
    }

    this.market = this.normalizePair(pair);
    this.pairAddress = this.market.pairAddress;

    const currentMc = Number(this.market.marketCapUsd);
    const price = Number(this.market.raw?.priceUsd || 0);

    if (currentMc > this.athMarketCap) {
      this.athMarketCap = currentMc;
    }

    this.currentMarketCap = currentMc;

    this.rsiHistory.push(price);

    if (this.rsiHistory.length > 100) {
      this.rsiHistory.shift();
    }

    console.log({
      marketCap: this.currentMarketCap,
      ath: this.athMarketCap,
      liquidity: this.market.liquidityUsd,
      migrationAge: this.market.migrationAgeHours
    });

    this.currentState = State.CHECK_ATH_MARKETCAP;
  }

  checkAthMarketCap() {
    if (this.athMarketCap <= this.config.minAthMarketCapUsd) {
      console.log("ATH below 50k");
      return this.reset();
    }

    this.currentState = State.CHECK_RETRACEMENT;
  }

  checkRetracement() {
    this.retracementPct =
      ((this.athMarketCap - this.currentMarketCap) / this.athMarketCap) * 100;

    console.log("Retracement:", this.retracementPct);

    if (this.retracementPct < this.config.minRetracementPct) {
      this.retestHistory = [];
      return this.reset();
    }

    this.retestHistory.push(this.currentMarketCap);
    this.currentState = State.CHECK_RETEST;
  }

  checkRetest() {
    const touches = [...new Set(this.retestHistory.map(v => Math.round(v)))];

    if (touches.length < this.config.minRetests) {
      console.log("Waiting retest:", touches.length);
      return;
    }

    this.currentState = State.CHECK_DEEP_BUY;
  }

  async runSecurityChecks() {
    const security = await checkTokenSecurity(this.tokenMint);

    if (!security?.safe) {
      return {
        secure: false,
        issues: security?.reasons || ["Token security failed"],
        details: security || null
      };
    }

    const ownerProgram = security?.details?.owner || null;
    const isToken2022 =
      ownerProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

    if (isToken2022) {
      const extGate = await checkToken2022ExtensionsSafety(
        this.connection,
        this.tokenMint
      );

      if (!extGate?.ok) {
        return {
          secure: false,
          issues: [extGate.reason || "Token-2022 extension gate failed"],
          details: {
            security,
            token2022: extGate
          }
        };
      }

      return {
        secure: true,
        issues: [],
        details: {
          security,
          token2022: extGate
        }
      };
    }

    return {
      secure: true,
      issues: [],
      details: {
        security
      }
    };
  }
  

  async checkDeepBuy() {
    this.deepBuySummary = await this.computeDeepBuySummary();

    const ok =
      this.deepBuySummary.uniqueBuyers >= this.config.minUniqueBuyers &&
      this.deepBuySummary.totalBuyUsd >= this.config.minTotalBuyUsd &&
      this.deepBuySummary.whaleCount >= this.config.minWhaleCount;

    if (!ok) {
      console.log("Deep buy not detected");
      return this.reset();
    }

    this.currentState = State.CHECK_LIQUIDITY;
  }

  checkLiquidity() {
    if (this.market.liquidityUsd < this.config.minLiquidityUsd) {
      console.log("Liquidity below 15k");
      return this.reset();
    }

    this.currentState = State.CHECK_MIGRATION_AGE;
  }

  checkMigrationAge() {
    if (this.market.migrationAgeHours > this.config.maxMigrationAgeHours) {
      console.log("Migration age above 24h");
      return this.reset();
    }

    this.currentState = State.CHECK_RSI;
  }

  computeRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
      const delta = prices[i + 1] - prices[i];

      if (delta > 0) gains += delta;
      else losses -= delta;
    }

    if (losses === 0) return 100;

    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  checkRSI() {
    const rsi = this.computeRSI(this.rsiHistory, this.config.rsiPeriod);

    console.log("RSI:", rsi);

    if (rsi === null) {
      console.log("RSI not ready");
      return;
    }

    if (rsi < this.config.rsiOversold) {
      this.wasOversold = true;
      this.lastRSI = rsi;
      console.log("RSI entered oversold zone");
      return;
    }

    const crossedAboveBuyMin =
      this.wasOversold &&
      this.lastRSI !== null &&
      this.lastRSI < this.config.rsiBuyMin &&
      rsi >= this.config.rsiBuyMin;

    this.lastRSI = rsi;

    if (!crossedAboveBuyMin) {
      console.log("RSI has not crossed into buy zone yet");
      return;
    }

    if (rsi > this.config.rsiBuyMax) {
      console.log("RSI crossed too high, above buy zone");
      this.wasOversold = false;
      return this.reset();
    }

    console.log("RSI crossed into buy zone");
    this.wasOversold = false;
    this.currentState = State.TRIGGER_BUY;
  }

  async triggerBuy() {
  if (this.market.dexId !== "pumpswap") {
    console.log("Liquidity not on PumpSwap");
    return this.reset();
  }

  const signal = {
    time: new Date().toISOString(),
    tokenMint: this.tokenMint,
    pairAddress: this.pairAddress,
    dexId: "pumpswap",
    athMarketCapUsd: this.athMarketCap,
    currentMarketCapUsd: this.currentMarketCap,
    retracementPct: this.retracementPct,
    liquidityUsd: this.market.liquidityUsd,
    migrationAgeHours: this.market.migrationAgeHours,
    deepBuySummary: this.deepBuySummary,
    rsi: this.computeRSI(this.rsiHistory, this.config.rsiPeriod)
  };

  const securityCheck = await this.runSecurityChecks();

  if (!securityCheck.secure) {
    console.log("Security failed:", securityCheck.issues);
    this.isBlocked = true;
    return this.reset();
  }

  signal.securityCheck = securityCheck;

  console.log("PumpSwap buy signal", signal);

  // --- MAX_ENTRY check ---
  const { reached, currentCount, maxEntry } = ensureEntryCapacity();
  if (reached) {
    console.log(`[BLOCKED] Max positions reached: ${currentCount}/${maxEntry}`);
    await sendTelegram(`⚠️ Cannot buy ${this.tokenMint}: max positions reached (${currentCount}/${maxEntry})`);
    return this.reset(); // stop buy
  }

  try {
    await executeAmmMigrationBuy({
      mint: signal.tokenMint,
      slippageFrac: Number(process.env.SLIPPAGE_FRAC || 0.005)
    });

    console.log("Buy executed PumpSwap");
    this.hasBought = true;
  } catch (err) {
    console.error("Buy failed:", err.message);
  }

  fs.appendFileSync("buy_signals.log", JSON.stringify(signal) + "\n");

  this.reset();
}

  normalizePair(pair) {
    const marketCapUsd = Number(pair.marketCap || 0);
    const liquidityUsd = Number(pair.liquidity?.usd || 0);
    const pairCreatedAt = Number(pair.pairCreatedAt || 0);

    const migrationAgeHours = pairCreatedAt
      ? (Date.now() - pairCreatedAt) / (1000 * 60 * 60)
      : Infinity;

    return {
      pairAddress: pair.pairAddress,
      dexId: (pair.dexId || "").toLowerCase(),
      marketCapUsd,
      liquidityUsd,
      migrationAgeHours,
      pairCreatedAt,
      raw: pair
    };
  }

  async fetchDexScreenerPair(tokenMint) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;

      const { data } = await withHttpLimit(() =>
        axios.get(url, { timeout: 10000 })
      );

      if (!data?.pairs?.length) return null;

      const pumpPairs = data.pairs.filter(
        p =>
          p.chainId === "solana" &&
          String(p.dexId || "").toLowerCase() === "pumpswap"
      );

      if (!pumpPairs.length) return null;

      pumpPairs.sort(
        (a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)
      );

      return pumpPairs[0];
    } catch (err) {
      console.error("DexScreener error:", err.message);
      return null;
    }
  }

  async computeDeepBuySummary() {
    if (!this.pairAddress) {
      return { uniqueBuyers: 0, totalBuyUsd: 0, whaleCount: 0, whales: [] };
    }

    const sigs = await withRpcLimit(() =>
      this.connection.getSignaturesForAddress(
        new PublicKey(this.pairAddress),
        { limit: this.config.maxSignaturesToScan }
      )
    );

    const buyers = new Map();

    const txResults = await Promise.allSettled(
      sigs.map((sigInfo) =>
        withRpcLimit(() =>
          this.connection.getParsedTransaction(
            sigInfo.signature,
            { maxSupportedTransactionVersion: 0 }
          )
        )
      )
    );

    for (const row of txResults) {
      if (row.status !== "fulfilled") continue;

      const tx = row.value;
      if (!tx || !tx.meta) continue;

      const parsed = this.extractBuyFromParsedTx(tx);
      if (!parsed) continue;

      const prev = buyers.get(parsed.wallet) || { totalUsd: 0, buys: 0 };
      prev.totalUsd += parsed.usdValue;
      prev.buys++;

      buyers.set(parsed.wallet, prev);
    }

    const whales = [];
    let totalBuyUsd = 0;

    for (const [wallet, data] of buyers.entries()) {
      totalBuyUsd += data.totalUsd;

      if (data.totalUsd >= this.config.whaleBuyUsd) {
        whales.push({ wallet, ...data });
      }
    }

    return {
      uniqueBuyers: buyers.size,
      totalBuyUsd,
      whaleCount: whales.length,
      whales
    };
  }

  extractBuyFromParsedTx(tx) {
    try {
      const accounts = tx.transaction.message.accountKeys || [];
      const signer = accounts.find(a => a.signer)?.pubkey?.toBase58?.();

      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];

      let delta = 0;

      for (const p of post) {
        if (p.mint !== this.tokenMint) continue;

        const before = pre.find(x => x.accountIndex === p.accountIndex);

        const preAmt = Number(before?.uiTokenAmount?.uiAmount || 0);
        const postAmt = Number(p?.uiTokenAmount?.uiAmount || 0);

        delta += postAmt - preAmt;
      }

      if (delta <= 0) return null;

      const priceUsd = Number(this.market?.raw?.priceUsd || 0);

      return {
        wallet: signer,
        tokenAmount: delta,
        usdValue: delta * priceUsd
      };
    } catch {
      return null;
    }
  }
}