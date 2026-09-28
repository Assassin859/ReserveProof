import type { Metadata } from "next";
import { Providers } from "../components/Providers";
import "./globals.css";

const title = "ReserveProof: live proof of reserves";
const description =
  "Proof that your custodian actually holds your stocks and dollars. On-chain reserves, Merkle-sum liabilities and a fail-closed isSolvent oracle on Robinhood Chain and Arbitrum, with a gas-free what-if simulator.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://reserveproof-teal.vercel.app"),
  title,
  description,
  openGraph: {
    title,
    description,
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
