import type { Metadata } from "next";
import { Providers } from "../components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kopi Wallet · ReserveProof",
  description: "Fail-closed proof of reserves demo for USDG and stock-token custodians",
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
