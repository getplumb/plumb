import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Plumb",
  description: "Terms governing your use of the Plumb service.",
};

export default function TermsPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-24 text-text-primary">
      <h1 className="text-3xl font-semibold mb-2">Terms of Service</h1>
      <p className="text-text-muted text-sm mb-12">Last updated: March 4, 2026</p>

      <div className="prose prose-invert prose-zinc max-w-none space-y-10 text-text-secondary leading-relaxed">

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">1. Agreement</h2>
          <p>
            These Terms of Service (&quot;Terms&quot;) govern your access to and use of the services
            provided by Plumb LLC, a Colorado limited liability company (&quot;Plumb,&quot; &quot;we,&quot;
            &quot;us,&quot; or &quot;our&quot;), including the hosted API, website, and any related tools
            (collectively, the &quot;Service&quot;).
          </p>
          <p className="mt-3">
            By creating an account or using the Service, you agree to these Terms. If you do not
            agree, do not use the Service.
          </p>
          <p className="mt-3">
            These Terms do not apply to the open-source Plumb MCP server, which is licensed
            separately under the MIT License.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">2. Eligibility</h2>
          <p>
            You must be at least 13 years old to use the Service. If you are under 18, you
            represent that you have parental or guardian consent. By using the Service, you represent
            that you meet these requirements.
          </p>
          <p className="mt-3">
            If you are using the Service on behalf of a company or organization, you represent that
            you have authority to bind that entity to these Terms.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">3. Your account</h2>
          <p>
            You are responsible for maintaining the security of your account credentials and API
            keys. Notify us immediately at{" "}
            <a href="mailto:support@plumb.run" className="text-accent hover:text-accent-hover">support@plumb.run</a>{" "}
            if you suspect unauthorized access. We are not liable for losses resulting from
            unauthorized use of your account.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">4. Subscriptions and billing</h2>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Free trial</h3>
          <p>
            New accounts receive a 30-day free trial of the Solo plan. No credit card is required
            to start the trial. At the end of the trial, you must subscribe to continue using the
            hosted Service. Your memory data is retained for 30 days after trial expiration before
            being permanently deleted.
          </p>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Solo plan</h3>
          <p>
            The Solo plan is billed at $9.00 USD per month. Billing is handled by Stripe and
            renews automatically each month until cancelled.
          </p>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Cancellation</h3>
          <p>
            You may cancel your subscription at any time. If you cancel before the end of your
            current billing period, we will issue a prorated refund for the unused portion of that
            month. To request a refund, contact{" "}
            <a href="mailto:support@plumb.run" className="text-accent hover:text-accent-hover">support@plumb.run</a>.{" "}
            Refunds are typically processed within 5–7 business days.
          </p>

          <h3 className="text-base font-medium text-text-primary mt-5 mb-2">Price changes</h3>
          <p>
            We may change pricing with at least 30 days&apos; notice. Continued use after the
            effective date constitutes acceptance of the new pricing.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">5. Your data</h2>
          <p>
            You retain ownership of all data you submit to the Service, including conversation logs
            and extracted memory facts (&quot;Your Data&quot;). You grant Plumb a limited license to
            store, process, and retrieve Your Data solely to provide the Service to you.
          </p>
          <p className="mt-3">
            We do not use Your Data to train AI models. We do not sell Your Data. We may analyze
            query and retrieval patterns to improve the accuracy of the Service. This analysis
            operates on metadata and system outputs, not the content of your conversations. See our{" "}
            <a href="/privacy" className="text-accent hover:text-accent-hover">Privacy Policy</a>{" "}
            for full details on how we handle your data.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">6. Acceptable use</h2>
          <p>You agree not to use the Service to:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Violate any applicable law or regulation</li>
            <li>Store or transmit content that is illegal, harmful, or infringes third-party rights</li>
            <li>Attempt to gain unauthorized access to the Service or other users&apos; data</li>
            <li>Reverse engineer, decompile, or extract source code from the hosted Service</li>
            <li>Use the Service in a way that could damage, disable, or impair it</li>
            <li>Resell or sublicense access to the Service without our written permission</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">7. Service availability</h2>
          <p>
            We aim for high availability but do not guarantee uninterrupted access to the Service.
            We may perform maintenance, updates, or experience outages. We are not liable for losses
            resulting from Service unavailability.
          </p>
          <p className="mt-3">
            We reserve the right to suspend or terminate accounts that violate these Terms, with or
            without notice.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">8. Open-source components</h2>
          <p>
            Plumb&apos;s core packages (<code>@plumb/core</code>, <code>@plumb/mcp-server</code>, and
            related packages) are open source and available at{" "}
            <a href="https://github.com/getplumb/plumb" className="text-accent hover:text-accent-hover">github.com/getplumb/plumb</a>{" "}
            under the MIT License. These Terms do not govern your use of those packages.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">9. Disclaimer of warranties</h2>
          <p>
            THE SERVICE IS PROVIDED &quot;AS IS&quot; WITHOUT WARRANTY OF ANY KIND. WE DISCLAIM ALL
            WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
            PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
            ERROR-FREE OR THAT YOUR DATA WILL NEVER BE LOST.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">10. Limitation of liability</h2>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, PLUMB LLC SHALL NOT BE LIABLE FOR ANY
            INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOSS OF
            DATA, LOSS OF PROFITS, OR BUSINESS INTERRUPTION, ARISING FROM YOUR USE OF OR INABILITY
            TO USE THE SERVICE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          </p>
          <p className="mt-3">
            OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM THESE TERMS OR YOUR USE OF THE
            SERVICE SHALL NOT EXCEED THE AMOUNT YOU PAID TO PLUMB IN THE 12 MONTHS PRECEDING THE
            CLAIM.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">11. Governing law</h2>
          <p>
            These Terms are governed by the laws of the State of Colorado, without regard to
            conflict of law principles. Any disputes shall be resolved in the state or federal courts
            located in Boulder County, Colorado, and you consent to personal jurisdiction there.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">12. Changes to these Terms</h2>
          <p>
            We may update these Terms from time to time. When we do, we will update the date at the
            top of this page. Continued use of the Service after changes are posted constitutes
            acceptance of the updated Terms.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium text-text-primary mb-3">13. Contact</h2>
          <p>
            Questions about these Terms? Contact us at{" "}
            <a href="mailto:legal@plumb.run" className="text-accent hover:text-accent-hover">legal@plumb.run</a>{" "}
            or by mail at:
          </p>
          <address className="mt-3 not-italic">
            Plumb LLC<br />
            Lafayette, CO 80026
          </address>
        </section>

      </div>
    </main>
  );
}
