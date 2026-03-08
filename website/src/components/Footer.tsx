import { Github, Twitter, MessageCircle } from "lucide-react";

const NAV_LINKS = [
  { label: "Docs", href: "/docs" },
  { label: "GitHub", href: "https://github.com/getplumb/plumb" },
  { label: "Pricing", href: "#pricing" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
];

const SOCIAL_LINKS = [
  {
    icon: Twitter,
    label: "Twitter / X",
    href: "https://twitter.com/plumbrun",
  },
  {
    icon: Github,
    label: "GitHub",
    href: "https://github.com/getplumb/plumb",
  },
  {
    icon: MessageCircle,
    label: "Discord",
    href: "https://discord.com/invite/clawd",
  },
];

function PlumbWordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg
        width="18"
        height="18"
        viewBox="0 0 22 22"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="8" y="2" width="6" height="18" rx="1.5" fill="#00d4ff" opacity="0.9" />
        <rect x="2" y="9" width="18" height="4" rx="1.5" fill="#00d4ff" opacity="0.4" />
        <circle cx="11" cy="11" r="2" fill="#00d4ff" />
      </svg>
      <span className="text-sm font-semibold tracking-[0.12em] text-text-primary uppercase">
        Plumb
      </span>
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-14">
        <div className="flex flex-col items-start justify-between gap-10 md:flex-row md:items-center">

          {/* Logo + tagline */}
          <div>
            <PlumbWordmark />
            <p className="mt-2 max-w-xs text-sm text-text-muted leading-relaxed">
              MCP-compliant memory infrastructure for AI agents. Local-first. Privacy-respecting. Production-ready.
            </p>
          </div>

          {/* Nav links */}
          <nav className="flex flex-wrap gap-x-8 gap-y-3">
            {NAV_LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="text-sm text-text-muted transition-colors hover:text-text-primary"
              >
                {l.label}
              </a>
            ))}
          </nav>

          {/* Social links */}
          <div className="flex items-center gap-4">
            {SOCIAL_LINKS.map((s) => {
              const Icon = s.icon;
              return (
                <a
                  key={s.label}
                  href={s.href}
                  aria-label={s.label}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-muted transition-all hover:border-accent/30 hover:text-accent hover:bg-accent-dim"
                >
                  <Icon size={16} />
                </a>
              );
            })}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
          <p className="font-mono text-xs text-text-muted">
            © {new Date().getFullYear()} Plumb. Open source under MIT License.
          </p>
          <a
            href="/docs"
            className="font-mono text-xs text-text-muted transition-colors hover:text-accent underline underline-offset-2"
          >
            → Read the Docs
          </a>
        </div>
      </div>
    </footer>
  );
}
