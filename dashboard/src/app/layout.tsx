import type { Metadata, Viewport } from "next";
import { LinkSession } from "@/components/link-session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Commesse sito", template: "%s · Commesse sito" },
  description: "Le modifiche ai siti dei clienti chieste su WhatsApp, da approvare e seguire.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600&display=swap"
        />
      </head>
      <body>
        <LinkSession />
        {children}
      </body>
    </html>
  );
}
