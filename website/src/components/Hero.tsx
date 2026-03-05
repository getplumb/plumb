"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { ArrowRight, BookOpen } from "lucide-react";

const INSTALL_LINES = [
  { prompt: "$", text: "npm install -g plumb-server", delay: 400 },
  { prompt: "", text: "", delay: 800, isOutput: true, output: "" },
  { prompt: "", text: "✓ plumb-server@1.0.0 installed", delay: 900, isOutput: true, outputClass: "text-green-500" },
  { prompt: "$", text: "plumb init", delay: 1400 },
  { prompt: "", text: "", delay: 1800, isOutput: true, output: "" },
  { prompt: "", text: "✓ SQLite DB initialized at ~/.plumb/memory.db", delay: 1900, isOutput: true, outputClass: "text-green-500" },
  { prompt: "", text: "✓ Vector index ready (sqlite-vec)", delay: 2100, isOutput: true, outputClass: "text-green-500" },
  { prompt: "", text: "✓ MCP server listening on stdio", delay: 2300, isOutput: true, outputClass: "text-green-500" },
  { prompt: "", text: "→ Add to your openclaw.json to connect.", delay: 2500, isOutput: true, outputClass: "text-[#00d4ff]" },
];

function TerminalWindow() {
  const [visible, setVisible] = useState<number[]>([]);

  useEffect(() => {
    INSTALL_LINES.forEach((line, i) => {
      const timer = setTimeout(() => {
        setVisible((v) => [...v, i]);
      }, line.delay);
      return () => clearTimeout(timer);
    });
  }, []);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-xl border border-border overflow-hidden shadow-[0_0_40px_#00d4ff0a]">
      {/* Terminal chrome */}
      <div className="flex items-center gap-2 px-4 py-3 bg-surface border-b border-border">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs text-text-muted font-mono">zsh — plumb setup</span>
      </div>
      {/* Terminal body */}
      <div className="bg-[#0a0a0a] px-5 py-5 font-mono text-sm min-h-[220px]">
        {INSTALL_LINES.map((line, i) => {
          if (!visible.includes(i)) return null;
          const isOutput = (line as any).isOutput;
          const outputClass = (line as any).outputClass || "text-text-muted";

          if (isOutput) {
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`leading-6 ${outputClass}`}
              >
                {line.text || "\u00a0"}
              </motion.div>
            );
          }

          return (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2 leading-7"
            >
              <span className="text-[#00d4ff] select-none">{line.prompt}</span>
              <span className="text-text-primary">{line.text}</span>
              {i === visible[visible.length - 1] && !isOutput && (
                <span className="inline-block w-[7px] h-[15px] bg-[#00d4ff] cursor-blink ml-0.5" />
              )}
            </motion.div>
          );
        })}
        {visible.length === INSTALL_LINES.length && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 leading-7 mt-1"
          >
            <span className="text-[#00d4ff] select-none">$</span>
            <span className="inline-block w-[7px] h-[15px] bg-[#00d4ff] cursor-blink" />
          </motion.div>
        )}
      </div>
    </div>
  );
}

export default function Hero() {
  return (
    <section
      id="install"
      className="relative overflow-hidden bg-hero-glow pt-36 pb-28 md:pt-44 md:pb-36"
    >
      {/* Subtle grid texture */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            "linear-gradient(#00d4ff 1px, transparent 1px), linear-gradient(90deg, #00d4ff 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative mx-auto max-w-4xl px-6 text-center">

        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-dim px-3.5 py-1.5"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          <span className="font-mono text-xs text-accent tracking-wider">
            v1.0 is live • Fully MCP Compliant
          </span>
        </motion.div>

        {/* H1 */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05 }}
          className="text-4xl font-bold tracking-tight text-text-primary sm:text-5xl md:text-6xl lg:text-[64px] leading-[1.1]"
        >
          Decouple your agent's memory
          <br className="hidden sm:block" /> from its prompt.
        </motion.h1>

        {/* Subheadline */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.12 }}
          className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary md:text-xl"
        >
          OpenClaw's raw markdown memory is great on Day 1, but breaks down by Day 30. Plumb is an MCP-compliant memory server that extracts, structures, and serves exactly the right context to your agents. Save tokens, stop hallucinations, and never lose context again.
        </motion.p>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <a
            href="#install"
            className="group flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-background transition-all hover:bg-accent-hover hover:shadow-accent-md"
          >
            Install Plumb Locally
            <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </a>
          <a
            href="/docs"
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-6 py-3 text-sm font-medium text-text-secondary transition-all hover:border-border hover:text-text-primary hover:bg-surface-2"
          >
            <BookOpen size={16} />
            Read the Docs
          </a>
        </motion.div>

        {/* Terminal */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.35 }}
          className="mt-16"
        >
          <TerminalWindow />
        </motion.div>

        {/* Stats row */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.8 }}
          className="mt-12 flex flex-wrap items-center justify-center gap-8 text-sm text-text-muted"
        >
          {[
            { value: "~0 tokens", label: "on cold start" },
            { value: "SQLite-vec", label: "local vector search" },
            { value: "MCP native", label: "plug into any agent" },
            { value: "100% private", label: "no cloud required" },
          ].map((s) => (
            <div key={s.value} className="flex items-center gap-2">
              <span className="font-mono text-text-primary font-medium">{s.value}</span>
              <span>{s.label}</span>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
