import { BaseError, createPublicClient, formatUnits, http, parseAbi, type Address, type Hex } from "viem";
import { MAINNET_EXPLORER, robinhoodMainnet } from "./mainnet";

export const MORPHO_BLUE = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010" as Address;
export const MAINNET_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const MORPHO_API = "https://api.morpho.org/graphql";
const REGISTRY_API = "https://api.robinhood.com/rhj/assets";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** A market's oracle price further than this from the median of that token's markets is flagged. */
export const OUTLIER_FRACTION = 0.05;
/** Relative tolerance when comparing an 18-decimal on-chain multiplier with the registry's decimal string. */
const MULTIPLIER_TOLERANCE = 1e-9;

const MORPHO_ABI = parseAbi([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const TOKEN_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
]);
const ORACLE_ABI = parseAbi([
  "function price() view returns (uint256)",
  "function solvencyOracle() view returns (address)",
]);

export type CollateralClass = "issuer" | "usdg" | "copycat" | "other";
export type Verdict = "would-gate" | "wouldnt" | "reject";
export type WarningCode = "COPYCAT" | "MULTIPLIER_PENDING" | "MULTIPLIER_MISMATCH" | "PRICE_OUTLIER" | "ORACLE_REVERTS";
export type RadarWarning = { code: WarningCode; text: string };

export type RadarToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
};

export type RadarMarket = {
  id: Hex;
  lltv: number;
  loan: RadarToken & { copycat: boolean };
  collateral: RadarToken & {
    class: CollateralClass;
    /** The registry's symbol/name when the address is issuer-listed. */
    registry: { symbol: string; name: string } | null;
    multiplier: {
      live: number | null;
      pending: number | null;
      effectiveAt: number | null;
      registry: number | null;
      registryPending: number | null;
      registryPendingAt: number | null;
    } | null;
  };
  oracle: {
    address: Address;
    type: string | null;
    /** Loan-token units per whole collateral token, or null when price() reverts. */
    price: number | null;
    reverts: boolean;
    /** The oracle answers solvencyOracle(): it is already a ReserveProof-gated wrapper. */
    gated: boolean;
  };
  supply: number;
  borrow: number;
  verdict: Verdict;
  warnings: RadarWarning[];
};

export type RadarReport = {
  chainId: number;
  block: number;
  blockTime: number;
  readAt: number;
  explorer: string;
  morpho: Address;
  usdg: Address;
  sources: { morphoApi: boolean; registry: boolean; registryAssets: number };
  summary: {
    marketsTotal: number;
    marketsListed: number;
    custodialMarkets: number;
    wouldGate: { markets: number; active: number; usdgSupplied: number; usdgBorrowed: number };
    gatedToday: number;
    wouldnt: { markets: number; active: number };
    reject: { markets: number; active: number; usdgBorrowed: number; tokens: number };
    issuerTokens: number;
    warnings: Record<WarningCode, number>;
  };
  markets: RadarMarket[];
  errors: string[];
};

type RegistryEntry = {
  symbol: string;
  name: string;
  current: number | null;
  pending: number | null;
  pendingAt: number | null;
};

type ApiMarket = { marketId: Hex; oracle: { type: string | null } | null };

function errMsg(e: unknown) {
  const m = e instanceof BaseError ? e.shortMessage : (e as Error)?.message ?? String(e);
  return m.split("\n")[0].slice(0, 160);
}

function num(s: unknown): number | null {
  if (typeof s !== "string" || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function epoch(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : num(s);
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function sameMultiplier(a: number, b: number) {
  return Math.abs(a - b) <= MULTIPLIER_TOLERANCE * Math.max(a, b);
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function ratioText(r: number) {
  if (r >= 2) return `${r >= 1e6 ? r.toExponential(1) : r.toLocaleString("en-US", { maximumFractionDigits: 1 })}× the median`;
  if (r <= 0.5) return `1/${(1 / r).toLocaleString("en-US", { maximumFractionDigits: 1 })} of the median`;
  return `${((r - 1) * 100).toFixed(1)}% from the median`;
}

function utc(sec: number) {
  return new Date(sec * 1000).toUTCString().slice(5, 22) + " UTC";
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function discoverMarkets(): Promise<ApiMarket[]> {
  const query = `{ markets(first: 1000, where: { chainId_in: [4663] }) { items { marketId oracle { type } } } }`;
  const body = await postJson(MORPHO_API, { query });
  if (body.errors) throw new Error(`Morpho API: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.data.markets.items as ApiMarket[];
}

async function loadRegistry(): Promise<Map<string, RegistryEntry>> {
  const res = await fetch(REGISTRY_API, { cache: "no-store", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Robinhood registry: HTTP ${res.status}`);
  const body = (await res.json()) as {
    assets?: {
      tokenSymbol?: string;
      tokenName?: string;
      currentMultiplier?: string;
      pendingMultiplier?: string;
      pendingMultiplierEffectiveTime?: string;
      deployments?: { contractAddress?: string; chainId?: number }[];
    }[];
  };
  const out = new Map<string, RegistryEntry>();
  for (const a of body.assets ?? []) {
    for (const d of a.deployments ?? []) {
      if (d.chainId !== robinhoodMainnet.id || !d.contractAddress) continue;
      out.set(d.contractAddress.toLowerCase(), {
        symbol: a.tokenSymbol ?? "?",
        name: a.tokenName ?? "",
        current: num(a.currentMultiplier),
        pending: num(a.pendingMultiplier),
        pendingAt: epoch(a.pendingMultiplierEffectiveTime),
      });
    }
  }
  if (out.size === 0) throw new Error("Robinhood registry: no chain 4663 deployments listed");
  return out;
}

export async function loadRadar(): Promise<RadarReport> {
  const errors: string[] = [];
  const client = createPublicClient({ chain: robinhoodMainnet, transport: http() });

  const [apiRes, regRes, headRes] = await Promise.allSettled([discoverMarkets(), loadRegistry(), client.getBlock()]);
  if (apiRes.status === "rejected") throw new Error(`market discovery failed: ${errMsg(apiRes.reason)}`);
  if (headRes.status === "rejected") throw new Error(`mainnet RPC failed: ${errMsg(headRes.reason)}`);
  const apiMarkets = apiRes.value;
  const head = headRes.value;
  const blockNumber = head.number;
  let registry = new Map<string, RegistryEntry>();
  if (regRes.status === "fulfilled") registry = regRes.value;
  else errors.push(`${errMsg(regRes.reason)}; copycat detection is off, so stock-like tokens are treated as issuer-listed`);
  const registryOk = regRes.status === "fulfilled";
  const registryTickers = new Set(Array.from(registry.values(), (r) => r.symbol.toUpperCase()));
  const nowSec = Math.floor(Date.now() / 1000);

  const multi = <T>(contracts: readonly unknown[]) =>
    client.multicall({ contracts: contracts as never, allowFailure: true, blockNumber, batchSize: 4096 }) as Promise<
      { status: "success" | "failure"; result?: T; error?: Error }[]
    >;

  const ids = apiMarkets.map((m) => m.marketId);
  const [paramsRes, stateRes] = await Promise.all([
    multi<readonly [Address, Address, Address, Address, bigint]>(
      ids.map((id) => ({ address: MORPHO_BLUE, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] }))
    ),
    multi<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(
      ids.map((id) => ({ address: MORPHO_BLUE, abi: MORPHO_ABI, functionName: "market", args: [id] }))
    ),
  ]);

  const raw = ids
    .map((id, i) => {
      const p = paramsRes[i];
      const s = stateRes[i];
      if (p.status !== "success" || !p.result) {
        errors.push(`market ${id.slice(0, 10)}: params unreadable`);
        return null;
      }
      const [loanToken, collateralToken, oracle, , lltv] = p.result;
      return {
        id,
        loanToken,
        collateralToken,
        oracle,
        lltv,
        supply: s.status === "success" && s.result ? s.result[0] : BigInt(0),
        borrow: s.status === "success" && s.result ? s.result[2] : BigInt(0),
        oracleType: apiMarkets[i].oracle?.type ?? null,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  const listed = raw.filter((m) => m.collateralToken !== ZERO_ADDR && m.loanToken !== ZERO_ADDR);

  const tokenAddrs = Array.from(
    new Set(listed.flatMap((m) => [m.loanToken.toLowerCase(), m.collateralToken.toLowerCase()]))
  ) as Address[];
  const TOKEN_FNS = ["symbol", "name", "decimals", "uiMultiplier", "newUIMultiplier", "effectiveAt"] as const;
  const oracleAddrs = Array.from(new Set(listed.map((m) => m.oracle.toLowerCase()))) as Address[];

  const [tokenRes, priceRes, gatedRes] = await Promise.all([
    multi<unknown>(tokenAddrs.flatMap((address) => TOKEN_FNS.map((functionName) => ({ address, abi: TOKEN_ABI, functionName })))),
    multi<bigint>(listed.map((m) => ({ address: m.oracle, abi: ORACLE_ABI, functionName: "price" }))),
    multi<Address>(oracleAddrs.map((address) => ({ address, abi: ORACLE_ABI, functionName: "solvencyOracle" }))),
  ]);

  type TokenInfo = RadarToken & { live: bigint | null; pending: bigint | null; effectiveAt: bigint | null };
  const tokens = new Map<string, TokenInfo>();
  tokenAddrs.forEach((address, i) => {
    const r = tokenRes.slice(i * TOKEN_FNS.length, (i + 1) * TOKEN_FNS.length);
    const ok = <T>(j: number) => (r[j].status === "success" ? (r[j].result as T) : null);
    tokens.set(address, {
      address,
      symbol: ok<string>(0) ?? "?",
      name: ok<string>(1) ?? "",
      decimals: Number(ok<number>(2) ?? 18),
      live: ok<bigint>(3),
      pending: ok<bigint>(4),
      effectiveAt: ok<bigint>(5),
    });
  });
  const gatedOracles = new Set(oracleAddrs.filter((_, i) => gatedRes[i].status === "success" && gatedRes[i].result !== ZERO_ADDR));

  const usdgKey = MAINNET_USDG.toLowerCase();

  /** Why a token that is neither official USDG nor issuer-listed looks like one of them (empty = it doesn't). */
  function impersonation(t: TokenInfo): string[] {
    if (t.address === usdgKey || registry.has(t.address)) return [];
    const why: string[] = [];
    if (t.symbol.toUpperCase() === "USDG" || /global dollar/i.test(t.name)) why.push("uses the USDG name but is not the Paxos contract");
    if (!registryOk) return why;
    if (/robinhood/i.test(t.name)) why.push(`is named "${t.name}"`);
    if (registryTickers.has(t.symbol.toUpperCase())) why.push(`uses the ticker ${t.symbol} of an issuer-listed token`);
    if (t.live !== null) why.push("answers ERC-8056 uiMultiplier()");
    return why;
  }

  const markets: RadarMarket[] = listed.map((m, i) => {
    const loan = tokens.get(m.loanToken.toLowerCase())!;
    const col = tokens.get(m.collateralToken.toLowerCase())!;
    const reg = registry.get(col.address) ?? null;
    const answersErc8056 = col.live !== null;
    const colFake = impersonation(col);
    const loanFake = impersonation(loan);

    let cls: CollateralClass;
    if (col.address === usdgKey) cls = "usdg";
    else if (reg) cls = "issuer";
    else if (!registryOk && answersErc8056) cls = "issuer";
    else if (colFake.length) cls = "copycat";
    else cls = "other";

    const verdict: Verdict =
      cls === "copycat" || loanFake.length ? "reject" : cls === "other" ? "wouldnt" : "would-gate";
    const warnings: RadarWarning[] = [];

    if (colFake.length) {
      warnings.push({
        code: "COPYCAT",
        text:
          `Collateral ${col.symbol || "?"} (${shortAddr(col.address)}) ${colFake.join(", ")}, yet is not in Robinhood's asset registry. ` +
          "No custodian stands behind it; do not list.",
      });
    }
    if (loanFake.length) {
      warnings.push({
        code: "COPYCAT",
        text: `Loan token ${loan.symbol || "?"} (${shortAddr(loan.address)}) ${loanFake.join(", ")}. Lenders here are not lending the real asset.`,
      });
    }

    const pDec = 36 + loan.decimals - col.decimals;
    const pr = priceRes[i];
    const price = pr.status === "success" && typeof pr.result === "bigint" ? Number(formatUnits(pr.result, pDec)) : null;
    if (pr.status !== "success") {
      warnings.push({ code: "ORACLE_REVERTS", text: "price() reverts: borrows and liquidations in this market are already stuck." });
    }

    let multiplier: RadarMarket["collateral"]["multiplier"] = null;
    if (answersErc8056 || reg) {
      const live = col.live !== null ? Number(formatUnits(col.live, 18)) : null;
      const pendingRaw = col.pending !== null && col.pending > BigInt(0) ? col.pending : null;
      const effectiveAt = col.effectiveAt !== null && col.effectiveAt > BigInt(0) ? Number(col.effectiveAt) : null;
      multiplier = {
        live,
        pending: pendingRaw !== null ? Number(formatUnits(pendingRaw, 18)) : null,
        effectiveAt,
        registry: reg?.current ?? null,
        registryPending: reg?.pending ?? null,
        registryPendingAt: reg?.pendingAt ?? null,
      };
      const chainPending =
        effectiveAt !== null && effectiveAt > nowSec && pendingRaw !== null && col.live !== null && pendingRaw !== col.live;
      if (chainPending || reg?.pending) {
        const at = chainPending ? effectiveAt : reg?.pendingAt ?? null;
        const to = chainPending ? multiplier.pending : reg?.pending;
        warnings.push({
          code: "MULTIPLIER_PENDING",
          text:
            `Corporate action pending${at ? ` at ${utc(at)}` : ""} (multiplier ${live ?? "?"} → ${to ?? "?"}): ` +
            "a ReserveProof-gated market freezes now (MULTIPLIER_DRIFT) until the custodian recommits; price guards pause too.",
        });
      }
      if (live !== null && reg?.current != null && !sameMultiplier(live, reg.current)) {
        warnings.push({
          code: "MULTIPLIER_MISMATCH",
          text: `On-chain uiMultiplier ${live} differs from the registry's ${reg.current}: an oracle scaling by one of them misprices the other.`,
        });
      }
    }

    return {
      id: m.id,
      lltv: Number(formatUnits(m.lltv, 18)),
      loan: { address: loan.address, symbol: loan.symbol, name: loan.name, decimals: loan.decimals, copycat: loanFake.length > 0 },
      collateral: {
        address: col.address,
        symbol: col.symbol,
        name: col.name,
        decimals: col.decimals,
        class: cls,
        registry: reg ? { symbol: reg.symbol, name: reg.name } : null,
        multiplier,
      },
      oracle: {
        address: m.oracle,
        type: m.oracleType,
        price,
        reverts: pr.status !== "success",
        gated: gatedOracles.has(m.oracle.toLowerCase() as Address),
      },
      supply: Number(formatUnits(m.supply, loan.decimals)),
      borrow: Number(formatUnits(m.borrow, loan.decimals)),
      verdict,
      warnings,
    };
  });

  // Median oracle price per (collateral, loan) pair; a market far from it prices the same token differently.
  const groups = new Map<string, RadarMarket[]>();
  for (const m of markets) {
    if (m.oracle.price === null || m.oracle.price <= 0) continue;
    const k = `${m.collateral.address}:${m.loan.address}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  for (const group of Array.from(groups.values())) {
    if (group.length < 2) continue;
    const med = median(group.map((m) => m.oracle.price as number));
    for (const m of group) {
      const ratio = (m.oracle.price as number) / med;
      if (Math.abs(ratio - 1) > OUTLIER_FRACTION) {
        m.warnings.push({
          code: "PRICE_OUTLIER",
          text:
            `Oracle price is ${ratioText(ratio)} of ${group.length} ${m.collateral.symbol}/${m.loan.symbol} markets: ` +
            "multiplier applied twice, or the wrong feed?",
        });
      }
    }
  }

  // Official-USDG markets first (their amounts are dollars), then everything else; each by borrowed.
  const isUsdgLoan = (m: RadarMarket) => (m.loan.address === usdgKey ? 1 : 0);
  markets.sort((a, b) => isUsdgLoan(b) - isUsdgLoan(a) || b.borrow - a.borrow || b.supply - a.supply);

  const active = (xs: RadarMarket[]) => xs.filter((m) => m.supply > 0).length;
  const usdgSum = (xs: RadarMarket[], f: "supply" | "borrow") =>
    xs.filter((m) => m.loan.address === usdgKey).reduce((s, m) => s + m[f], 0);
  const wouldGate = markets.filter((m) => m.verdict === "would-gate");
  const wouldnt = markets.filter((m) => m.verdict === "wouldnt");
  const reject = markets.filter((m) => m.verdict === "reject");
  const warnings: Record<WarningCode, number> = {
    COPYCAT: 0,
    MULTIPLIER_PENDING: 0,
    MULTIPLIER_MISMATCH: 0,
    PRICE_OUTLIER: 0,
    ORACLE_REVERTS: 0,
  };
  for (const m of markets) for (const w of m.warnings) warnings[w.code]++;

  return {
    chainId: robinhoodMainnet.id,
    block: Number(blockNumber),
    blockTime: Number(head.timestamp),
    readAt: nowSec,
    explorer: MAINNET_EXPLORER,
    morpho: MORPHO_BLUE,
    usdg: MAINNET_USDG,
    sources: { morphoApi: true, registry: registryOk, registryAssets: registry.size },
    summary: {
      marketsTotal: apiMarkets.length,
      marketsListed: markets.length,
      custodialMarkets: wouldGate.length,
      wouldGate: {
        markets: wouldGate.length,
        active: active(wouldGate),
        usdgSupplied: usdgSum(wouldGate, "supply"),
        usdgBorrowed: usdgSum(wouldGate, "borrow"),
      },
      gatedToday: markets.filter((m) => m.oracle.gated).length,
      wouldnt: { markets: wouldnt.length, active: active(wouldnt) },
      reject: {
        markets: reject.length,
        active: active(reject),
        usdgBorrowed: usdgSum(reject, "borrow"),
        tokens: new Set(
          reject.flatMap((m) => [
            ...(m.collateral.class === "copycat" ? [m.collateral.address] : []),
            ...(m.loan.copycat ? [m.loan.address] : []),
          ])
        ).size,
      },
      issuerTokens: new Set(markets.filter((m) => m.collateral.class === "issuer").map((m) => m.collateral.address)).size,
      warnings,
    },
    markets,
    errors,
  };
}
