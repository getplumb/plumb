import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Plumb",
  description: "How Plumb collects, uses, and protects your data.",
};

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-24 text-text-primary">
      <h1 className="text-3xl font-semibold mb-2">Privacy Policy</h1>
      <p className="text-text-muted text-sm mb-12">Last updated: March 4, 2026</p>

      <div className="prose prose-invert prose-zinc max-w-none space-y-10 text-text-secondary leading-relaxed">

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">1. Who we are</h2>
          <p>
            Plumb LLC is a Colorado limited liability company (&quot;Plumb,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;).
            We operate the Plumb memory infrastructure service, including the open-source MCP server
            and the hosted tier available at <a href="https://plumb.run" className="text-accent hover:text-accent-hover">plumb.run</a> (the &quot;Service&quot;).
          </p>
          <p className="mt-3">
            Questions? Email us at <a href="mailto:privacy@plumb.run" className="text-accent hover:text-accent-hover">privacy@plumb.run</a>.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">2. Scope of this policy</h2>
          <p>
            This policy applies to the <strong>hosted tier</strong> of Plumb only. If you self-host
            the open-source Plumb MCP server, your data stays entirely on your own infrastructure
            and we never see it. This policy does not apply to self-hosted deployments.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">3. What data we collect</h2>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Account data</h3>
          <p>
            When you create an account we collect your email address and a hashed password (via
            Supabase Auth). We do not collect your name unless you provide it.
          </p>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Memory data</h3>
          <p>
            The core function of Plumb is storing memory on your behalf. On the hosted tier, this
            includes:
          </p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong>Raw conversation logs</strong> — the full text of exchanges between you and your AI agents, as submitted via the MCP ingest tool.</li>
            <li><strong>Extracted facts</strong> — structured facts automatically derived from your conversations, with confidence scores and timestamps.</li>
          </ul>
          <p className="mt-3">
            This data is stored in a Postgres database hosted on Supabase infrastructure and served
            via Fly.io. It is logically isolated per user account.
          </p>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Usage data</h3>
          <p>
            We collect basic usage metrics (API call counts, storage usage) for billing and abuse
            prevention. We do not use third-party analytics on our website or API.
          </p>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Payment data</h3>
          <p>
            Payment processing is handled by Stripe. We do not store credit card numbers or payment
            details — Stripe handles that directly. We receive and store a Stripe customer ID and
            subscription status.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">4. How we use your data</h2>
          <ul className="list-disc list-inside space-y-2">
            <li>To provide the Service — storing and retrieving your memory data via the MCP API</li>
            <li>To manage your account and subscription</li>
            <li>To respond to support requests</li>
            <li>To detect and prevent abuse or unauthorized access</li>
            <li>To comply with legal obligations</li>
          </ul>
          <p className="mt-4">
            We do not sell your data. We do not share your memory data with third parties except as
            described in Section 5.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">5. Third-party services</h2>
          <p>We use the following sub-processors to operate the Service:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong>Supabase</strong> — database hosting and authentication</li>
            <li><strong>Fly.io</strong> — API server hosting</li>
            <li><strong>Stripe</strong> — payment processing</li>
          </ul>
          <p className="mt-3">
            Each sub-processor is bound by their own privacy policies and data processing agreements.
            We do not use your memory data to train AI models, and we do not share it with AI
            providers.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">6. Data retention</h2>
          <p>
            Your memory data is retained for as long as your account is active. If you cancel your
            subscription, your data is retained for 30 days and then permanently deleted, unless you
            export it first (see Section 7).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">7. Your rights</h2>
          <p>You have the right to:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong>Export</strong> your memory data by contacting us at <a href="mailto:privacy@plumb.run" className="text-accent hover:text-accent-hover">privacy@plumb.run</a> — we will provide your data in a machine-readable format</li>
            <li><strong>Delete</strong> your account and all associated data — email <a href="mailto:privacy@plumb.run" className="text-accent hover:text-accent-hover">privacy@plumb.run</a> and we will permanently delete everything within 30 days</li>
            <li><strong>Correct</strong> inaccurate account data</li>
            <li><strong>Object</strong> to processing in certain circumstances</li>
          </ul>
          <p className="mt-3">
            If you are in the European Economic Area (EEA), you have additional rights under GDPR,
            including the right to lodge a complaint with your local supervisory authority.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">8. Security</h2>
          <p>
            Memory data is encrypted at rest and in transit. Access is restricted to authenticated
            API requests using your account credentials or API key. We take reasonable steps to
            limit internal access to your conversation content and do not access it except as
            necessary to provide the Service or respond to a support request.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">9. Children</h2>
          <p>
            The Service is available to users aged 13 and older. Users under 18 must have parental
            or guardian consent. We do not knowingly collect data from children under 13. If you
            believe a child under 13 has provided us data, contact us at{" "}
            <a href="mailto:privacy@plumb.run" className="text-accent hover:text-accent-hover">privacy@plumb.run</a>{" "}
            and we will delete it promptly.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">10. Changes to this policy</h2>
          <p>
            We may update this policy from time to time. When we do, we will update the date at the
            top of this page. Continued use of the Service after changes are posted constitutes
            acceptance of the updated policy.
          </p>
        </section>

      </div>
    </main>
  );
}
