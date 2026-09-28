/**
 * Read-only snapshot of the custodial-asset market on Robinhood Chain mainnet, for the pitch.
 * Market ids come from the Morpho API (discovery only); every number is then read on chain at one
 * block: token supplies, Morpho Blue market totals, collateral held by Morpho, and oracle prices.
 * A collateral token counts as a Robinhood stock token only if it answers ERC-8056 uiMultiplier().
 *
 *   npm run market:size          # writes docs/market-size.json
 */
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com";
const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const MORPHO_API = "https://api.morpho.org/graphql";
const OUT = path.join(__dirname, "..", "docs", "market-size.json");

const MORPHO_ABI = [
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
];
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function uiMultiplier() view returns (uint256)",
];
const ORACLE_ABI = ["function price() view returns (uint256)"];

type Token = { address: string; symbol: string; decimals: number; totalSupply: bigint; inMorpho: bigint; stock: boolean };

async function marketIds(): Promise<string[]> {
  const query = `{ markets(first: 1000, where: { chainId_in: [4663] }) { items { marketId } } }`;
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`Morpho API: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data.markets.items.map((m: { marketId: string }) => m.marketId);
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const usd = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });
  const head = await provider.getBlock("latest");
  if (!head) throw new Error("no head block");
  const blockTag = head.number;
  const morpho = new Contract(MORPHO, MORPHO_ABI, provider);

  const ids = await marketIds();
  const markets = await inBatches(ids, 20, async (id) => {
    const p = await morpho.idToMarketParams(id, { blockTag });
    const s = await morpho.market(id, { blockTag });
    return {
      id,
      loanToken: p.loanToken as string,
      collateralToken: p.collateralToken as string,
      oracle: p.oracle as string,
      supply: s.totalSupplyAssets as bigint,
      borrow: s.totalBorrowAssets as bigint,
    };
  });

  const tokens = new Map<string, Token>();
  const collaterals = [...new Set(markets.map((m) => m.collateralToken.toLowerCase()))].filter(
    (a) => a !== "0x0000000000000000000000000000000000000000"
  );
  await inBatches(collaterals, 10, async (addr) => {
    const t = new Contract(addr, TOKEN_ABI, provider);
    const [symbol, decimals, totalSupply, inMorpho] = await Promise.all([
      t.symbol({ blockTag }).catch(() => "?"),
      t.decimals({ blockTag }).catch(() => 18),
      t.totalSupply({ blockTag }).catch(() => 0n),
      t.balanceOf(MORPHO, { blockTag }).catch(() => 0n),
    ]);
    const stock = await t.uiMultiplier({ blockTag }).then(
      () => true,
      () => false
    );
    tokens.set(addr, { address: addr, symbol, decimals: Number(decimals), totalSupply, inMorpho, stock });
  });

  // USD per whole collateral token: median over every USDG-loan market oracle that answers, so one
  // misconfigured oracle in a permissionless market cannot skew the figure.
  const quotes = new Map<string, number[]>();
  const usdgMarkets = markets.filter(
    (m) => tokens.get(m.collateralToken.toLowerCase())?.stock && m.loanToken.toLowerCase() === USDG.toLowerCase()
  );
  await inBatches(usdgMarkets, 10, async (m) => {
    const c = m.collateralToken.toLowerCase();
    const tok = tokens.get(c)!;
    try {
      const p: bigint = await new Contract(m.oracle, ORACLE_ABI, provider).price({ blockTag });
      // price = loan units per collateral unit * 1e36; USDG has 6 decimals (keep 6 extra digits).
      const perWhole = Number((p * 10n ** BigInt(tok.decimals)) / 10n ** 30n) / 1e12;
      if (perWhole > 0) quotes.set(c, [...(quotes.get(c) ?? []), perWhole]);
    } catch {
      /* oracle reverted */
    }
  });
  const priceUsd = new Map<string, number>();
  for (const [c, qs] of quotes) {
    const s = [...qs].sort((a, b) => a - b);
    priceUsd.set(c, s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  }

  const usdgToken = new Contract(USDG, TOKEN_ABI, provider);
  const usdgSupply: bigint = await usdgToken.totalSupply({ blockTag });

  const stockMarkets = markets.filter(
    (m) => tokens.get(m.collateralToken.toLowerCase())?.stock && m.loanToken.toLowerCase() === USDG.toLowerCase()
  );
  const usdgSupplied = stockMarkets.reduce((s, m) => s + m.supply, 0n);
  const usdgBorrowed = stockMarkets.reduce((s, m) => s + m.borrow, 0n);

  const stocks = [...tokens.values()]
    .filter((t) => t.stock)
    .map((t) => {
      const px = priceUsd.get(t.address) ?? null;
      const supply = Number(formatUnits(t.totalSupply, t.decimals));
      const inMorpho = Number(formatUnits(t.inMorpho, t.decimals));
      return {
        symbol: t.symbol,
        address: t.address,
        totalSupply: supply,
        priceUsd: px,
        supplyUsd: px === null ? null : usd(supply * px),
        heldByMorpho: inMorpho,
        heldByMorphoUsd: px === null ? null : usd(inMorpho * px),
        morphoMarkets: stockMarkets.filter((m) => m.collateralToken.toLowerCase() === t.address).length,
      };
    })
    .sort((a, b) => (b.supplyUsd ?? 0) - (a.supplyUsd ?? 0));

  const priced = stocks.filter((s) => s.supplyUsd !== null);
  const doc = {
    chain: "Robinhood Chain mainnet (4663)",
    block: blockTag,
    timestamp: new Date(head.timestamp * 1000).toISOString(),
    method:
      "Morpho market ids from api.morpho.org (discovery only); all figures read on chain at `block`. " +
      "Stock tokens = Morpho collateral answering ERC-8056 uiMultiplier(). USD prices = the market's own " +
      "Morpho oracle price() in USDG (1 USDG = $1). Stocks without an answering oracle are listed unpriced.",
    usdg: { address: USDG, totalSupply: Number(formatUnits(usdgSupply, 6)) },
    stockTokens: {
      count: stocks.length,
      priced: priced.length,
      totalSupplyUsd: usd(priced.reduce((s, x) => s + (x.supplyUsd ?? 0), 0)),
      heldByMorphoUsd: usd(priced.reduce((s, x) => s + (x.heldByMorphoUsd ?? 0), 0)),
    },
    morpho: {
      address: MORPHO,
      marketsTotal: markets.length,
      stockCollateralMarkets: stockMarkets.length,
      usdgSuppliedAgainstStocks: Number(formatUnits(usdgSupplied, 6)),
      usdgBorrowedAgainstStocks: Number(formatUnits(usdgBorrowed, 6)),
      note: "Morpho Blue asks an oracle only for price(); nothing in these markets reads the custodian's reserves.",
    },
    stocks,
  };

  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
  console.log(`block ${doc.block} (${doc.timestamp})`);
  console.log(`USDG supply: ${doc.usdg.totalSupply.toLocaleString("en-US")}`);
  console.log(
    `Stock tokens: ${stocks.length} (${priced.length} priced), supply $${doc.stockTokens.totalSupplyUsd.toLocaleString("en-US")}, ` +
      `in Morpho $${doc.stockTokens.heldByMorphoUsd.toLocaleString("en-US")}`
  );
  console.log(
    `Morpho: ${markets.length} markets, ${stockMarkets.length} lend USDG against stock tokens: ` +
      `${doc.morpho.usdgSuppliedAgainstStocks.toLocaleString("en-US")} USDG supplied, ` +
      `${doc.morpho.usdgBorrowedAgainstStocks.toLocaleString("en-US")} borrowed`
  );
  for (const s of stocks.slice(0, 12)) {
    console.log(
      `  ${s.symbol.padEnd(6)} supply ${s.totalSupply.toFixed(2).padStart(12)}  $${String(s.supplyUsd ?? "?").padStart(14)}  ` +
        `in Morpho $${String(s.heldByMorphoUsd ?? "?").padStart(12)}  markets ${s.morphoMarkets}`
    );
  }
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
