import type { Metadata } from "next";
import { RiskView } from "../../components/RiskView";

const title = "Curator risk: what would freeze, and when · ReserveProof";
const description =
  "Live, per chain: custodian coverage against the 103% floor, headroom, time until the proof goes stale, open disputes and exit claims, and which solvency-gated markets (including a Morpho oracle wrapper) would freeze.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/risk" },
  openGraph: { title, description, url: "/risk", type: "website", siteName: "ReserveProof" },
};

export default function RiskPage() {
  return <RiskView />;
}
