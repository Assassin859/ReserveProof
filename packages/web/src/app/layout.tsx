import type { Metadata } from "next";
import { Providers } from "../components/Providers";
import "./globals.css";

const title = "ReserveProof: proof of reserves for USDG and Robinhood Stock Tokens";
const description =
  "Proof of reserves for USDG and Robinhood Stock Tokens on Robinhood Chain: on-chain reserves, Merkle-sum liabilities and a fail-closed isSolvent oracle that lending markets (including Morpho) can gate on, live on Robinhood Chain and Arbitrum with a gas-free what-if simulator.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://reserveproof-teal.vercel.app"),
  title,
  description,
  alternates: { canonical: "/" },
  openGraph: {
    title,
    description,
    url: "/",
    type: "website",
    siteName: "ReserveProof",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
