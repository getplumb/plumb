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
        // Plumb design system
        background: "#0A0A0A",
        surface: "#111111",
        border: "#1F1F1F",
        "border-subtle": "#181818",
        "text-primary": "#F5F5F5",
        "text-secondary": "#A1A1AA",
        "text-muted": "#52525B",
        accent: "#6366F1",        // indigo — "depth" brand accent
        "accent-hover": "#818CF8",
        "accent-dim": "#6366F120",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "GeistMono", "ui-monospace", "monospace"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "hero-glow": "radial-gradient(ellipse 80% 50% at 50% -20%, #6366F118, transparent)",
      },
    },
  },
  plugins: [],
};

export default config;
