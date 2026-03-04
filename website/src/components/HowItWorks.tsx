"use client";

import { motion } from "framer-motion";

const steps = [
  {
    number: "01",
    title: "Ingest",
    description: "Agents talk. Plumb listens. Every conversation is logged automatically via the MCP protocol — no manual saves, no commands.",
    snippet: null,
  },
  {
    number: "02",
    title: "Extract",
    description: "Facts are pulled from raw conversation logs, deduplicated, and scored by confidence. Stale facts decay over time so your agent stays current.",
    snippet: null,
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

              {step.snippet ? (
                <div className="rounded-lg border border-border bg-surface p-4 font-mono text-xs leading-relaxed text-text-secondary">
                  <div className="mb-2 text-text-muted">mcp.json</div>
                  <pre className="overflow-x-auto whitespace-pre">{step.snippet}</pre>
                </div>
              ) : (
                <div className="flex h-32 items-center justify-center rounded-lg border border-border-subtle bg-surface">
                  <div className="flex items-center gap-3 text-text-muted">
                    <div className="h-2 w-2 rounded-full bg-accent" />
                    <span className="font-mono text-xs">{step.title.toLowerCase()}</span>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                    </svg>
                  </div>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
