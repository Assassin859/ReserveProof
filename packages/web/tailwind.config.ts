import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const hsl = (v: string) => `hsl(var(--${v}) / <alpha-value>)`;

const gold = {
  faint: "#1c1810",
  muted: "#3a3020",
  subtle: "#8a7340",
  DEFAULT: "#c4a35a",
  emphasis: "#d9bd7a",
  inverted: "#0e1012",
};

const TREMOR_COLORS = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const SHADES = "50|100|200|300|400|500|600|700|800|900|950";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}", "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: { center: true, padding: "1.25rem", screens: { "2xl": "1200px" } },
    extend: {
      colors: {
        border: hsl("border"),
        input: hsl("input"),
        ring: hsl("ring"),
        background: hsl("background"),
        foreground: hsl("foreground"),
        primary: { DEFAULT: hsl("primary"), foreground: hsl("primary-foreground") },
        secondary: { DEFAULT: hsl("secondary"), foreground: hsl("secondary-foreground") },
        destructive: { DEFAULT: hsl("destructive"), foreground: hsl("destructive-foreground") },
        success: { DEFAULT: hsl("success"), foreground: hsl("success-foreground") },
        warning: { DEFAULT: hsl("warning"), foreground: hsl("warning-foreground") },
        muted: { DEFAULT: hsl("muted"), foreground: hsl("muted-foreground") },
        accent: { DEFAULT: hsl("accent"), foreground: hsl("accent-foreground") },
        popover: { DEFAULT: hsl("popover"), foreground: hsl("popover-foreground") },
        card: { DEFAULT: hsl("card"), foreground: hsl("card-foreground") },
        tremor: {
          brand: gold,
          background: { muted: "#131719", subtle: "#1e2429", DEFAULT: "#161a1e", emphasis: "#c9d1d8" },
          border: { DEFAULT: "#2c343c" },
          ring: { DEFAULT: "#2c343c" },
          content: { subtle: "#5f6b75", DEFAULT: "#8b959e", emphasis: "#c9d1d8", strong: "#e8ecef", inverted: "#0e1012" },
        },
        "dark-tremor": {
          brand: gold,
          background: { muted: "#131719", subtle: "#1e2429", DEFAULT: "#161a1e", emphasis: "#c9d1d8" },
          border: { DEFAULT: "#2c343c" },
          ring: { DEFAULT: "#2c343c" },
          content: { subtle: "#5f6b75", DEFAULT: "#8b959e", emphasis: "#c9d1d8", strong: "#e8ecef", inverted: "#0e1012" },
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        "tremor-small": "0.375rem",
        "tremor-default": "0.5rem",
        "tremor-full": "9999px",
      },
      boxShadow: {
        "tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        "dark-tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "dark-tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "dark-tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "tremor-label": ["0.75rem", { lineHeight: "1rem" }],
        "tremor-default": ["0.875rem", { lineHeight: "1.25rem" }],
        "tremor-title": ["1.125rem", { lineHeight: "1.75rem" }],
        "tremor-metric": ["1.875rem", { lineHeight: "2.25rem" }],
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
        "border-beam": { "100%": { "offset-distance": "100%" } },
        spotlight: {
          "0%": { opacity: "0", transform: "translate(-72%, -62%) scale(0.5)" },
          "100%": { opacity: "1", transform: "translate(-50%, -40%) scale(1)" },
        },
        shimmer: { from: { backgroundPosition: "0 0" }, to: { backgroundPosition: "-200% 0" } },
        "grid-fade": {
          "0%, 100%": { opacity: "0" },
          "50%": { opacity: "1" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.8)", opacity: "0.7" },
          "80%, 100%": { transform: "scale(2.2)", opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "border-beam": "border-beam calc(var(--duration) * 1s) infinite linear",
        spotlight: "spotlight 2s ease 0.75s 1 forwards",
        shimmer: "shimmer 2.5s linear infinite",
        "pulse-ring": "pulse-ring 2s cubic-bezier(0.2, 0.6, 0.4, 1) infinite",
        "grid-fade": "grid-fade 6s ease-in-out infinite",
      },
    },
  },
  safelist: [
    { pattern: new RegExp(`^(bg-(?:${TREMOR_COLORS})-(?:${SHADES}))$`), variants: ["hover", "data-[selected]"] },
    { pattern: new RegExp(`^(text-(?:${TREMOR_COLORS})-(?:${SHADES}))$`), variants: ["hover", "data-[selected]"] },
    { pattern: new RegExp(`^(border-(?:${TREMOR_COLORS})-(?:${SHADES}))$`), variants: ["hover", "data-[selected]"] },
    { pattern: new RegExp(`^(ring-(?:${TREMOR_COLORS})-(?:${SHADES}))$`) },
    { pattern: new RegExp(`^(stroke-(?:${TREMOR_COLORS})-(?:${SHADES}))$`) },
    { pattern: new RegExp(`^(fill-(?:${TREMOR_COLORS})-(?:${SHADES}))$`) },
  ],
  plugins: [animate],
};

export default config;
