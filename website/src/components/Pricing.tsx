"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { INSTALL_PROMPT } from "@/lib/constants";

const TIERS = [
  {
    name: "Local / OSS",
    price: "Free",
    priceNote: "Forever",
    target: "Tinkerers & privacy hawks",
    description:
      "Run Plumb entirely on your machine. Your facts never leave your disk. Full MCP support, zero dependencies.",
    badge: null,
    cta: "Add to OpenClaw",
    ctaHref: "#install",
    ctaStyle: "border border-border text-text-primary hover:bg-surface-2",
    features: [
      "Local SQLite DB (sqlite-vec)",
      "Unlimited memory storage",
      "Full MCP server support",
      "CLI interface (plumb list, plumb wipe, etc.)",
      "Auto-seed from MEMORY.md on first activation",
      "OpenClaw plugin (memory slot, before_prompt_build)",
      "100% private — zero telemetry",
    ],
  },
  {
    name: "Plumb Cloud",
    price: "$9",
    priceNote: "/ month",
    target: "Power users & multi-device setups",
    description:
      "Everything in the free tier, plus real-time cross-device sync and a hosted web UI to manage your memory store.",
    badge: "Early Access",
    cta: "Get Early Access",
    ctaHref: "mailto:hello@plumb.run",
    ctaStyle: "bg-accent text-background hover:bg-accent-hover hover:shadow-accent-md",
    features: [
      "Everything in Local / OSS",
      "Cross-device real-time sync",
      "Hosted vector DB (zero local setup)",
      "Web-based memory manager UI",
      "Conflict-free merge (CRDT-backed)",
      "API access for custom integrations",
      "Priority support",
    ],
  },
];

export default function Pricing() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.2 });
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <section id="pricing" ref={ref} className="py-24 md:py-32 border-t border-border">
      <div className="mx-auto max-w-7xl px-6">

        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="mb-16 text-center"
        >
          <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase mb-3">Pricing</p>
          <h2 className="text-3xl font-bold text-text-primary md:text-4xl">
            Simple. Transparent. No gotchas.
          </h2>
          <p className="mt-4 text-text-secondary max-w-lg mx-auto">
            Start free, stay free. Upgrade only if you need sync or want to skip the local setup.
          </p>
        </motion.div>

        {/* Pricing cards */}
        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-2">
          {TIERS.map((tier, i) => (
            <motion.div
              key={tier.name}
              initial={{ opacity: 0, y: 24 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.1 * i }}
              className={`relative rounded-xl border ${
                tier.badge
                  ? "border-accent/40 bg-surface shadow-accent-sm"
                  : "border-border bg-surface"
              } p-8`}
            >
              {/* Badge */}
              {tier.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-background">
                    {tier.badge}
                  </span>
                </div>
              )}

              {/* Tier name + target */}
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-text-primary">{tier.name}</h3>
                <p className="mt-1 text-sm text-text-muted">{tier.target}</p>
              </div>

              {/* Price */}
              <div className="mb-6 flex items-end gap-1">
                <span className="text-4xl font-bold text-text-primary">{tier.price}</span>
                <span className="mb-1 text-sm text-text-muted">{tier.priceNote}</span>
              </div>

              {/* Description */}
              <p className="mb-8 text-sm leading-relaxed text-text-secondary">{tier.description}</p>

              {/* CTA */}
              {tier.cta === "Add to OpenClaw" ? (
                <button
                  onClick={handleCopy}
                  className={`block w-full rounded-lg px-5 py-3 text-center text-sm font-semibold transition-all duration-200 ${tier.ctaStyle}`}
                >
                  {copied ? "Copied!" : "Add to OpenClaw"}
                </button>
              ) : (
                <a
                  href={tier.ctaHref}
                  className={`block w-full rounded-lg px-5 py-3 text-center text-sm font-semibold transition-all duration-200 ${tier.ctaStyle}`}
                >
                  {tier.cta}
                </a>
              )}

              {/* Divider */}
              <div className="my-8 border-t border-border" />

              {/* Features */}
              <ul className="space-y-3">
                {tier.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-3">
                    <Check
                      size={15}
                      className={`mt-0.5 shrink-0 ${tier.badge ? "text-accent" : "text-green-500"}`}
                    />
                    <span className="text-sm text-text-secondary">{feat}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>

        {/* Fine print */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={inView ? { opacity: 1 } : {}}
          transition={{ duration: 0.4, delay: 0.4 }}
          className="mt-10 text-center text-xs text-text-muted font-mono"
        >
          OSS core will always be free. No credit card required. Cloud is early access — pricing may change.
        </motion.p>
      </div>
    </section>
  );
}
