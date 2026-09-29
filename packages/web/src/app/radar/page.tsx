import type { Metadata } from "next";
import { RadarView } from "../../components/RadarView";

const title = "Mainnet radar: which Morpho markets ReserveProof would gate";
const description =
  "Every Morpho Blue market on Robinhood Chain mainnet, read live: which ones lend against USDG or issuer-listed Robinhood Stock Tokens (and would freeze on a failed custody proof), which are copycats to reject, and which have pending corporate actions, multiplier mismatches or outlier oracle prices.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/radar" },
  openGraph: { title, description, url: "/radar", type: "website", siteName: "ReserveProof" },
};

export default function RadarPage() {
  return <RadarView />;
}
