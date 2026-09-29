import type { Metadata } from "next";
import Link from "next/link";
import { CompareSection } from "../../components/CompareSection";
import { GITHUB_URL } from "../../lib/deployments";

const title = "Price safety vs reserve safety: ReserveProof and StockGuard";
const description =
  "Price guards stop a Morpho market lending on a price it can't trust. ReserveProof stops it lending against USDG or Robinhood Stock Tokens whose custodian can't prove its reserves or pay exits. Stack them in one constructor.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/compare" },
  openGraph: { title, description, url: "/compare", type: "website", siteName: "ReserveProof" },
};

export default function ComparePage() {
  return (
    <div className="shell">
      <header className="risk-hero">
        <p className="eyebrow">ReserveProof · how we differ</p>
        <h1 className="headline">Price safety is not reserve safety.</h1>
        <div className="cta-row">
          <Link className="ghost" href="/">
            ← Live demo
          </Link>
          <Link className="ghost" href="/risk">
            Curator risk
          </Link>
          <Link className="ghost" href="/radar">
            Mainnet radar
          </Link>
        </div>
      </header>

      <CompareSection standalone />

      <footer className="foot">
        <span>
          <Link href="/">Live demo</Link> · <Link href="/risk">Curator risk</Link> ·{" "}
          <Link href="/radar">Mainnet radar</Link> ·{" "}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>{" "}
          · MIT licensed
        </span>
      </footer>
    </div>
  );
}
