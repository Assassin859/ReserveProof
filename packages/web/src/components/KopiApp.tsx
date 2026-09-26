"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useReadContract,
  usePublicClient,
  useWriteContract,
  useAccount,
  useConnect,
} from "wagmi";
import type { Address, Hex } from "viem";
import {
  custodianRegistryAbi,
  solvencyOracleAbi,
  liabilityLedgerAbi,
  gatedPayoutAbi,
} from "../lib/abis";
import { verifyInclusion, type ProofNode } from "../lib/merkle";
import { reasonLabel } from "../lib/reasons";
import { SCENES, type Deployment } from "../lib/types";

function short(addr?: string) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function KopiApp() {
  const [dep, setDep] = useState<Deployment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scene, setScene] = useState(1);
  const [proofText, setProofText] = useState("");
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const refreshDep = useCallback(async () => {
    try {
      const res = await fetch("/api/deployment");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load deployment");
      setDep(data);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshDep();
  }, [refreshDep]);

  const custodianId = dep?.custodianId;
  const asset = dep?.contracts.MockStockToken;
  const oracle = dep?.contracts.SolvencyOracle;
  const registry = dep?.contracts.CustodianRegistry;
  const ledger = dep?.contracts.LiabilityLedger;
  const gated = dep?.contracts.GatedPayout;

  const { data: status, refetch: refetchStatus } = useReadContract({
    address: oracle,
    abi: solvencyOracleAbi,
    functionName: "status",
    args: custodianId && asset ? [custodianId, asset] : undefined,
    query: { enabled: Boolean(oracle && custodianId && asset), refetchInterval: 4000 },
  });

  const { data: epochId } = useReadContract({
    address: ledger,
    abi: liabilityLedgerAbi,
    functionName: "latestEpochId",
    args: custodianId && asset ? [custodianId, asset] : undefined,
    query: { enabled: Boolean(ledger && custodianId && asset) },
  });

  const { data: epoch } = useReadContract({
    address: ledger,
    abi: liabilityLedgerAbi,
    functionName: "getEpoch",
    args:
      custodianId && asset && epochId
        ? [custodianId, asset, epochId]
        : undefined,
    query: { enabled: Boolean(ledger && custodianId && asset && epochId && Number(epochId) > 0) },
  });

  const statusTuple = status as
    | { ok: boolean; epochId: bigint; updatedAt: bigint; reason: number }
    | readonly [boolean, bigint, bigint, number]
    | undefined;

  const parsed = useMemo(() => {
    if (!statusTuple) return null;
    if (Array.isArray(statusTuple)) {
      return {
        ok: statusTuple[0] as boolean,
        epochId: statusTuple[1] as bigint,
        updatedAt: statusTuple[2] as bigint,
        reason: Number(statusTuple[3]),
      };
    }
    const s = statusTuple as {
      ok: boolean;
      epochId: bigint;
      updatedAt: bigint;
      reason: number;
    };
    return {
      ok: s.ok,
      epochId: s.epochId,
      updatedAt: s.updatedAt,
      reason: Number(s.reason),
    };
  }, [statusTuple]);

  const epochData = useMemo(() => {
    if (!epoch) return null;
    if (Array.isArray(epoch)) {
      return {
        liabilityRoot: epoch[0] as Hex,
        totalLiability: epoch[1] as bigint,
        allocation: epoch[2] as bigint,
        exists: epoch[6] as boolean,
      };
    }
    const e = epoch as {
      liabilityRoot: Hex;
      totalLiability: bigint;
      allocation: bigint;
      exists: boolean;
    };
    return e;
  }, [epoch]);

  async function runScene1() {
    if (!dep || !registry || !publicClient) return;
    setActionLog("Simulating duplicate addReserveWallet…");
    try {
      const chainId = BigInt(dep.chainId);
      // static call will fail without a real signature — use walletOwner read instead
      const owner = await publicClient.readContract({
        address: registry,
        abi: custodianRegistryAbi,
        functionName: "walletOwner",
        args: [chainId, dep.reserveWallet as Address],
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
    if (!dep || !epochData?.exists) {
      setVerifyMsg("No committed epoch — run ops:publish + ops:sample first.");
      return;
    }
    try {
      const parsedProof = JSON.parse(proofText) as {
        user: string;
        amount: string;
        proof: ProofNode[];
      };
      const ok = verifyInclusion({
        custodianId: dep.custodianId,
        asset: dep.contracts.MockStockToken,
        epochId: Number(epochId),
        user: parsedProof.user as Address,
        amount: BigInt(parsedProof.amount),
        root: epochData.liabilityRoot,
        totalSum: epochData.totalLiability,
        siblings: parsedProof.proof,
      });
      setVerifyMsg(
        ok
          ? `Inclusion verified for ${short(parsedProof.user)} — amount ${parsedProof.amount}`
          : "Proof does NOT match on-chain root / total."
      );
    } catch (e) {
      setVerifyMsg(`Invalid proof JSON: ${(e as Error).message}`);
    }
  }

  async function tryPayout() {
    if (!gated) {
      setActionLog("GatedPayout not in deployment JSON.");
      return;
    }
    if (!isConnected) {
      const c = connectors[0];
      if (c) connect({ connector: c });
      setActionLog("Connect a wallet (Hardhat account) then retry payout.");
      return;
    }
    try {
      await writeContractAsync({
        address: gated,
        abi: gatedPayoutAbi,
        functionName: "payout",
        args: [address as Address, BigInt(1)],
      });
      setActionLog("Payout succeeded (unexpected if insolvent).");
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setActionLog(`Payout blocked: ${err.shortMessage || err.message}`);
    }
    void refetchStatus();
  }

  const current = SCENES.find((s) => s.id === scene)!;

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
          <div className="stat">
            <span className="label">Network</span>
            <span className="value">{dep?.network ?? "…"} · {dep?.chainId ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="label">Custodian</span>
            <span className="value mono">{dep?.custodianName ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="label">isSolvent</span>
            <span className={`pill ${parsed?.ok ? "ok" : "bad"}`}>
              {parsed ? (parsed.ok ? "true" : "false") : "—"}
            </span>
          </div>
          <div className="stat">
            <span className="label">reason</span>
            <span className="value mono">{parsed ? reasonLabel(parsed.reason) : "—"}</span>
          </div>
          <div className="stat wide">
            <span className="label">Oracle</span>
            <span className="value mono">{short(oracle)}</span>
          </div>
          <div className="stat wide">
            <span className="label">Asset</span>
            <span className="value mono">{short(asset)}</span>
          </div>
          <button type="button" className="ghost" onClick={() => void refreshDep()}>
            Reload deployment
          </button>
        </div>
      </header>

      {loadError && (
        <div className="banner warn">
          {loadError} Start Hardhat node, then <code>npm run demo:deploy</code>.
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
            <label className="field">
              <span>CLI proof JSON (out/proofs/&lt;address&gt;.json)</span>
              <textarea
                value={proofText}
                onChange={(e) => setProofText(e.target.value)}
                rows={10}
                spellCheck={false}
                placeholder='{"user":"0x…","amount":"…","proof":[{...}]}'
              />
            </label>
            <button type="button" className="primary" onClick={() => void runVerify()}>
              Verify inclusion
            </button>
            {verifyMsg && <p className="result">{verifyMsg}</p>}
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

        {actionLog && <pre className="log">{actionLog}</pre>}
      </main>

      <footer className="foot">
        <span>Contracts from deployments/{dep?.network ?? "localhost"}.json</span>
        <span className="mono">{dep?.custodianId ? short(dep.custodianId) : ""}</span>
      </footer>
    </div>
  );
}
