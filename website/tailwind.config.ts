import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#080808",
        surface: "#0f0f0f",
        "surface-2": "#141414",
        border: "#1c1c1c",
        "border-subtle": "#161616",
        "text-primary": "#f0f0f0",
        "text-secondary": "#a1a1aa",
        "text-muted": "#52525b",
        accent: "#00d4ff",         // electric cyan — sharp, terminal-ish
        "accent-hover": "#33ddff",
        "accent-dim": "#00d4ff14",
        "accent-glow": "#00d4ff30",
        green: "#22c55e",
        "green-dim": "#22c55e20",
        red: "#ef4444",
        "red-dim": "#ef444420",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "GeistMono", "ui-monospace", "monospace"],
      },
      backgroundImage: {
        "hero-glow":
          "radial-gradient(ellipse 70% 40% at 50% -10%, #00d4ff0d, transparent)",
        "card-gradient":
          "linear-gradient(135deg, #0f0f0f 0%, #111 100%)",
      },
      boxShadow: {
        "accent-sm": "0 0 12px #00d4ff22",
        "accent-md": "0 0 24px #00d4ff33",
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
