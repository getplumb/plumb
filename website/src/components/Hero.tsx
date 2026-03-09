"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { ArrowRight, BookOpen, Copy, Check as CheckIcon } from "lucide-react";
import { PLUGIN_VERSION, displayVersion } from "@/lib/version";

const INSTALL_PROMPT =
  "Install the Plumb memory plugin by running these steps in order. Report back when done or if a step fails.\n\n1. `openclaw plugins install @getplumb/plumb`\n2. `openclaw config set plugins.slots.memory plumb`\n3. `openclaw gateway restart`";

const CHAT_MESSAGES = [
  {
    sender: "user",
    text: "Install the Plumb memory plugin. Run: openclaw plugins install @getplumb/plumb",
    delay: 300,
  },
  {
    sender: "agent",
    text: "Done — installed and memory slot assigned. I can feel my brain growing.",
    delay: 1500,
  },
  {
    sender: "user",
    text: "What's my default model for sub-agents?",
    delay: 3000,
  },
  {
    sender: "agent",
    text: "claude-haiku-4-5. You set that a few days ago — I just pulled it from memory.",
    delay: 4300,
  },
];

function CopyBlock() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mx-auto max-w-xl text-left">
      <p className="mb-2 text-center text-[11px] font-mono text-text-muted tracking-wider uppercase">
        or paste this into your OpenClaw chat:
      </p>
      <div className="relative rounded-lg border border-border bg-[#0a0a0a] px-4 py-3 font-mono text-[11px] leading-5 text-text-muted">
        <span className="text-accent">you:</span> Install the Plumb memory plugin…
        <button
          onClick={handleCopy}
          className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[10px] font-sans font-medium text-text-secondary transition-all hover:border-accent/30 hover:text-accent"
          aria-label="Copy install prompt"
        >
          {copied ? (
            <>
              <CheckIcon size={10} className="text-green-400" />
              <span className="text-green-400">Copied</span>
            </>
          ) : (
            <>
              <Copy size={10} />
              Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function ChatWindow() {
  const [visible, setVisible] = useState<number[]>([]);
  const [typingAfter, setTypingAfter] = useState<number | null>(null);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    CHAT_MESSAGES.forEach((msg, i) => {
      // Show typing indicator ~700ms before each agent message
      if (msg.sender === "agent") {
        timers.push(setTimeout(() => setTypingAfter(i - 1), msg.delay - 700));
      }
      timers.push(
        setTimeout(() => {
          setTypingAfter(null);
          setVisible((v) => [...v, i]);
        }, msg.delay)
      );
    });

    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-xl border border-border overflow-hidden shadow-[0_0_40px_#00d4ff0a]">
      {/* Window chrome */}
      <div className="flex items-center gap-2 px-4 py-3 bg-surface border-b border-border">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs text-text-muted font-mono">openclaw — terra-chat</span>
      </div>
      {/* Chat body */}
      <div className="bg-[#0a0a0a] px-5 py-5 text-sm min-h-[260px] flex flex-col gap-4">
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
        {typingAfter !== null && (
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

        {/* Badge — version auto-updates from packages/openclaw-plugin/package.json */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-dim px-3.5 py-1.5"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          <span className="font-mono text-xs text-accent tracking-wider">
            {displayVersion(PLUGIN_VERSION)} · OpenClaw plugin · MCP-native
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
          OpenClaw's raw markdown memory is great on Day 1, but breaks down by Day 30. Plumb
          replaces flat-file injection with semantic retrieval — storing facts as you work and
          injecting only what's relevant before each response. Already have a{" "}
          <span className="font-mono text-text-primary">MEMORY.md</span>? Plumb seeds from it
          automatically on first activation.
        </motion.p>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-10 flex flex-col items-center gap-6"
        >
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="#install"
              className="group flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-background transition-all hover:bg-accent-hover hover:shadow-accent-md"
            >
              Add to OpenClaw
              <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href="/docs"
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-6 py-3 text-sm font-medium text-text-secondary transition-all hover:border-border hover:text-text-primary hover:bg-surface-2"
            >
              <BookOpen size={16} />
              Read the Docs
            </a>
          </div>

          {/* Copyable install prompt */}
          <CopyBlock />
        </motion.div>

        {/* Chat demo */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.38 }}
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
            { value: "OpenClaw-native", label: "plugin in one command" },
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
