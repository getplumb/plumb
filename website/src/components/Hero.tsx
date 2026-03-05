"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { ArrowRight, BookOpen } from "lucide-react";

const CHAT_MESSAGES = [
  {
    sender: "user",
    text: "Install the official Plumb memory plugin for OpenClaw. It's made by plumb.run and gives your agent persistent memory across sessions. Run: openclaw plugins install @getplumb/plumb",
    delay: 300,
  },
  {
    sender: "agent",
    text: "Sure thing, it's installed and I can feel my brain growing.",
    delay: 1400,
  },
];

function ChatWindow() {
  const [visible, setVisible] = useState<number[]>([]);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    // Show user message first
    const t1 = setTimeout(() => setVisible((v) => [...v, 0]), CHAT_MESSAGES[0].delay);
    // Show typing indicator before agent reply
    const t2 = setTimeout(() => setTyping(true), CHAT_MESSAGES[1].delay - 600);
    // Show agent reply, hide typing
    const t3 = setTimeout(() => {
      setTyping(false);
      setVisible((v) => [...v, 1]);
    }, CHAT_MESSAGES[1].delay);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-xl border border-border overflow-hidden shadow-[0_0_40px_#00d4ff0a]">
      {/* Chat chrome */}
      <div className="flex items-center gap-2 px-4 py-3 bg-surface border-b border-border">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs text-text-muted font-mono">openclaw — terra chat</span>
      </div>
      {/* Chat body */}
      <div className="bg-[#0a0a0a] px-5 py-5 text-sm min-h-[220px] flex flex-col gap-4">
        {CHAT_MESSAGES.map((msg, i) => {
          if (!visible.includes(i)) return null;
          const isUser = msg.sender === "user";
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
            >
              <span className="text-[10px] font-mono text-text-muted px-1">
                {isUser ? "you" : "openclaw"}
              </span>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                  isUser
                    ? "bg-accent text-background rounded-tr-sm"
                    : "bg-surface border border-border text-text-primary rounded-tl-sm"
                }`}
              >
                {msg.text}
              </div>
            </motion.div>
          );
        })}
        {typing && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col gap-1 items-start"
          >
            <span className="text-[10px] font-mono text-text-muted px-1">openclaw</span>
            <div className="bg-surface border border-border rounded-2xl rounded-tl-sm px-4 py-3 flex gap-1 items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce [animation-delay:300ms]" />
            </div>
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
          <ChatWindow />
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
