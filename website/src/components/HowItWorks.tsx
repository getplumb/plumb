"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { MessageSquare, Cpu, SearchCode, Plug } from "lucide-react";

const STEPS = [
  {
    num: "01",
    icon: Plug,
    title: "Install once",
    body: "Two lines in your config. That's it.",
    code: `# openclaw.json
"plugins": ["@plumb/openclaw"]`,
  },
  {
    num: "02",
    icon: Cpu,
    title: "Facts are passively extracted",
    body: "Plumb runs a lightweight extraction pipeline in the background — chunking, embedding, and classifying facts from every LLM response into Subject → Predicate → Object triples. No changes to your workflow.",
    code: `→ "Clay uses Slack as primary channel"
   S: agent.channel
   P: primary
   O: slack  [0.99]`,
  },
  {
    num: "03",
    icon: SearchCode,
    title: "Semantic retrieval before each prompt",
    body: "Before your agent's next call, Plumb queries the vector store for relevant facts and injects them as a compact, structured block — never the full file.",
    code: `[PLUMB MEMORY — 6 facts, 340 tokens]
agent.channel.primary = slack
subagent.timeout.default = 600s
...`,
  },
  {
    num: "04",
    icon: MessageSquare,
    title: "Your agent just got smarter",
    body: "Your agent responds normally. It just has context it didn't have before. No new tools, no changed workflow — it's simply better.",
    code: `# no changes needed
# your agent already knows`,
  },
];

export default function HowItWorks() {
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
          <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase mb-3">How It Works</p>
          <h2 className="text-3xl font-bold text-text-primary md:text-4xl">
            Invisible until you need it.
          </h2>
          <p className="mt-4 text-text-secondary max-w-xl mx-auto">
            Plumb runs entirely in the background. Install once, forget it exists, then wonder why your agents suddenly got smarter.
          </p>
        </motion.div>

        {/* Steps */}
        <div className="relative">
          {/* Connector line (desktop) */}
          <div className="absolute left-0 right-0 top-[28px] hidden h-px bg-gradient-to-r from-transparent via-border to-transparent lg:block" />

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.num}
                  initial={{ opacity: 0, y: 24 }}
                  animate={inView ? { opacity: 1, y: 0 } : {}}
                  transition={{ duration: 0.45, delay: 0.08 * i }}
                  className="relative"
                >
                  {/* Step number bubble */}
                  <div className="relative mb-5 flex items-center gap-3">
                    <div className="z-10 flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent-dim shadow-accent-sm">
                      <Icon size={22} className="text-accent" />
                    </div>
                    <span className="font-mono text-3xl font-bold text-border select-none">{step.num}</span>
                  </div>

                  {/* Title + body */}
                  <h3 className="mb-2 text-[15px] font-semibold text-text-primary">{step.title}</h3>
                  <p className="mb-4 text-sm leading-relaxed text-text-secondary">{step.body}</p>

                  {/* Inline code snippet */}
                  <div className="rounded-lg border border-border bg-[#0a0a0a] p-3 font-mono text-[11px] leading-5 text-text-muted whitespace-pre">
                    {step.code}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
