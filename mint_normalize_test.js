// mint_normalize_test.js
import { PublicKey } from "@solana/web3.js";

function resolveMintStrict(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("mint missing");
  return new PublicKey(raw).toBase58();
}

function normalizeMint(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("mint missing");

  try {
    return { ok: true, out: new PublicKey(s).toBase58(), mode: "as_is" };
  } catch {}

  if (s.toLowerCase().endsWith("pump")) {
    const stripped = s.slice(0, -4).trim();
    return { ok: true, out: new PublicKey(stripped).toBase58(), mode: "stripped_suffix" };
  }

  throw new Error("invalid");
}

const samples = process.argv.slice(2);
for (const x of samples) {
  const row = { input: x };

  try {
    row.strict = resolveMintStrict(x);
  } catch (e) {
    row.strict = `ERR:${String(e.message || e)}`;
  }

  try {
    const n = normalizeMint(x);
    row.normalized = `${n.out} (${n.mode})`;
  } catch (e) {
    row.normalized = `ERR:${String(e.message || e)}`;
  }

  console.log(row);
}