"use client";

import { useState, useEffect } from "react";
import posthog from "posthog-js";
import { cn } from "@/lib/cn";
import { INSTALL_PROMPT } from "@/lib/constants";

function PlumbLogo() {
  return (
    <a href="/" className="flex items-center gap-2.5 group">
      {/* Geometric pipe icon */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 22 22"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="transition-all duration-200 group-hover:drop-shadow-[0_0_6px_#00d4ff]"
      >
        {/* Vertical pipe */}
        <rect x="8" y="2" width="6" height="18" rx="1.5" fill="#00d4ff" opacity="0.9" />
        {/* Horizontal bar (plumb bob / level) */}
        <rect x="2" y="9" width="18" height="4" rx="1.5" fill="#00d4ff" opacity="0.4" />
        {/* Center dot */}
        <circle cx="11" cy="11" r="2" fill="#00d4ff" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[0.12em] text-text-primary uppercase">
        Plumb
      </span>
    </a>
  );
}

export default function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_PROMPT).then(() => {
      setCopied(true);
      posthog.capture("add_to_openclaw_clicked", { location: "nav" });
      setTimeout(() => setCopied(false), 2000);
    });
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const links = [
    { label: "GitHub", href: "https://github.com/getplumb/plumb" },
    { label: "Pricing", href: "#pricing" },
  ];

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-border bg-background/90 backdrop-blur-md"
          : "bg-transparent"
      )}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <PlumbLogo />

        {/* Desktop nav */}
        <nav className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target={l.href.startsWith("http") ? "_blank" : undefined}
              rel={l.href.startsWith("http") ? "noopener noreferrer" : undefined}
              className="text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              {l.label}
            </a>
          ))}
          <button
            onClick={handleCopy}
            className="rounded-md border border-accent bg-accent-dim px-4 py-2 text-sm font-medium text-accent transition-all hover:bg-accent-glow hover:shadow-accent-sm"
          >
            {copied ? "Copied! Paste in OpenClaw to install." : "Add to OpenClaw"}
          </button>
        </nav>

        {/* Mobile hamburger */}
        <button
          className="flex flex-col gap-1.5 p-1 md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          <span
            className={cn(
              "block h-0.5 w-5 bg-text-secondary transition-transform duration-200",
              open && "translate-y-2 rotate-45"
            )}
          />
          <span
            className={cn(
              "block h-0.5 w-5 bg-text-secondary transition-opacity duration-200",
              open && "opacity-0"
            )}
          />
          <span
            className={cn(
              "block h-0.5 w-5 bg-text-secondary transition-transform duration-200",
              open && "-translate-y-2 -rotate-45"
            )}
          />
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-border bg-surface px-6 py-5 md:hidden">
          <nav className="flex flex-col gap-5">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="text-sm text-text-secondary hover:text-text-primary"
                onClick={() => setOpen(false)}
              >
                {l.label}
              </a>
            ))}
            <button
              onClick={() => { handleCopy(); setOpen(false); }}
              className="w-full rounded-md border border-accent bg-accent-dim px-4 py-2.5 text-center text-sm font-medium text-accent"
            >
              {copied ? "Copied! Paste in OpenClaw to install." : "Add to OpenClaw"}
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}
