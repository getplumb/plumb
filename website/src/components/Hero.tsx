"use client";

import { motion } from "framer-motion";

export default function Hero() {
  return (
    <section className="relative overflow-hidden bg-hero-glow pt-32 pb-24 md:pt-40 md:pb-32">
      <div className="mx-auto max-w-4xl px-6 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-4xl font-bold tracking-tight text-text-primary sm:text-5xl md:text-6xl"
        >
          Memory for Agents
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mx-auto mt-6 max-w-2xl text-lg text-text-secondary md:text-xl"
        >
          Persistent context that follows your AI across sessions.
          Automatic ingestion, confidence-scored facts, zero commands needed.
        </motion.p>

        {/* Install snippet */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mx-auto mt-10 max-w-md"
        >
          <div className="rounded-lg border border-border bg-surface p-4 text-left font-mono text-sm">
            <div className="flex items-center gap-2 text-text-muted">
              <span className="text-text-secondary">$</span>
              <span className="text-text-primary">npm install -g @plumb/mcp-server</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-text-muted">
              <span className="text-text-secondary">$</span>
              <span className="text-text-primary">plumb init</span>
            </div>
          </div>

          {/* GitHub star badge */}
          <div className="mt-4 flex justify-center">
            <a href="https://github.com/getplumb/plumb" target="_blank" rel="noopener noreferrer">
              <img
                src="https://img.shields.io/github/stars/getplumb/plumb?style=flat&label=Stars&color=6366F1"
                alt="GitHub Stars"
              />
            </a>
          </div>
        </motion.div>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-8 flex flex-col items-center gap-3"
        >
          <a
            href="https://github.com/getplumb/plumb"
            className="rounded-md bg-accent px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Self-host for free
          </a>
          <p className="text-xs text-text-muted">
            Hosted version coming soon — hello@plumb.run
          </p>
        </motion.div>
      </div>
    </section>
  );
}
