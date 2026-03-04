"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

const plans = [
  {
    name: "OSS",
    price: "Free",
    description: "Self-host on your own machine. MIT licensed.",
    features: [
      "SQLite local storage",
      "Automatic conversation ingestion",
      "Confidence-scored fact extraction",
      "Recency decay",
      "MCP server included",
      "Unlimited sessions",
    ],
    cta: "Self-host",
    href: "https://docs.getplumb.dev/self-host",
    highlighted: false,
  },
  {
    name: "Solo",
    price: "$9",
    period: "/mo",
    description: "Hosted infrastructure. Zero ops.",
    features: [
      "Everything in OSS",
      "Postgres + pgvector on Supabase",
      "Cross-device sync",
      "Semantic search over facts",
      "Automatic backups",
      "Priority support",
    ],
    cta: "Join the waitlist",
    href: "mailto:hello@getplumb.dev",
    highlighted: true,
  },
];

export default function Pricing() {
  return (
    <section className="border-t border-border py-24 md:py-32">
      <div className="mx-auto max-w-4xl px-6">
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center text-2xl font-semibold text-text-primary sm:text-3xl"
        >
          Simple pricing
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mx-auto mt-4 max-w-lg text-center text-sm text-text-secondary"
        >
          Start free with the open-source core. Upgrade when you want hosted infrastructure.
        </motion.p>

        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className={cn(
                "flex flex-col rounded-lg border p-8",
                plan.highlighted
                  ? "border-accent shadow-[0_0_24px_-6px] shadow-accent/20"
                  : "border-border"
              )}
            >
              <h3 className="text-lg font-semibold text-text-primary">{plan.name}</h3>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-4xl font-bold text-text-primary">{plan.price}</span>
                {plan.period && (
                  <span className="text-sm text-text-muted">{plan.period}</span>
                )}
              </div>
              <p className="mt-2 text-sm text-text-secondary">{plan.description}</p>

              <ul className="mt-8 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-text-secondary">
                    <svg className="mt-0.5 h-4 w-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              {plan.highlighted ? (
                <div className="mt-8 text-center text-sm text-text-muted">
                  Early access: <span className="text-text-secondary select-all">hello@getplumb.dev</span>
                </div>
              ) : (
                <a
                  href={plan.href}
                  className="mt-8 block rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium text-text-primary transition-colors hover:bg-surface"
                >
                  {plan.cta}
                </a>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
