import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MERIDIAN DCA | Cross-chain recurring investments",
  description:
    "Plan recurring crypto purchases across supported chains with real NEAR Intents quotes and safe dry-run previews.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}