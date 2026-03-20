// token2022ExtensionsGate.js (ESM)
import { PublicKey, Connection } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { rpcQueue, withRpcLimit } from "./rpcLimiter.js";

const KNOWN = {
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "MetadataPointer",
  17: "TokenMetadata",
  18: "GroupPointer",
  19: "GroupMemberPointer",
};

// ---------------- TLV DECODING ----------------
function u16le(b, i) {
  if (i + 2 > b.length) return null;
  return b.readUInt16LE(i);
}

export function decodeToken2022TlvTypes(tlvData) {
  const buf = Buffer.from(tlvData || []);
  const rows = [];

  if (!buf.length) return rows;

  let off = 0;
  while (off + 4 <= buf.length) {
    const t = u16le(buf, off);
    const len = u16le(buf, off + 2);
    if (t === null || len === null) break;

    const start = off + 4;
    const end = start + len;

    if (end > buf.length) {
      rows.push({ type: t, name: KNOWN[t] || "Unknown", len, note: "truncated" });
      break;
    }

    rows.push({ type: t, name: KNOWN[t] || "Unknown", len });
    off = end;
  }

  return rows;
}

// ---------------- RPC FAILOVER ----------------
const RPC_URLS = [
  process.env.RPC_URL_17,
  process.env.RPC_URL_18
];

let rpcIndex = 0;
function getNextConnection() {
  const url = RPC_URLS[rpcIndex % RPC_URLS.length];
  rpcIndex++;
  return new Connection(url, { commitment: "confirmed" });
}

// ---------------- CHECK TOKEN 2022 EXTENSIONS ----------------
export async function checkToken2022ExtensionsSafety(mintStr, opts = {}) {
  const {
    denyTypes = [1, 6, 9, 12, 14],
    allowlistOnly = true,
    allowTypes = [16, 17, 18, 19],
    commitment = "confirmed",
  } = opts;

  let mintPk;
  try {
    mintPk = new PublicKey(mintStr);
  } catch {
    return { ok: false, reason: "invalid_pubkey", extensions: [] };
  }

  // ---------------- fetch mint with failover + limiter ----------------
  let mintInfo;
  try {
    mintInfo = await withRpcLimit(async () => {
      let lastErr;
      for (let i = 0; i < RPC_URLS.length; i++) {
        const conn = getNextConnection();
        try {
          return await getMint(conn, mintPk, commitment, TOKEN_2022_PROGRAM_ID);
        } catch (e) {
          lastErr = e;
          console.warn(`[RPC FAILOVER] ${conn.rpcEndpoint} failed: ${e.message}`);
        }
      }
      throw lastErr;
    });
  } catch (e) {
    return {
      ok: false,
      reason: `getMint_failed:${String(e?.message || e)}`,
      extensions: [],
    };
  }

  const extensions = decodeToken2022TlvTypes(mintInfo.tlvData);

  if (!extensions.length) return { ok: true, reason: "no_extensions", extensions };

  const deny = new Set(denyTypes);
  const allow = new Set(allowTypes);

  const denyHits = extensions.filter((x) => deny.has(x.type));
  if (denyHits.length) {
    return {
      ok: false,
      reason: `deny_ext:${denyHits.map((h) => h.name).join(",")}`,
      extensions,
      denyHits,
    };
  }

  if (allowlistOnly) {
    const bad = extensions.filter((x) => !allow.has(x.type));
    if (bad.length) {
      return {
        ok: false,
        reason: `not_in_allowlist:${bad.map((b) => `${b.type}:${b.name}`).join(",")}`,
        extensions,
        bad,
      };
    }
  }

  return { ok: true, reason: "extensions_ok", extensions };
}