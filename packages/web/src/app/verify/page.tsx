import type { Metadata } from "next";
import { VerifyView } from "../../components/VerifyView";

const title = "Verify: check every ReserveProof claim yourself";
const description =
  "Every claim in the ReserveProof submission, checked live: CI tests, source-verified contracts, solvent proofs on both testnets, the same root on both chains, an in-browser balance proof, ExitRight settlement, scheduled publishing, live mainnet numbers and the daily Morpho fork drill.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/verify" },
  openGraph: { title, description, url: "/verify", type: "website", siteName: "ReserveProof" },
};

export default function VerifyPage() {
  return <VerifyView />;
}
