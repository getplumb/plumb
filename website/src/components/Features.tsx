"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import {
  DollarSign,
  TrendingUp,
  FolderOpen,
  Server,
  Share2,
  Database,
} from "lucide-react";

const FEATURES = [
  {
    icon: DollarSign,
    title: "Stop paying to read your own chat logs.",
    body: "Injecting flat files destroys your context window and spikes API costs. Plumb writes high-signal facts as your agent works and injects only what's necessary — semantic search, not grep.",
    accent: "text-yellow-400",
    glow: "group-hover:shadow-[0_0_20px_#facc1508]",
  },
  {
    icon: TrendingUp,
    title: "Memory that actually scales past Day 30.",
    body: "Flat-file memory degrades rapidly as context grows. Plumb ensures an agent with 10,000 memories is just as fast and focused as one with 10. SQLite + sqlite-vec means O(log n) retrieval no matter how long you use it.",
    accent: "text-accent",
    glow: "group-hover:shadow-[0_0_20px_#00d4ff08]",
  },
  {
    icon: FolderOpen,
    title: "Already using MEMORY.md? You're already set.",
    body: "On first activation, Plumb reads your existing workspace .md files — MEMORY.md, daily logs, notes — and seeds the vector store automatically. Zero migration work. Hundreds of facts from day one.",
    accent: "text-blue-400",
    glow: "group-hover:shadow-[0_0_20px_#3b82f608]",
  },
  {
    icon: Server,
    title: "Stateless agents. Stateful memory.",
    body: "Your memory lives in a portable SQLite database — not baked into your config files. Back it up, move it between machines, or upgrade to Plumb Cloud for zero-setup cross-device sync.",
    accent: "text-green-400",
    glow: "group-hover:shadow-[0_0_20px_#22c55e08]",
  },
  {
    icon: Share2,
    title: "One brain across every tool.",
    body: "Switch from OpenClaw to Claude Code, or move from your laptop to a home server. They all share the exact same memory store via MCP — your context follows you everywhere.",
    accent: "text-orange-400",
    glow: "group-hover:shadow-[0_0_20px_#f9731608]",
  },
  {
    icon: Database,
    title: "Structured like a DB. Readable like a file.",
    body: "View, edit, and delete any stored memory via the CLI or local UI. Facts are plain-text and human-readable by design — no opaque embeddings, no black boxes. You are always in complete control.",
    accent: "text-pink-400",
    glow: "group-hover:shadow-[0_0_20px_#ec489908]",
  },
];

export default function Features() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.1 });

  return (
    <section ref={ref} className="py-24 md:py-32 border-t border-border">
      <div className="mx-auto max-w-7xl px-6">

        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="mb-16 text-center"
        >
          <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase mb-3">Why Plumb</p>
          <h2 className="text-3xl font-bold text-text-primary md:text-4xl">
            Built for people who actually use their agents every day.
          </h2>
          <p className="mt-4 text-text-secondary max-w-xl mx-auto">
            No magic. No black boxes. Just structured memory that behaves exactly like you'd expect.
          </p>
        </motion.div>

        {/* Feature grid */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feat, i) => {
            const Icon = feat.icon;
            return (
              <motion.div
                key={feat.title}
                initial={{ opacity: 0, y: 24 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.45, delay: 0.05 * i }}
                className={`group relative rounded-xl border border-border bg-surface p-6 transition-all duration-300 hover:border-border hover:bg-surface-2 ${feat.glow}`}
              >
                {/* Subtle top glow line */}
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />

                {/* Icon */}
                <div className="mb-4 inline-flex items-center justify-center rounded-lg border border-border bg-surface-2 p-2.5">
                  <Icon size={18} className={feat.accent} />
                </div>

                {/* Title */}
                <h3 className="mb-2 text-[15px] font-semibold text-text-primary leading-snug">
                  {feat.title}
                </h3>

                {/* Body */}
                <p className="text-sm leading-relaxed text-text-secondary">
                  {feat.body}
                </p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
