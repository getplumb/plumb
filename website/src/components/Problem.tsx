"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { X, Check, TrendingDown, TrendingUp } from "lucide-react";

const OLD_MEMORY_LINES = [
  { text: "# MEMORY.md — Clay's Long-Term Memory", class: "text-text-muted" },
  { text: "", class: "" },
  { text: "## Critical Operational Rules", class: "text-text-muted" },
  { text: "- Primary channel: Slack. Telegram = fallback", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "- Reminders: Slack #reminders (C0AHAMP6ZLN)", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "- CC claywaters13@gmail.com on external emails", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "- LinkedIn: NEVER send without explicit approval", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "", class: "" },
  { text: "## Sub-Agent Defaults", class: "text-text-muted" },
  { text: "- Timeout: 600s (900s for browser tasks)", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "- Model: Claude Haiku 4.5 for sub-agents", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "- Default: anthropic/claude-haiku-4-5", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "", class: "" },
  { text: "## Key Tool Locations", class: "text-text-muted" },
  { text: "- Notion task DB: a50b0f76-4900...", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "- Career facts: clay_career_facts.md", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "- Full memory: memory/MEMORY_FULL_BACKUP.md", class: "text-red-400 line-through decoration-red-500/60", waste: true },
  { text: "... 847 more lines ...", class: "text-text-muted italic" },
];

const NEW_FACTS = [
  { subject: "agent.channel", predicate: "primary", object: "slack", score: 0.99, tag: "RULE" },
  { subject: "subagent.timeout", predicate: "default_ms", object: "600000", score: 0.99, tag: "CONFIG" },
  { subject: "subagent.model", predicate: "default", object: "claude-haiku-4-5", score: 0.97, tag: "CONFIG" },
  { subject: "email.cc_rule", predicate: "external_mail", object: "claywaters13@gmail.com", score: 0.99, tag: "RULE" },
  { subject: "notion.tasks_db", predicate: "id", object: "a50b0f76-4900-431e", score: 0.95, tag: "TOOL" },
  { subject: "linkedin", predicate: "send_policy", object: "require_explicit_approval", score: 0.99, tag: "RULE" },
];

const TAG_COLORS: Record<string, string> = {
  RULE: "text-[#f97316] bg-[#f9731612]",
  CONFIG: "text-accent bg-accent-dim",
  TOOL: "text-purple-400 bg-purple-400/10",
};

export default function Problem() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.2 });

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
          <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase mb-3">The Problem</p>
          <h2 className="text-3xl font-bold text-text-primary md:text-4xl">
            Flat files don't scale. Knowledge graphs do.
          </h2>
          <p className="mt-4 text-text-secondary max-w-xl mx-auto">
            Every token you spend loading stale context is a token you can't spend solving the actual problem.
          </p>
        </motion.div>

        {/* Side-by-side comparison */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

          {/* Left: Old Way */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={inView ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="rounded-xl border border-red-500/20 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 bg-red-500/5 border-b border-red-500/20">
              <div className="flex items-center gap-2">
                <X size={14} className="text-red-400" />
                <span className="font-mono text-sm text-red-400">MEMORY.md</span>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-red-500/10 px-2.5 py-0.5">
                <TrendingUp size={12} className="text-red-400" />
                <span className="text-xs text-red-400 font-mono">~12,400 tokens injected</span>
              </div>
            </div>
            {/* Content */}
            <div className="bg-surface px-5 py-5 font-mono text-[13px] overflow-hidden max-h-[360px]">
              {OLD_MEMORY_LINES.map((line, i) => (
                <div key={i} className={`leading-6 ${line.class} ${line.waste ? "opacity-60" : ""}`}>
                  {line.text || "\u00a0"}
                  {line.waste && (
                    <span className="ml-2 font-sans text-[10px] text-red-400/70 bg-red-400/10 px-1 py-0.5 rounded">
                      wasted
                    </span>
                  )}
                </div>
              ))}
            </div>
            {/* Footer callout */}
            <div className="px-5 py-3 bg-red-500/5 border-t border-red-500/20 flex items-center gap-2">
              <span className="text-xs text-red-400 font-mono">↳ 98% of these tokens are irrelevant to your current task.</span>
            </div>
          </motion.div>

          {/* Right: Plumb Way */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={inView ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="rounded-xl border border-accent/20 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 bg-accent-dim border-b border-accent/20">
              <div className="flex items-center gap-2">
                <Check size={14} className="text-accent" />
                <span className="font-mono text-sm text-accent">plumb.db — retrieved facts</span>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-green-dim px-2.5 py-0.5">
                <TrendingDown size={12} className="text-green-" />
                <span className="text-xs text-green-500 font-mono">~340 tokens injected</span>
              </div>
            </div>
            {/* Fact rows */}
            <div className="bg-surface divide-y divide-border">
              {/* Column headers */}
              <div className="grid grid-cols-[1fr_1fr_1fr_72px_64px] gap-2 px-5 py-2 text-[11px] font-mono text-text-muted uppercase tracking-wider">
                <span>Subject</span>
                <span>Predicate</span>
                <span>Object</span>
                <span>Tag</span>
                <span className="text-right">Score</span>
              </div>
              {NEW_FACTS.map((fact, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: 10 }}
                  animate={inView ? { opacity: 1, x: 0 } : {}}
                  transition={{ duration: 0.3, delay: 0.3 + i * 0.07 }}
                  className="grid grid-cols-[1fr_1fr_1fr_72px_64px] gap-2 px-5 py-3 font-mono text-[12px] hover:bg-surface-2 transition-colors"
                >
                  <span className="text-text-primary truncate">{fact.subject}</span>
                  <span className="text-text-muted truncate">{fact.predicate}</span>
                  <span className="text-accent truncate">{fact.object}</span>
                  <span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${TAG_COLORS[fact.tag]}`}>
                      {fact.tag}
                    </span>
                  </span>
                  <span className={`text-right font-semibold ${fact.score >= 0.97 ? "text-green-500" : "text-text-secondary"}`}>
                    {(fact.score * 100).toFixed(0)}%
                  </span>
                </motion.div>
              ))}
            </div>
            {/* Footer callout */}
            <div className="px-5 py-3 bg-accent-dim border-t border-accent/20 flex items-center gap-2">
              <span className="text-xs text-accent font-mono">↳ Only facts relevant to this query were retrieved.</span>
            </div>
          </motion.div>
        </div>

        {/* Token savings callout */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.4, delay: 0.5 }}
          className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3 text-sm text-text-muted"
        >
          <span className="font-mono text-red-400">12,400 tokens</span>
          <span>→ stale, full-file injection</span>
          <span className="hidden sm:block text-border">|</span>
          <span className="font-mono text-green-500">340 tokens</span>
          <span>→ exact-match retrieval via Plumb</span>
          <span className="hidden sm:block text-border">|</span>
          <span className="font-mono text-accent font-semibold">97.3% reduction</span>
        </motion.div>
      </div>
    </section>
  );
}
