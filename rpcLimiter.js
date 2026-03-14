// rpcLimiter.js
import PQueue from "p-queue";

export const rpcQueue = new PQueue({
  concurrency: Number(process.env.RPC_CONCURRENCY || 5),
  intervalCap: Number(process.env.RPC_INTERVAL_CAP || 25),
  interval: Number(process.env.RPC_INTERVAL_MS || 1000)
});

export async function withRpcLimit(fn) {
  return rpcQueue.add(fn);
}