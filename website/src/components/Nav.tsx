"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export default function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        {/* Wordmark */}
        <a href="/" className="text-lg font-semibold tracking-widest text-text-primary">
          PLUMB
        </a>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-8 md:flex">
          <a
            href="https://docs.getplumb.dev"
            className="text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            Docs
          </a>
          <a
            href="https://github.com/getplumb/plumb"
            className="text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            GitHub
          </a>
          <a
            href="https://getplumb.dev/signup"
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Sign up
          </a>
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
        <div className="border-t border-border bg-surface px-6 py-4 md:hidden">
          <nav className="flex flex-col gap-4">
            <a
              href="https://docs.getplumb.dev"
              className="text-sm text-text-secondary hover:text-text-primary"
              onClick={() => setOpen(false)}
            >
              Docs
            </a>
            <a
              href="https://github.com/getplumb/plumb"
              className="text-sm text-text-secondary hover:text-text-primary"
              onClick={() => setOpen(false)}
            >
              GitHub
            </a>
            <a
              href="https://getplumb.dev/signup"
              className="inline-block w-fit rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
              onClick={() => setOpen(false)}
            >
              Sign up
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
