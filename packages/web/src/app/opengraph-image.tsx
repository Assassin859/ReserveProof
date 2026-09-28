import { ImageResponse } from "next/og";

export const runtime = "edge";

export const alt = "ReserveProof: live, on-chain proof of reserves for stock-token and USDG custodians";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #10150f 0%, #0e1012 55%, #1a1814 100%)",
          color: "#e8ecef",
          fontFamily: "Georgia, serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <path
              d="M32 9 L51 16 V31 C51 43 43 51.5 32 55 C21 51.5 13 43 13 31 V16 Z"
              fill="none"
              stroke="#c4a35a"
              strokeWidth="4"
              strokeLinejoin="round"
            />
            <path
              d="M23 32 L29.5 38.5 L41.5 25.5"
              fill="none"
              stroke="#3d9a6a"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span style={{ fontSize: 34, color: "#c4a35a", letterSpacing: 2 }}>RESERVEPROOF</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 68, lineHeight: 1.08, maxWidth: 1000 }}>
            Proof that your custodian actually holds your stocks and dollars.
          </div>
          <div style={{ fontSize: 28, color: "#8b959e", fontFamily: "sans-serif" }}>
            Live on Robinhood Chain and Arbitrum · try the what-if simulator, no wallet needed
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 24, fontFamily: "sans-serif" }}>
          {["isSolvent fails closed", "Merkle-sum liabilities", "ExitRight bonded withdrawals"].map((t) => (
            <span
              key={t}
              style={{ border: "1px solid #2c343c", borderRadius: 999, padding: "8px 20px", color: "#b9c2ca" }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    ),
    size
  );
}
