// httpLimiter.js
import PQueue from "p-queue";

export const httpQueue = new PQueue({
  concurrency: Number(process.env.HTTP_CONCURRENCY || 3),
  intervalCap: Number(process.env.HTTP_INTERVAL_CAP || 10),
  interval: Number(process.env.HTTP_INTERVAL_MS || 1000)
});

export async function withHttpLimit(fn) {
  return httpQueue.add(fn);
}