import React from 'react';
import { Link } from 'react-router-dom';

const TIERS = [
  {
    name: 'Free',
    price: '$0',
    period: '/month',
    description: 'For individuals exploring AI governance',
    features: [
      'Up to 3 repositories',
      '100 sessions per month',
      '1 user',
      'Basic session replay',
      'Community support',
    ],
    cta: 'Get started free',
    ctaLink: '/register',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '$49',
    period: '/user/month',
    description: 'For teams shipping with AI agents',
    features: [
      'Unlimited repositories',
      'Unlimited sessions',
      'Up to 25 users',
      'AI Auto-Review',
      'Policy enforcement',
      'GitHub integration',
      'Budget & cost controls',
      'Real-time streaming',
      'Priority support',
    ],
    cta: 'Start free trial',
    ctaLink: '/register',
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For organizations with compliance requirements',
    features: [
      'Everything in Pro',
      'Unlimited users',
      'SSO / SAML',
      'Custom policies & workflows',
      'Dedicated support & SLA',
      'On-premise deployment option',
      'Custom integrations',
      'Advanced audit & reporting',
    ],
    cta: 'Contact sales',
    ctaLink: 'mailto:sales@getorigin.dev',
    highlighted: false,
  },
];

const FAQ = [
  {
    q: 'What counts as a session?',
    a: 'A session is a single AI coding interaction \u2014 from when an agent starts working to when it finishes. Each Claude Code session, Cursor interaction, or Copilot suggestion cycle counts as one session.',
  },
  {
    q: 'Can I switch plans anytime?',
    a: 'Yes. You can upgrade or downgrade at any time. When upgrading, you get immediate access to Pro features. When downgrading, your Pro features remain until the end of the billing period.',
  },
  {
    q: 'Do you offer a free trial for Pro?',
    a: 'Yes! Pro comes with a 14-day free trial. No credit card required. You get full access to all Pro features during the trial.',
  },
  {
    q: 'What AI coding tools are supported?',
    a: 'Origin works with any AI coding tool that supports MCP (Claude Code, Cursor) and can track sessions from any Git-based workflow. CLI hooks support Claude Code natively.',
  },
];

export default function Pricing() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      {/* Header */}
      <div className="text-center mb-16">
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-100">
          Simple, transparent pricing
        </h1>
        <p className="mt-4 text-lg text-gray-400 max-w-xl mx-auto">
          Start free. Scale when your team grows. Enterprise-grade governance
          for organizations that need it.
        </p>
      </div>

      {/* Pricing Cards */}
      <div className="grid md:grid-cols-3 gap-8 mb-24">
        {TIERS.map((tier) => (
          <div
            key={tier.name}
            className={`card flex flex-col ${
              tier.highlighted
                ? 'border-indigo-500/50 bg-indigo-600/5 ring-1 ring-indigo-500/20'
                : ''
            }`}
          >
            {tier.highlighted && (
              <div className="text-center -mt-3 mb-4">
                <span className="inline-block bg-indigo-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
                  Most Popular
                </span>
              </div>
            )}
            <div className="mb-6">
              <h3 className="text-xl font-bold text-gray-100">{tier.name}</h3>
              <p className="text-sm text-gray-400 mt-1">{tier.description}</p>
            </div>
            <div className="mb-6">
              <span className="text-4xl font-bold text-gray-100">{tier.price}</span>
              {tier.period && (
                <span className="text-gray-500 ml-1">{tier.period}</span>
              )}
            </div>
            <ul className="space-y-3 mb-8 flex-1">
              {tier.features.map((feature, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                  <span className="text-green-400 mt-0.5 flex-shrink-0">&#10003;</span>
                  {feature}
                </li>
              ))}
            </ul>
            {tier.ctaLink.startsWith('mailto') ? (
              <a
                href={tier.ctaLink}
                className={`text-center py-3 px-6 rounded-xl font-semibold text-sm transition-colors ${
                  tier.highlighted
                    ? 'btn-primary'
                    : 'bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700'
                }`}
              >
                {tier.cta}
              </a>
            ) : (
              <Link
                to={tier.ctaLink}
                className={`text-center py-3 px-6 rounded-xl font-semibold text-sm transition-colors ${
                  tier.highlighted
                    ? 'btn-primary'
                    : 'bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700'
                }`}
              >
                {tier.cta}
              </Link>
            )}
          </div>
        ))}
      </div>

      {/* FAQ */}
      <div className="max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-center mb-10">Frequently asked questions</h2>
        <div className="space-y-6">
          {FAQ.map((item, i) => (
            <div key={i} className="card">
              <h3 className="font-semibold text-gray-100 mb-2">{item.q}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="text-center mt-20">
        <h2 className="text-2xl font-bold mb-3">Ready to govern your AI agents?</h2>
        <p className="text-gray-400 mb-6">Start for free. No credit card required.</p>
        <Link
          to="/register"
          className="btn-primary px-8 py-3 text-base font-semibold rounded-xl shadow-lg shadow-indigo-600/20"
        >
          Get started free &rarr;
        </Link>
      </div>
    </div>
  );
}
