"use client";

import { motion } from "framer-motion";

const steps = [
  {
    number: "01",
    title: "Ingest",
    description: "Agents talk. Plumb listens. Every conversation is logged automatically via the MCP protocol — no manual saves, no commands.",
    snippet: `User: I prefer spaces over tabs
Agent: Noted, I'll use spaces for indentation`,
    label: "conversation.log",
  },
  {
    number: "02",
    title: "Extract",
    description: "Facts are pulled from raw conversation logs, deduplicated, and scored by confidence. Stale facts decay over time so your agent stays current.",
    snippet: `{
  "subject": "user",
  "predicate": "prefers",
  "object": "spaces over tabs",
  "confidence": 0.95,
  "decay": 0.98
}`,
    label: "extracted fact",
  },
  {
    number: "03",
    title: "Retrieve",
    description: "When your agent needs context, a single MCP tool call returns the most relevant facts. Drop this into your config and it just works.",
    snippet: `{
  "mcpServers": {
    "plumb": {
      "command": "plumb",
      "args": ["serve", "--mcp"],
      "env": {
        "PLUMB_STORE": "~/.plumb/store.db"
      }
    }
  }
}`,
    label: "mcp.json",
  },
];

export default function HowItWorks() {
  return (
    <section className="border-t border-border py-24 md:py-32">
      <div className="mx-auto max-w-5xl px-6">
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center text-2xl font-semibold text-text-primary sm:text-3xl"
        >
          How it works
        </motion.h2>

        <div className="mt-16 space-y-16 md:space-y-20">
          {steps.map((step, i) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="grid items-start gap-8 md:grid-cols-2"
            >
              <div>
                <span className="font-mono text-sm text-accent">{step.number}</span>
                <h3 className="mt-2 text-xl font-semibold text-text-primary">
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary">
                  {step.description}
                </p>
              </div>

              <div className="rounded-lg border border-border bg-surface p-4 font-mono text-xs leading-relaxed text-text-secondary">
                <div className="mb-2 text-text-muted">{step.label}</div>
                <pre className="overflow-x-auto whitespace-pre">{step.snippet}</pre>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
