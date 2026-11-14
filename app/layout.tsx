import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MERIDIAN DCA | Cross-chain recurring investments",
  description:
    "Plan recurring crypto purchases across supported networks with real NEAR Intents quotes and safe dry-run previews.",
};

const refreshScrollGuard = `
  (function () {
    try {
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      var entries = performance.getEntriesByType("navigation");
      var isReload = entries.length > 0 && entries[0].type === "reload";
      if (isReload && location.hash) {
        history.replaceState(null, "", location.pathname + location.search);
      }
      if (isReload) window.scrollTo(0, 0);
    } catch (_) {}
  })();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: refreshScrollGuard }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
