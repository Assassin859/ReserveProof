"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useReadContract,
  usePublicClient,
  useWriteContract,
  useAccount,
  useConnect,
} from "wagmi";
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import {
  custodianRegistryAbi,
  solvencyOracleAbi,
  liabilityLedgerAbi,
  gatedPayoutAbi,
  exitRightAbi,
} from "../lib/abis";
import { buildSortedTree, verifyInclusion, type ProofNode } from "../lib/merkle";
import { reasonLabel } from "../lib/reasons";
import { SCENES, type Deployment } from "../lib/types";
import {
  ASSET_META,
  NETWORKS,
  NETWORK_KEYS,
  defaultNetwork,
  type AssetKind,
  type NetworkKey,
} from "../lib/deployments";

type ChainId = 46630 | 421614 | 31337;

type Status = { ok: boolean; epochId: bigint; updatedAt: bigint; reason: number };
type EpochView = {
  liabilityRoot: Hex;
  totalLiability: bigint;
  allocation: bigint;
  exists: boolean;
  leafCount: number;
};

type BalanceResult = {
  user: Address;
  asset: AssetKind;
  epochId: number;
  found: boolean;
  amount: bigint;
  proof: ProofNode[];
  computedRoot: Hex;
  onchainRoot: Hex;
  rootMatches: boolean;
  verified: boolean;
};

type ExitInfo = {
  bondBalance: bigint;
  bondInFlight: bigint;
  perClaim: bigint;
  payoutDelay: bigint;
  configured: boolean;
  claimCount: bigint;
  exitDefault: boolean;
  last?: {
    id: bigint;
    user: Address;
    amount: bigint;
    deadline: bigint;
    open: boolean;
    settled: boolean;
    slashed: boolean;
  };
};

function short(addr?: string) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function parseStatus(raw: unknown): Status | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return { ok: raw[0], epochId: raw[1], updatedAt: raw[2], reason: Number(raw[3]) };
  }
  const s = raw as Status;
  return { ok: s.ok, epochId: s.epochId, updatedAt: s.updatedAt, reason: Number(s.reason) };
}

function parseEpoch(raw: unknown): EpochView | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return {
      liabilityRoot: raw[0] as Hex,
      totalLiability: raw[1] as bigint,
      allocation: raw[2] as bigint,
      exists: raw[6] as boolean,
      leafCount: Number(raw[7]),
    };
  }
  const e = raw as Omit<EpochView, "leafCount"> & { leafCount: number | bigint };
  return { ...e, leafCount: Number(e.leafCount) };
}

function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName;
  }
  return undefined;
}

function fmt(amount: bigint | undefined, kind: AssetKind) {
  if (amount === undefined) return "—";
  return `${formatUnits(amount, ASSET_META[kind].decimals)} ${ASSET_META[kind].label}`;
}

export function KopiApp() {
  const [network, setNetwork] = useState<NetworkKey>(defaultNetwork);
  const [dep, setDep] = useState<Deployment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scene, setScene] = useState(1);
  const [proofText, setProofText] = useState("");
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<string | null>(null);
  const [balAsset, setBalAsset] = useState<AssetKind>("stock");
  const [balAddr, setBalAddr] = useState("");
  const [balResult, setBalResult] = useState<BalanceResult | null>(null);
  const [balError, setBalError] = useState<string | null>(null);
  const [balBusy, setBalBusy] = useState(false);
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null);

  const net = NETWORKS[network];
  const isLocal = network === "localhost";
  const chainId = dep?.chainId as ChainId | undefined;

  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const publicClient = usePublicClient({ chainId });
  const { writeContractAsync } = useWriteContract();

  const refreshDep = useCallback(async () => {
    if (net.deployment) {
      setDep(net.deployment);
      setLoadError(null);
      return;
    }
    setDep(null);
    try {
      const res = await fetch("/api/deployment");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load deployment");
      setDep(data);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [net]);

  useEffect(() => {
    void refreshDep();
  }, [refreshDep]);

  const custodianId = dep?.custodianId;
  const asset = dep?.contracts.MockStockToken;
  const usdg = dep?.contracts.USDG;
  const oracle = dep?.contracts.SolvencyOracle;
  const registry = dep?.contracts.CustodianRegistry;
  const ledger = dep?.contracts.LiabilityLedger;
  const gated = dep?.contracts.GatedPayout;
  const exitRight = dep?.contracts.ExitRight;
  const assetAddr = (kind: AssetKind) => (kind === "stock" ? asset : usdg);

  const { data: status, refetch: refetchStatus } = useReadContract({
    address: oracle,
    abi: solvencyOracleAbi,
    functionName: "status",
    chainId,
    args: custodianId && asset ? [custodianId, asset] : undefined,
    query: { enabled: Boolean(oracle && custodianId && asset), refetchInterval: 4000 },
  });

  const { data: usdgStatus } = useReadContract({
    address: oracle,
    abi: solvencyOracleAbi,
    functionName: "status",
    chainId,
    args: custodianId && usdg ? [custodianId, usdg] : undefined,
    query: { enabled: Boolean(oracle && custodianId && usdg), refetchInterval: 8000 },
  });

  const { data: epochId } = useReadContract({
    address: ledger,
    abi: liabilityLedgerAbi,
    functionName: "latestEpochId",
    chainId,
    args: custodianId && asset ? [custodianId, asset] : undefined,
    query: { enabled: Boolean(ledger && custodianId && asset) },
  });

  const { data: epoch } = useReadContract({
    address: ledger,
    abi: liabilityLedgerAbi,
    functionName: "getEpoch",
    chainId,
    args: custodianId && asset && epochId ? [custodianId, asset, epochId] : undefined,
    query: { enabled: Boolean(ledger && custodianId && asset && epochId && Number(epochId) > 0) },
  });

  const parsed = useMemo(() => parseStatus(status), [status]);
  const parsedUsdg = useMemo(() => parseStatus(usdgStatus), [usdgStatus]);
  const epochData = useMemo(() => parseEpoch(epoch), [epoch]);
  const usdgHomeOnly = network === "arbitrumSepolia" && !net.books.liabilities.usdg;

  const loadEpoch = useCallback(
    async (kind: AssetKind) => {
      const addr = assetAddr(kind);
      if (!publicClient || !ledger || !custodianId || !addr) throw new Error("Deployment not loaded");
      const latest = (await publicClient.readContract({
        address: ledger,
        abi: liabilityLedgerAbi,
        functionName: "latestEpochId",
        args: [custodianId, addr],
      })) as bigint;
      if (latest === BigInt(0)) return { latest: 0, ep: null, addr };
      const ep = parseEpoch(
        await publicClient.readContract({
          address: ledger,
          abi: liabilityLedgerAbi,
          functionName: "getEpoch",
          args: [custodianId, addr, latest],
        })
      );
      return { latest: Number(latest), ep, addr };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicClient, ledger, custodianId, asset, usdg]
  );

  function fillDemoUser() {
    const book = net.books.liabilities[balAsset];
    const demo = net.books.demoUser ?? book?.[0]?.user ?? "";
    setBalAddr(demo);
    setBalResult(null);
    setBalError(null);
  }

  async function runBalanceCheck() {
    setBalResult(null);
    setBalError(null);
    const book = net.books.liabilities[balAsset];
    const label = ASSET_META[balAsset].label;
    if (!book) {
      setBalError(
        balAsset === "usdg" && network === "arbitrumSepolia"
          ? "USDG is home-chain only: its leaves bind Robinhood's USDG address, so the USDG book is published on Robinhood testnet."
          : `No ${label} liability book is published on ${net.label}.`
      );
      return;
    }
    if (!isAddress(balAddr.trim())) {
      setBalError("Enter a valid 0x address.");
      return;
    }
    if (!dep) return;
    setBalBusy(true);
    try {
      const { latest, ep, addr } = await loadEpoch(balAsset);
      if (!ep?.exists || !addr) {
        setBalError(`No ${label} epoch committed on ${net.label} yet.`);
        return;
      }
      const tree = buildSortedTree(
        dep.custodianId,
        addr,
        latest,
        book.map((l) => ({ user: l.user as Address, amount: BigInt(l.amount) }))
      );
      const user = getAddress(balAddr.trim());
      const proof = tree.proofs.get(user.toLowerCase()) ?? [];
      const leaf = tree.sorted.find((l) => l.user.toLowerCase() === user.toLowerCase());
      const rootMatches =
        tree.root.toLowerCase() === ep.liabilityRoot.toLowerCase() && tree.total === ep.totalLiability;
      const verified = leaf
        ? verifyInclusion({
            custodianId: dep.custodianId,
            asset: addr,
            epochId: latest,
            leafCount: ep.leafCount,
            user,
            amount: leaf.amount,
            root: ep.liabilityRoot,
            totalSum: ep.totalLiability,
            siblings: proof,
          })
        : false;
      setBalResult({
        user,
        asset: balAsset,
        epochId: latest,
        found: Boolean(leaf),
        amount: leaf?.amount ?? BigInt(0),
        proof,
        computedRoot: tree.root,
        onchainRoot: ep.liabilityRoot,
        rootMatches,
        verified,
      });
    } catch (e) {
      setBalError((e as Error).message);
    } finally {
      setBalBusy(false);
    }
  }

  async function runScene1() {
    if (!dep || !registry || !publicClient) return;
    setActionLog("Simulating duplicate addReserveWallet…");
    try {
      const owner = await publicClient.readContract({
        address: registry,
        abi: custodianRegistryAbi,
        functionName: "walletOwner",
        args: [BigInt(dep.chainId), dep.reserveWallet as Address],
      });
      if (owner && owner !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        setActionLog(
          `WalletTaken: ${short(dep.reserveWallet)} is already owned by custodian ${String(owner).slice(0, 10)}… — duplicate registration rejected.`
        );
      } else {
        setActionLog("Reserve wallet not registered yet — run demo:deploy first.");
      }
    } catch (e) {
      setActionLog(`Error: ${(e as Error).message}`);
    }
  }

  async function runVerify() {
    setVerifyMsg(null);
    if (!dep) return;
    try {
      const { latest, ep, addr } = await loadEpoch(balAsset);
      if (!ep?.exists || !addr) {
        setVerifyMsg(`No ${ASSET_META[balAsset].label} epoch committed yet.`);
        return;
      }
      const parsedProof = JSON.parse(proofText) as { user: string; amount: string; proof: ProofNode[] };
      const ok = verifyInclusion({
        custodianId: dep.custodianId,
        asset: addr,
        epochId: latest,
        leafCount: ep.leafCount,
        user: parsedProof.user as Address,
        amount: BigInt(parsedProof.amount),
        root: ep.liabilityRoot,
        totalSum: ep.totalLiability,
        siblings: parsedProof.proof,
      });
      setVerifyMsg(
        ok
          ? `Inclusion verified for ${short(parsedProof.user)} — ${fmt(BigInt(parsedProof.amount), balAsset)} at epoch ${latest}`
          : "Proof does NOT match the on-chain root / total for the latest epoch."
      );
    } catch (e) {
      setVerifyMsg(`Invalid proof JSON: ${(e as Error).message}`);
    }
  }

  async function tryPayout() {
    if (!gated || !publicClient || !dep) {
      setActionLog("GatedPayout not in deployment JSON.");
      return;
    }
    const account = (address ?? dep.deployer) as Address;
    try {
      await publicClient.simulateContract({
        address: gated,
        abi: gatedPayoutAbi,
        functionName: "payout",
        args: [account, BigInt(1)],
        account,
      });
    } catch (e) {
      if (revertName(e) === "Insolvent") {
        setActionLog(
          `Payout blocked: Insolvent. The oracle reports ${reasonLabel(parsed?.reason)}, so GatedPayout fails closed.`
        );
        return;
      }
      const credit = (await publicClient.readContract({
        address: gated,
        abi: gatedPayoutAbi,
        functionName: "credit",
        args: [account],
      })) as bigint;
      if (credit === BigInt(0)) {
        setActionLog(
          `No deposit in GatedPayout for ${short(account)}. The oracle is solvent, so the gate itself is open; deposit mTSLA first to withdraw.`
        );
      } else {
        const err = e as Error & { shortMessage?: string };
        setActionLog(`Payout reverted: ${err.shortMessage || err.message}`);
      }
      return;
    }
    if (!isConnected) {
      const c = connectors[0];
      if (c) connect({ connector: c });
      setActionLog(`Gate is open and ${short(account)} has credit. Connect a wallet on ${net.label} to send it.`);
      return;
    }
    try {
      await writeContractAsync({
        address: gated,
        abi: gatedPayoutAbi,
        chainId,
        functionName: "payout",
        args: [account, BigInt(1)],
      });
      setActionLog("Payout sent: the oracle reported solvent.");
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setActionLog(`Payout failed: ${err.shortMessage || err.message}`);
    }
    void refetchStatus();
  }

  const loadExit = useCallback(async () => {
    if (!publicClient || !exitRight || !custodianId || !asset) return;
    const read = (functionName: string, args: unknown[]) =>
      publicClient.readContract({ address: exitRight, abi: exitRightAbi, functionName, args });
    try {
      const [bal, inFlight, cfg, count, def] = (await Promise.all([
        read("bondBalance", [custodianId]),
        read("bondInFlight", [custodianId]),
        read("bondConfigs", [custodianId]),
        read("nextClaimId", []),
        read("exitDefault", [custodianId, asset]),
      ])) as [bigint, bigint, readonly [bigint, bigint, bigint, bigint, boolean], bigint, boolean];
      const info: ExitInfo = {
        bondBalance: bal,
        bondInFlight: inFlight,
        payoutDelay: cfg[1],
        perClaim: cfg[2],
        configured: cfg[4],
        claimCount: count,
        exitDefault: def,
      };
      if (count > BigInt(0)) {
        const c = (await read("claims", [count - BigInt(1)])) as readonly [
          Hex, Address, Address, bigint, bigint, bigint, bigint, boolean, boolean, boolean,
        ];
        info.last = {
          id: count - BigInt(1),
          user: c[1],
          amount: c[4],
          deadline: c[6],
          open: c[7],
          settled: c[8],
          slashed: c[9],
        };
      }
      setExitInfo(info);
    } catch (e) {
      setActionLog(`ExitRight read failed: ${(e as Error).message}`);
    }
  }, [publicClient, exitRight, custodianId, asset]);

  useEffect(() => {
    setExitInfo(null);
    if (scene === 8) void loadExit();
  }, [scene, loadExit]);

  const current = SCENES.find((s) => s.id === scene)!;
  const txLink = (hash?: string | null) =>
    hash && net.explorer ? (
      <a href={`${net.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
        {short(hash)} ↗
      </a>
    ) : (
      <span>{hash ? short(hash) : "—"}</span>
    );
  const addrLink = (addr?: string) =>
    addr && net.explorer ? (
      <a href={`${net.explorer}/address/${addr}`} target="_blank" rel="noreferrer">
        {short(addr)} ↗
      </a>
    ) : (
      short(addr)
    );

  return (
    <div className="shell">
      <header className="top">
        <div className="brand-block">
          <p className="eyebrow">ReserveProof · demo custodian</p>
          <h1 className="brand">Kopi Wallet</h1>
          <p className="tagline">
            Fail-closed solvency for USDG &amp; stock-token custodians — live reserves, Merkle liabilities,
            ExitRight.
          </p>
        </div>
        <div className="status-panel">
          <div className="netswitch" role="group" aria-label="Network">
            {NETWORK_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={network === k ? "step active" : "step"}
                onClick={() => {
                  setNetwork(k);
                  setActionLog(null);
                  setVerifyMsg(null);
                  setBalResult(null);
                  setBalError(null);
                }}
              >
                {NETWORKS[k].label}
              </button>
            ))}
          </div>
          <div className="stat">
            <span className="label">Network</span>
            <span className="value">{dep ? `${net.label} · ${dep.chainId}` : "…"}</span>
          </div>
          <div className="stat">
            <span className="label">Custodian</span>
            <span className="value mono">{dep?.custodianName ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="label">mTSLA solvent</span>
            <span className="row">
              <span className={`pill ${parsed?.ok ? "ok" : "bad"}`}>
                {parsed ? (parsed.ok ? "true" : "false") : "—"}
              </span>
              <span className="value mono">{parsed ? reasonLabel(parsed.reason) : ""}</span>
            </span>
          </div>
          <div className="stat">
            <span className="label">USDG solvent</span>
            {usdgHomeOnly ? (
              <span className="value muted-text">home chain only (Robinhood)</span>
            ) : (
              <span className="row">
                <span className={`pill ${parsedUsdg?.ok ? "ok" : "bad"}`}>
                  {parsedUsdg ? (parsedUsdg.ok ? "true" : "false") : "—"}
                </span>
                <span className="value mono">{parsedUsdg ? reasonLabel(parsedUsdg.reason) : ""}</span>
              </span>
            )}
          </div>
          <div className="stat wide">
            <span className="label">Oracle</span>
            <span className="value mono">{addrLink(oracle)}</span>
          </div>
          <div className="stat wide">
            <span className="label">Reserve wallet</span>
            <span className="value mono">{addrLink(dep?.reserveWallet)}</span>
          </div>
          <button type="button" className="ghost" onClick={() => void refreshDep()}>
            Reload deployment
          </button>
        </div>
      </header>

      {loadError && (
        <div className="banner warn">
          {loadError} Start Hardhat node, then <code>npm run demo:setup</code>.
        </div>
      )}

      {!isLocal && scene >= 4 && scene <= 7 && (
        <div className="banner warn">
          Scenes 4–7 change chain state (drain, multiplier, time warp, dispute), so they are scripted
          against <strong>Local Hardhat</strong>. On {net.label} this panel shows the live status.
        </div>
      )}

      <nav className="stepper" aria-label="Demo scenes">
        {SCENES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={scene === s.id ? "step active" : "step"}
            onClick={() => {
              setScene(s.id);
              setActionLog(null);
              setVerifyMsg(null);
            }}
          >
            <span className="num">{s.id}</span>
            <span className="stitle">{s.title}</span>
          </button>
        ))}
      </nav>

      <main className="scene">
        <h2>
          Scene {current.id}: {current.title}
        </h2>
        <p className="blurb">{current.blurb}</p>

        {scene === 1 && (
          <div className="actions">
            <button type="button" className="primary" onClick={() => void runScene1()}>
              Check exclusive wallet claim
            </button>
            <p className="hint">
              Operator path: <code>npm run demo:prepare -- --scene 1</code> (or SCENE=1).
            </p>
          </div>
        )}

        {scene === 2 && (
          <div className="actions">
            <p className="hint">
              After <code>cli:build</code> → <code>ops:publish</code> → <code>ops:sample</code>, this
              panel should show <strong>isSolvent true / OK</strong> with epoch{" "}
              {epochId ? String(epochId) : "—"}.
            </p>
            <dl className="kv">
              <dt>Epoch</dt>
              <dd className="mono">{epochId ? String(epochId) : "—"}</dd>
              <dt>Root</dt>
              <dd className="mono">{epochData?.liabilityRoot ? short(epochData.liabilityRoot) : "—"}</dd>
              <dt>Allocation</dt>
              <dd className="mono">{epochData?.allocation?.toString() ?? "—"}</dd>
              <dt>Total liability</dt>
              <dd className="mono">{epochData?.totalLiability?.toString() ?? "—"}</dd>
            </dl>
            <button type="button" className="ghost" onClick={() => void refetchStatus()}>
              Refresh solvency
            </button>
          </div>
        )}

        {scene === 3 && (
          <div className="actions">
            <div className="row">
              {(["stock", "usdg"] as AssetKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={balAsset === k ? "step active" : "step"}
                  onClick={() => {
                    setBalAsset(k);
                    setBalResult(null);
                    setBalError(null);
                  }}
                >
                  {ASSET_META[k].label}
                </button>
              ))}
            </div>
            <label className="field">
              <span>Your address</span>
              <input
                value={balAddr}
                onChange={(e) => setBalAddr(e.target.value)}
                spellCheck={false}
                placeholder="0x…"
              />
            </label>
            <div className="row">
              <button type="button" className="ghost" onClick={fillDemoUser}>
                Try demo user
              </button>
              {isConnected && address && (
                <button type="button" className="ghost" onClick={() => setBalAddr(address)}>
                  Use my wallet
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={balBusy}
                onClick={() => void runBalanceCheck()}
              >
                {balBusy ? "Checking…" : "Verify my balance"}
              </button>
            </div>
            {balError && <p className="result bad">{balError}</p>}
            {balResult && (
              <div className="verify-card">
                <p className={`result ${balResult.verified ? "" : "bad"}`}>
                  {balResult.verified
                    ? `✓ ${short(balResult.user)} holds ${fmt(balResult.amount, balResult.asset)} in epoch ${balResult.epochId}, proven against the on-chain root.`
                    : !balResult.rootMatches
                      ? "✗ The published book does not rebuild to the on-chain root, so this UI's copy is out of date."
                      : `✗ ${short(balResult.user)} is not in the ${ASSET_META[balResult.asset].label} book for epoch ${balResult.epochId}.`}
                </p>
                <dl className="kv">
                  <dt>Epoch</dt>
                  <dd className="mono">{balResult.epochId}</dd>
                  <dt>Computed root</dt>
                  <dd className="mono">{balResult.computedRoot}</dd>
                  <dt>On-chain root</dt>
                  <dd className="mono">
                    {balResult.onchainRoot} {balResult.rootMatches ? "✓" : "✗"}
                  </dd>
                  {balResult.found && (
                    <>
                      <dt>Proof path</dt>
                      <dd>
                        <ol className="proof-path">
                          {balResult.proof.map((p, i) => (
                            <li key={i} className="mono">
                              {p.isLeft ? "left " : "right"} sibling {short(p.hash)} · sum{" "}
                              {fmt(BigInt(p.sum), balResult.asset)}
                            </li>
                          ))}
                        </ol>
                      </dd>
                    </>
                  )}
                </dl>
                {balResult.found && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setProofText(
                        JSON.stringify(
                          {
                            user: balResult.user,
                            amount: balResult.amount.toString(),
                            proof: balResult.proof.map((p) => ({ ...p, sum: String(p.sum) })),
                          },
                          null,
                          2
                        )
                      )
                    }
                  >
                    Export as proof JSON
                  </button>
                )}
              </div>
            )}
            <details className="advanced">
              <summary>Advanced: paste a CLI proof JSON</summary>
              <label className="field">
                <span>out/&lt;network&gt;/&lt;asset&gt;/proofs/&lt;address&gt;.json</span>
                <textarea
                  value={proofText}
                  onChange={(e) => setProofText(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder='{"user":"0x…","amount":"…","proof":[{...}]}'
                />
              </label>
              <button type="button" className="primary" onClick={() => void runVerify()}>
                Verify pasted proof
              </button>
              {verifyMsg && <p className="result">{verifyMsg}</p>}
            </details>
          </div>
        )}

        {scene === 4 && (
          <div className="actions">
            <p className="hint">
              Drain reserves locally: <code>SCENE=4 npm run demo:prepare</code>, then try payout.
            </p>
            <button type="button" className="primary" onClick={() => void tryPayout()}>
              Attempt GatedPayout
            </button>
            <p className="hint muted">
              Expect Insolvent when reason is LIVE_SHORT / UNDERCOLLATERALIZED.
            </p>
          </div>
        )}

        {scene === 5 && (
          <div className="actions">
            <p className="hint">
              <code>SCENE=5 npm run demo:prepare</code> calls <code>setUIMultiplierNow</code> on the mock
              stock token. Status should become <strong>MULTIPLIER_DRIFT</strong>.
            </p>
            <button type="button" className="ghost" onClick={() => void refetchStatus()}>
              Refresh status
            </button>
          </div>
        )}

        {scene === 6 && (
          <div className="actions">
            <p className="hint">
              The UI cannot warp chain time. Run{" "}
              <code>npm run demo:warp</code> (or <code>SCENE=6 npm run demo:prepare</code>) against the
              local Hardhat node, then refresh. Expect <strong>STALE</strong>.
            </p>
            <button type="button" className="ghost" onClick={() => void refetchStatus()}>
              Refresh status
            </button>
          </div>
        )}

        {scene === 7 && (
          <div className="actions">
            <p className="hint">
              <code>SCENE=7 npm run demo:prepare</code> opens a mismatch dispute with a signed statement.
              Expect <strong>DISPUTED</strong>.
            </p>
            <button type="button" className="ghost" onClick={() => void refetchStatus()}>
              Refresh status
            </button>
          </div>
        )}

        {scene === 8 && (
          <div className="actions">
            <dl className="kv">
              <dt>Bond posted</dt>
              <dd className="mono">{exitInfo ? fmt(exitInfo.bondBalance, "usdg") : "…"}</dd>
              <dt>Bond in flight</dt>
              <dd className="mono">{exitInfo ? fmt(exitInfo.bondInFlight, "usdg") : "…"}</dd>
              <dt>Bond per claim</dt>
              <dd className="mono">
                {exitInfo ? (exitInfo.configured ? fmt(exitInfo.perClaim, "usdg") : "not configured") : "…"}
              </dd>
              <dt>Payout window</dt>
              <dd className="mono">
                {exitInfo?.configured ? `${Number(exitInfo.payoutDelay) / 3600} h` : "—"}
              </dd>
              <dt>Claims opened</dt>
              <dd className="mono">{exitInfo ? String(exitInfo.claimCount) : "…"}</dd>
              <dt>Exit default (mTSLA)</dt>
              <dd className="mono">{exitInfo ? (exitInfo.exitDefault ? "YES — permanent" : "no") : "…"}</dd>
              {exitInfo?.last && (
                <>
                  <dt>Last claim</dt>
                  <dd className="mono">
                    #{String(exitInfo.last.id)} · {short(exitInfo.last.user)} ·{" "}
                    {fmt(exitInfo.last.amount, "stock")} ·{" "}
                    {exitInfo.last.settled ? "settled ✓" : exitInfo.last.slashed ? "slashed ✗" : "open"}
                  </dd>
                </>
              )}
            </dl>
            {net.books.exitright ? (
              <dl className="kv">
                <dt>openClaim tx</dt>
                <dd className="mono">{txLink(net.books.exitright.txs.openClaim)}</dd>
                <dt>settle tx</dt>
                <dd className="mono">{txLink(net.books.exitright.txs.settle)}</dd>
                <dt>Recorded</dt>
                <dd className="mono">{net.books.exitright.recordedAt.slice(0, 10)}</dd>
              </dl>
            ) : (
              <p className="hint">
                {isLocal ? (
                  <>
                    Run <code>npx hardhat run scripts/exitright-setup.ts --network localhost</code> then{" "}
                    <code>scripts/exitright-demo.ts</code>.
                  </>
                ) : (
                  <>The recorded claim-and-settle round-trip runs on Robinhood testnet.</>
                )}
              </p>
            )}
            <button type="button" className="ghost" onClick={() => void loadExit()}>
              Refresh ExitRight
            </button>
          </div>
        )}

        {actionLog && <pre className="log">{actionLog}</pre>}
      </main>

      <footer className="foot">
        <span>Contracts from deployments/{dep?.network ?? "localhost"}.json</span>
        <span className="mono">{dep?.custodianId ? short(dep.custodianId) : ""}</span>
      </footer>
    </div>
  );
}
