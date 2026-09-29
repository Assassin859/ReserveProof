/**
 * Read-only design-partner target list for docs/FOUNDER-HOUSE.md. No keys, no transactions.
 *   - USDG vaults on Robinhood Chain mainnet and their curators (Morpho API, vaultV2s)
 *   - the would-gate markets carrying the most borrow, and the collateral they concentrate in
 *   - copycat markets (loan or collateral token posing as USDG or a stock token)
 * Market data comes from the live radar (/api/radar), which reads Morpho Blue on chain at one block.
 *
 *   npm run gtm:targets          # writes docs/gtm-targets.json
 *   RADAR_URL=http://localhost:3000/api/radar npm run gtm:targets
 */
import * as fs from "fs";
import * as path from "path";

const MORPHO_API = "https://api.morpho.org/graphql";
const RADAR_URL = process.env.RADAR_URL || "https://reserveproof-teal.vercel.app/api/radar";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase();
const CHAIN_ID = 4663;
const TOP_MARKETS = 15;
/** Vaults below this are tests and demos; they are counted but not listed as targets. */
const MIN_VAULT_USD = 1_000;
const OUT = path.join(__dirname, "..", "docs", "gtm-targets.json");

type ApiVault = {
  address: string;
  name: string;
  symbol: string;
  asset: { address: string; symbol: string };
  totalAssetsUsd: number | null;
  curator: { address: string } | null;
};

type RadarMarket = {
  id: string;
  lltv: number;
  loan: { address: string; symbol: string; copycat: boolean };
  collateral: { address: string; symbol: string; class: string; registry: { symbol: string; name: string } | null };
  oracle: { address: string; type: string | null; gated: boolean };
  supply: number;
  borrow: number;
  verdict: "would-gate" | "wouldnt" | "reject";
  warnings: { code: string; text: string }[];
};

type RadarReport = {
  block: number;
  blockTime: number;
  explorer: string;
  summary: {
    marketsTotal: number;
    wouldGate: { markets: number; active: number; usdgSupplied: number; usdgBorrowed: number };
    reject: { markets: number; active: number; usdgBorrowed: number; tokens: number };
    issuerTokens: number;
  };
  markets: RadarMarket[];
};

async function usdgVaults() {
  const query = `{ vaultV2s(first: 200, where: { chainId_in: [${CHAIN_ID}] }) {
    items { address name symbol asset { address symbol } totalAssetsUsd curator { address } } } }`;
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`Morpho API: ${JSON.stringify(body.errors).slice(0, 300)}`);
  const all: ApiVault[] = body.data.vaultV2s.items;
  const usdg = all
    .filter((v) => v.asset?.address?.toLowerCase() === USDG)
    .map((v) => ({
      name: v.name,
      symbol: v.symbol,
      address: v.address,
      curator: v.curator?.address ?? null,
      tvlUsd: Math.round(v.totalAssetsUsd ?? 0),
    }))
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
  return { vaultsOnChain: all.length, usdg, curated: usdg.filter((v) => v.tvlUsd >= MIN_VAULT_USD) };
}

async function morphoQuery<T>(query: string): Promise<T> {
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`Morpho API: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data as T;
}

/** Where USDG is lent on the chain today, by collateral: the markets curators already allocate to. */
async function usdgLending() {
  type Item = {
    marketId: string;
    loanAsset: { address: string };
    collateralAsset: { symbol: string; address: string } | null;
    state: { supplyAssetsUsd: number | null; borrowAssetsUsd: number | null; utilization: number | null };
  };
  const data = await morphoQuery<{ markets: { items: Item[] } }>(`{ markets(first: 1000, orderBy: SupplyAssetsUsd,
    orderDirection: Desc, where: { chainId_in: [${CHAIN_ID}] }) { items { marketId loanAsset { address }
    collateralAsset { symbol address } state { supplyAssetsUsd borrowAssetsUsd utilization } } } }`);
  const usdg = data.markets.items.filter((m) => m.loanAsset.address.toLowerCase() === USDG);
  const totalSupplyUsd = usdg.reduce((s, m) => s + (m.state.supplyAssetsUsd ?? 0), 0);
  return {
    totalSupplyUsd: Math.round(totalSupplyUsd),
    topMarkets: usdg.slice(0, 6).map((m) => ({
      id: m.marketId,
      collateral: m.collateralAsset?.symbol ?? "(none)",
      collateralAddress: m.collateralAsset?.address ?? null,
      supplyUsd: Math.round(m.state.supplyAssetsUsd ?? 0),
      borrowUsd: Math.round(m.state.borrowAssetsUsd ?? 0),
      utilization: round(m.state.utilization ?? 0),
    })),
  };
}

/** Supplying vaults and utilization for the given markets, one aliased query. */
async function marketDetails(ids: string[]) {
  type Detail = { supplyingVaults: { address: string; name: string }[]; state: { utilization: number | null } } | null;
  if (ids.length === 0) return new Map<string, Detail>();
  const fields = ids
    .map((id, i) => `m${i}: marketById(marketId: "${id}", chainId: ${CHAIN_ID}) { supplyingVaults { address name } state { utilization } }`)
    .join(" ");
  const data = await morphoQuery<Record<string, Detail>>(`{ ${fields} }`);
  return new Map(ids.map((id, i) => [id.toLowerCase(), data[`m${i}`]]));
}

async function radar(): Promise<RadarReport> {
  const res = await fetch(RADAR_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`radar ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const round = (n: number) => Math.round(n * 100) / 100;

function marketRow(m: RadarMarket) {
  return {
    id: m.id,
    collateral: m.collateral.registry?.symbol ?? m.collateral.symbol,
    collateralAddress: m.collateral.address,
    loan: m.loan.symbol,
    lltv: m.lltv,
    supplyUsdg: round(m.supply),
    borrowUsdg: round(m.borrow),
    oracle: m.oracle.address,
    oracleType: m.oracle.type,
    warnings: m.warnings.map((w) => w.code),
  };
}

async function main() {
  const [vaults, r, lending] = await Promise.all([usdgVaults(), radar(), usdgLending()]);

  const wouldGate = r.markets.filter((m) => m.verdict === "would-gate");
  const top = [...wouldGate].sort((a, b) => b.borrow - a.borrow).slice(0, TOP_MARKETS);
  const details = await marketDetails(top.map((m) => m.id));
  const topMarkets = top.map((m) => {
    const d = details.get(m.id.toLowerCase());
    return {
      ...marketRow(m),
      utilization: d?.state.utilization != null ? round(d.state.utilization) : null,
      supplyingVaults: d?.supplyingVaults.map((v) => ({ name: v.name, address: v.address })) ?? null,
    };
  });
  const vaultBackedTop = topMarkets.filter((m) => (m.supplyingVaults?.length ?? 0) > 0).length;

  const byToken = new Map<string, { symbol: string; name: string | null; address: string; markets: number; borrowUsdg: number }>();
  for (const m of wouldGate) {
    const key = m.collateral.address.toLowerCase();
    const row = byToken.get(key) ?? {
      symbol: m.collateral.registry?.symbol ?? m.collateral.symbol,
      name: m.collateral.registry?.name ?? null,
      address: m.collateral.address,
      markets: 0,
      borrowUsdg: 0,
    };
    row.markets += 1;
    row.borrowUsdg += m.borrow;
    byToken.set(key, row);
  }
  const topCollateral = Array.from(byToken.values())
    .map((t) => ({ ...t, borrowUsdg: round(t.borrowUsdg) }))
    .sort((a, b) => b.borrowUsdg - a.borrowUsdg)
    .slice(0, 10);

  const copycats = r.markets
    .filter((m) => m.verdict === "reject")
    .map((m) => ({
      ...marketRow(m),
      loanAddress: m.loan.address,
      why: m.warnings.find((w) => w.code === "COPYCAT")?.text ?? null,
    }));

  const out = {
    fetchedAt: new Date().toISOString(),
    note: "Targets, not relationships: public on-chain and API data only. No one listed here has been contacted or has endorsed ReserveProof.",
    sources: { morphoApi: MORPHO_API, radar: RADAR_URL },
    radarBlock: r.block,
    radarBlockTime: new Date(r.blockTime * 1000).toISOString(),
    summary: {
      marketsTotal: r.summary.marketsTotal,
      wouldGateMarkets: r.summary.wouldGate.markets,
      wouldGateUsdgSupplied: round(r.summary.wouldGate.usdgSupplied),
      wouldGateUsdgBorrowed: round(r.summary.wouldGate.usdgBorrowed),
      copycatMarkets: r.summary.reject.markets,
      issuerTokens: r.summary.issuerTokens,
      vaultV2sOnChain: vaults.vaultsOnChain,
      usdgVaults: vaults.usdg.length,
      usdgVaultsOver1k: vaults.curated.length,
      usdgVaultTvlUsd: vaults.usdg.reduce((s, v) => s + v.tvlUsd, 0),
      usdgLentUsd: lending.totalSupplyUsd,
      topWouldGateMarketsWithAVault: vaultBackedTop,
    },
    curators: vaults.curated,
    usdgLendingTop: lending.topMarkets,
    topWouldGateMarkets: topMarkets,
    topCollateral,
    copycats,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  radar block ${r.block}: ${out.summary.wouldGateMarkets} would-gate markets, ${out.summary.copycatMarkets} copycats`);
  console.log(`  ${vaults.usdg.length} USDG vaults of ${vaults.vaultsOnChain}, $${out.summary.usdgVaultTvlUsd.toLocaleString("en-US")} TVL`);
  for (const v of vaults.curated) {
    console.log(`    ${v.name.padEnd(28)} $${v.tvlUsd.toLocaleString("en-US").padStart(13)}  curator ${v.curator}`);
  }
  console.log(`  USDG lent chain-wide $${lending.totalSupplyUsd.toLocaleString("en-US")}; top: ${lending.topMarkets.slice(0, 4).map((m) => `${m.collateral} $${(m.supplyUsd / 1e6).toFixed(1)}M`).join(", ")}`);
  console.log(`  top ${topMarkets.length} would-gate markets: ${vaultBackedTop} supplied by a vault; utilization ${topMarkets.slice(0, 5).map((m) => m.utilization).join(", ")}`);
  console.log(`  top collateral: ${topCollateral.slice(0, 5).map((t) => `${t.symbol} ${t.borrowUsdg.toFixed(0)}`).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
