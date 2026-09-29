import type { Metadata } from "next";
import { CompareSection } from "../../components/CompareSection";
import { PageHeader } from "../../components/site/PageHeader";

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
    <>
      <PageHeader
        eyebrow="ReserveProof · how we differ"
        title="Price safety is not reserve safety."
        lede="A price guard can't see a perfectly priced token whose custodian has sold the stock behind it. ReserveProof can, and it doesn't judge the price, so the two stack in one constructor."
      />
      <div className="container py-12">
        <CompareSection standalone />
      </div>
    </>
  );
}
