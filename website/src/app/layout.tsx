import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Plumb — Decouple your agent's memory from its prompt.",
  description:
    "Plumb is an MCP-compliant memory server that extracts, structures, and serves exactly the right context to your agents. Save tokens, stop hallucinations, and never lose context again.",
  openGraph: {
    title: "Plumb — AI Memory Infrastructure",
    description:
      "Plumb is an MCP-compliant memory server that extracts, structures, and serves exactly the right context to your agents.",
    url: "https://plumb.run",
    siteName: "Plumb",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Plumb — AI Memory Infrastructure",
    description:
      "Plumb is an MCP-compliant memory server that extracts, structures, and serves exactly the right context to your agents.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} font-sans bg-background text-text-primary antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
