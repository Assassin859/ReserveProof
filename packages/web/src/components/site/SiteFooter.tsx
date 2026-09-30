import Link from "next/link";
import { GITHUB_URL } from "@/lib/deployments";
import { GithubIcon, LogoMark } from "./icons";

const COLUMNS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Live demo", href: "/#demo" },
      { label: "Verify every claim", href: "/verify" },
      { label: "Mainnet radar", href: "/radar" },
      { label: "Curator risk", href: "/risk" },
      { label: "Status", href: "/status" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "Submission", href: `${GITHUB_URL}/blob/master/docs/SUBMISSION.md`, external: true },
      { label: "VERIFY.md", href: `${GITHUB_URL}/blob/master/docs/VERIFY.md`, external: true },
      { label: "Technical spec", href: `${GITHUB_URL}/blob/master/docs/technical-spec.md`, external: true },
      { label: "Pilot / GTM", href: `${GITHUB_URL}/blob/master/docs/FOUNDER-HOUSE.md`, external: true },
    ],
  },
  {
    title: "JSON feeds",
    links: [
      { label: "/api/verify", href: "/api/verify", external: true },
      { label: "/api/status", href: "/api/status", external: true },
      { label: "/api/radar", href: "/api/radar", external: true },
      { label: "/api/risk", href: "/api/risk?network=robinhoodTestnet", external: true },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border/60 bg-card/30">
      <div className="container grid gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="space-y-3">
          <Link href="/" className="flex items-center gap-2 font-display text-lg font-semibold">
            <LogoMark className="h-6 w-6" /> ReserveProof
          </Link>
          <p className="max-w-xs text-sm text-muted-foreground">
            Proof of reserves and proof of exit for USDG and Robinhood Stock Tokens, shipped as one fail-closed modifier:{" "}
            <code className="font-mono text-xs text-foreground">onlySolvent(asset)</code>.
          </p>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <GithubIcon className="h-4 w-4" /> Assassin859/ReserveProof
          </a>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title}>
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground/80">{c.title}</p>
            <ul className="space-y-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  {l.external ? (
                    <a href={l.href} target="_blank" rel="noreferrer" className="text-sm text-muted-foreground hover:text-primary">
                      {l.label}
                    </a>
                  ) : (
                    <Link href={l.href} className="text-sm text-muted-foreground hover:text-primary">
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/50">
        <div className="container flex flex-col gap-2 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>MIT licensed · Robinhood Chain testnet and Arbitrum Sepolia · fork-only on mainnet today</span>
          <span>Built for Arbitrum Open House Singapore</span>
        </div>
      </div>
    </footer>
  );
}
