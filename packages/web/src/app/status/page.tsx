import type { Metadata } from "next";
import { StatusView } from "../../components/StatusView";

const title = "Status: ReserveProof proofs, publisher and watchtower";
const description =
  "Live health of every ReserveProof custody proof on Robinhood testnet and Arbitrum Sepolia, the Morpho oracle wrapper, the every-3-days epoch publisher, the hourly watchtower and the publisher's gas.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/status" },
  openGraph: { title, description, url: "/status", type: "website", siteName: "ReserveProof" },
};

export default function StatusPage() {
  return <StatusView />;
}
