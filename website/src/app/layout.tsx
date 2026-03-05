import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Plumb — AI Memory Infrastructure",
  description:
    "Persistent, local-first memory for AI agents. Automatic ingestion. Confidence-scored facts. MCP-native.",
  openGraph: {
    title: "Plumb — AI Memory Infrastructure",
    description: "Persistent, local-first memory for AI agents.",
    url: "https://plumb.run",
    siteName: "Plumb",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Plumb — AI Memory Infrastructure",
    description: "Persistent, local-first memory for AI agents.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans bg-background text-text-primary antialiased`}>
        {children}
      </body>
    </html>
  );
}
