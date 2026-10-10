import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { THEME_SCRIPT } from "@/lib/theme-script";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", weight: ["400", "500", "600"] });
const instrument = Instrument_Serif({ subsets: ["latin"], variable: "--font-instrument", display: "swap", weight: "400" });

export const metadata: Metadata = {
  title: { default: "Aangan Studio - Enquiry Desk", template: "%s | Aangan Studio" },
  description: "Management view of Aangan Studio's AI phone enquiry qualification.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#111316" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${instrument.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
