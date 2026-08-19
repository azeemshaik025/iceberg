// Detects and connects to a STRK20-capable wallet (Ready) via the Wallet API
// (WalletAccountV6), rather than the SDK-direct route in strk20.js's history.
// The wallet does its own proving and discovery internally — this app never
// sees a proving/discovery URL or a viewing key. Pattern verified against
// Philoxenia (github.com/SergioSSantiago/philoxenia), the one STRK20 Private
// Sprint project that shipped a working mainnet demo with this exact route.

import { createStore } from "@starknet-io/get-starknet-discovery";
import { WalletAccountV6, walletV6 } from "starknet";

/// Wallet API >= 0.10 exposes STRK20 (shield/unshield/strk20InvokeTransaction).
/// Never probe strk20Balances([]) for feature detection — that's what the
/// version check below exists to replace.
export function isStrk20WalletApi(versions) {
  for (const raw of versions) {
    const v = String(raw).replace(/^v/i, "");
    const [majS, minS] = v.split(".");
    const maj = Number(majS);
    const min = Number(minS);
    if (!Number.isFinite(maj)) continue;
    if (maj > 0) return true;
    if (maj === 0 && Number.isFinite(min) && min >= 10) return true;
  }
  return false;
}

/// Ready often injects after first paint; poll briefly rather than assume
/// it's missing on the first check.
async function discoverWallets(timeoutMs = 2000) {
  const store = createStore();
  store._refreshInjectedWallets();

  const immediate = store.getWallets();
  if (immediate.length > 0) return immediate;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (wallets) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(wallets);
    };
    const cleanup = store.subscribe((wallets) => {
      if (wallets.length > 0) finish([...wallets]);
    });
    const poll = window.setInterval(() => {
      store._refreshInjectedWallets();
      const found = store.getWallets();
      if (found.length > 0) finish(found);
    }, 200);
    window.setTimeout(() => {
      window.clearInterval(poll);
      store._refreshInjectedWallets();
      finish(store.getWallets());
    }, timeoutMs);
  });
}

/// Resolves a connected WalletAccountV6 plus whether it's STRK20-capable.
/// `provider` is an RpcProvider (e.g. from iceberg.js's makeProvider) — the
/// wallet still does its own proving/discovery, this is only for reading
/// chain state the account interface needs. Returns null if no Ready wallet
/// is found (distinct from "found Ready but not privacy-capable", which
/// callers should surface directly).
///
/// Only ever selects a wallet whose name matches "ready" — never falls back
/// to "whatever extension answered first". get-starknet-discovery finds
/// every wallet-standard-compatible extension on the page (MetaMask's
/// Starknet snap included), and calling requestAccounts/supportedWalletApi
/// against a non-Ready wallet just gets rejected repeatedly with no useful
/// signal, on a loop, for as long as the page is open.
export async function resolvePrivacyWallet(provider) {
  if (typeof window === "undefined") return null;

  const wallets = await discoverWallets();
  const selected = wallets.find((w) => `${w.name ?? ""}`.toLowerCase().includes("ready"));
  if (!selected) return null;

  try {
    await walletV6.requestAccounts(selected);
  } catch {
    // still try the version probe below
  }

  let walletApiVersions = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      walletApiVersions = (await walletV6.supportedWalletApi(selected)).map(String);
      if (walletApiVersions.length > 0) break;
    } catch {
      walletApiVersions = [];
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 280 * (attempt + 1)));
      try {
        await walletV6.requestAccounts(selected);
      } catch {
        // retry the version probe
      }
    }
  }

  const privacyCapable = isStrk20WalletApi(walletApiVersions);
  const account = await WalletAccountV6.connect(provider, selected);

  return { wallet: selected, account, privacyCapable, walletApiVersions };
}

/// Cheap capability check for UI gating (e.g. enabling pool-mode buttons)
/// without needing the caller to unpack a full session.
export async function detectPrivacyCapable(provider) {
  const session = await resolvePrivacyWallet(provider);
  return Boolean(session?.privacyCapable);
}
