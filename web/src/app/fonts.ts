import localFont from "next/font/local";

// Self-hosted from design/directions/a-ledger/fonts (SIL OFL, via @fontsource). Two families only.
export const caslon = localFont({
  src: [
    { path: "./fonts/libre-caslon-text-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/libre-caslon-text-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/libre-caslon-text-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-caslon",
  display: "swap",
  fallback: ["Iowan Old Style", "Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
});

export const dmMono = localFont({
  src: [
    { path: "./fonts/dm-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/dm-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-dm-mono",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "monospace"],
  adjustFontFallback: false,
});
