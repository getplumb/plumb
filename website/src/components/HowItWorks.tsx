"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { MessageSquare, BrainCircuit, SearchCode, Plug } from "lucide-react";

const STEPS = [
  {
    num: "01",
    icon: Plug,
    title: "Install once",
    body: "Paste the install prompt into your OpenClaw chat. Your agent handles the rest — download, config, and gateway restart. One conversation, done.",
    code: `you: Install the Plumb memory plugin.

openclaw: Running:
  openclaw plugins install @getplumb/plumb
  openclaw config set plugins.slots.memory plumb
  openclaw gateway restart

✓ Installed. I can feel my brain growing.`,
  },
  {
    num: "02",
    icon: BrainCircuit,
    title: "Your agent writes facts as it works",
    body: "No prompting required. As your agent learns things worth keeping, it calls plumb_remember() — Plumb handles embedding and indexing in the background. It can also search its own memory mid-conversation with plumb_search().",
    code: `# Writing a new fact:
→ plumb_remember("Primary comms channel is Slack",
                  confidence="high")
   ✓ stored · [HIGH] ready for retrieval

# Searching mid-conversation:
→ plumb_search("sub-agent model")
   ← Default sub-agent model: claude-haiku-4-5
      [HIGH] · 3 days ago`,
  },
  {
    num: "03",
    icon: SearchCode,
    title: "Relevant facts injected before each prompt",
    body: "Before every response, Plumb queries the vector store for facts relevant to the current conversation and injects them as a compact block — never the whole file.",
    code: `[PLUMB MEMORY — 6 facts, 340 tokens]
[HIGH] Primary comms channel is Slack
[HIGH] Sub-agent timeout default: 600s
[MED]  Default model: claude-haiku-4-5
...`,
  },
  {
    num: "04",
    icon: MessageSquare,
    title: "Your agent just knows",
    body: "No new tools. No workflow changes. Your agent simply has context it didn't have before — including things you mentioned in sessions weeks ago.",
    code: `you: what channel should I post the alert to?

openclaw: Slack — specifically #alerts.
          You set that up a couple weeks ago.`,
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
            Plumb runs entirely in the background. Install once, forget it exists, then wonder why
            your agent suddenly remembers everything.
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
                  {/* Icon + number */}
                  <div className="relative mb-5 flex items-center gap-3">
                    <div className="z-10 flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent-dim shadow-accent-sm">
                      <Icon size={22} className="text-accent" />
                    </div>
                    <span className="font-mono text-3xl font-bold text-border select-none">{step.num}</span>
                  </div>

                  {/* Title + body */}
                  <h3 className="mb-2 text-[15px] font-semibold text-text-primary">{step.title}</h3>
                  <p className="mb-4 text-sm leading-relaxed text-text-secondary">{step.body}</p>

                  {/* Code snippet */}
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
