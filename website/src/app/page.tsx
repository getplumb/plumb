// TODO: Claude Code will implement full page sections
// Scaffold only — replace with full implementation per T-021

import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Problem from "@/components/Problem";
import HowItWorks from "@/components/HowItWorks";
import Pricing from "@/components/Pricing";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <Nav />
      <Hero />
      <Problem />
      <HowItWorks />
      <Pricing />
      <Footer />
    </main>
  );
}
