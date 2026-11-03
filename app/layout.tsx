import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Buffett Question Book — Close to the sources",
  description: "Explore Buffett and Munger’s circle of competence through six edited answers, original-source references, and questions of your own.",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
