// canonical_mint.js
import { PublicKey } from "@solana/web3.js";
import { resolveMintOnChain, stripPumpSuffix, b58Len } from "./mint_resolver.js";

function is32BytesBase58Mint(s) {
  const stripped = stripPumpSuffix(String(s || "").trim());
  const len = b58Len(stripped);
  return { stripped, ok: len === 32, len };
}

export async function getCanonicalMint(input, commitment = "confirmed") {
  // call resolver using the 2-arg signature
  const resolved = await resolveMintOnChain(input, commitment).catch((e) => ({
    ok: false,
    kind: "resolver_throw",
    reason: String(e?.message || e),
    input,
  }));

  if (!resolved?.ok || !resolved?.mint) {
    return {
      ok: false,
      error: "unresolved_mint_identifier",
      input,
      resolver: resolved,
    };
  }

  const { stripped: mint, ok, len } = is32BytesBase58Mint(resolved.mint);

  if (!ok) {
    return {
      ok: false,
      error: "resolved_not_32_bytes",
      input,
      mint,
      len,
      resolver: resolved,
    };
  }

  try {
    // final sanity check
    new PublicKey(mint);
  } catch {
    return {
      ok: false,
      error: "resolved_invalid_pubkey",
      input,
      mint,
      resolver: resolved,
    };
  }

  return {
    ok: true,
    mint,
    resolver: resolved, // keep for debugging
  };
}