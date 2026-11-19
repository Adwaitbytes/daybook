import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/footer";
import { Masthead } from "@/components/masthead";
import { deployment } from "@/lib/server/config";
import { caslon, dmMono } from "./fonts";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "Daybook, invoices that mark themselves paid", template: "%s, Daybook" },
  description:
    "A client pays in USDC on any supported chain. One reactive contract matches the payment, issues a receipt, sets tax aside and pays the team.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f1e8" },
    { media: "(prefers-color-scheme: dark)", color: "#141b16" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const d = deployment();
  return (
    <html lang="en-GB" className={`${caslon.variable} ${dmMono.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Masthead />
        <Providers>
          <main id="main" className="flex-1">
            {children}
          </main>
        </Providers>
        <Footer reactive={d.kind === "deployed" ? d.reactive : null} />
      </body>
    </html>
  );
}
