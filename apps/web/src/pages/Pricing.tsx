import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { FadeIn, StaggerContainer } from '../components/FadeIn';

const TIERS = [
  {
    name: 'Solo',
    price: '$0',
    period: 'forever',
    description: 'For individual developers tracking their AI coding',
    features: [
      'Unlimited repositories',
      'Unlimited sessions',
      'All AI agents supported',
      'Full session replay with prompts',
      'Per-prompt file change tracking',
      'Token usage & cost tracking',
      'Auto-created repos & agents',
      'Local CLI tools (blame, stats, diff)',
      'Multi-account support',
    ],
    cta: 'Get started free',
    ctaLink: '/register?type=developer',
    highlighted: false,
  },
  {
    name: 'Team',
    price: '$29',
    period: '/user/month',
    description: 'For teams that need visibility and governance over AI coding',
    features: [
      'Everything in Solo, plus:',
      'Centralized team dashboard',
      'Scoped API keys (per-repo, per-agent)',
      'Policy enforcement (model allowlists, cost limits, file restrictions)',
      'AI Auto-Review',
      'GitHub & GitLab PR checks',
      'Agent-level configuration & system prompts',
      'Budget & cost controls',
      'Audit logs & compliance reports',
      'Slack notifications',
      'Up to 25 users',
    ],
    cta: 'Start free trial',
    ctaLink: '/register?type=org',
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For organizations with compliance requirements',
    features: [
      'Everything in Team, plus:',
      'Unlimited users',
      'SSO / SAML',
      'Custom policies & workflows',
      'Dedicated support & SLA',
      'On-premise / self-hosted deployment',
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
    q: 'What\u2019s the difference between Solo and Team?',
    a: 'Solo is your personal dashboard \u2014 no restrictions, everything auto-created. Team adds governance: scoped API keys, policy enforcement, PR checks, and a centralized dashboard for team leads to see all AI activity. Developers can connect to both simultaneously.',
  },
  {
    q: 'Can I use Solo and Team at the same time?',
    a: 'Yes. Developers can connect to both a personal Solo account and their Team account. Sessions on team repos appear in both dashboards. Personal repos only appear in Solo. Run `origin login` for your dev account, then `origin login --profile team` for the team.',
  },
  {
    q: 'What counts as a session?',
    a: 'A session is a single AI coding interaction \u2014 from when an agent starts working to when it finishes. Each Claude Code session, Cursor interaction, or Gemini CLI session counts as one session.',
  },
  {
    q: 'What AI coding tools are supported?',
    a: 'Claude Code, Cursor, Gemini CLI, Codex CLI, Windsurf, Aider, Copilot, Continue, Amp, Junie, OpenCode, Rovo, and Droid. Any agent that supports hooks or MCP works with Origin.',
  },
  {
    q: 'Do you offer a free trial for Team?',
    a: 'Yes! Team comes with a 14-day free trial. No credit card required. You get full access to all Team features during the trial.',
  },
  {
    q: 'Is Solo really free forever?',
    a: 'Yes. Solo is free with no limits on repos, sessions, or agents. It\u2019s how we want every developer to track their AI coding. Upgrade to Team only when you need governance and team-wide visibility.',
  },
];

export default function Pricing() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <Helmet>
        <title>Pricing — Origin | Free for Solo Developers, Team Plans for Governance</title>
        <meta name="description" content="Origin Solo is free forever for individual developers. Team plans start at $29/user/month for AI code governance with policy enforcement, PR checks, and audit trails." />
        <link rel="canonical" href="https://getorigin.io/pricing" />
      </Helmet>
      {/* Header */}
      <FadeIn>
        <div className="text-center mb-16">
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-100">
            Free for developers. Built for teams.
          </h1>
          <p className="mt-4 text-lg text-gray-400 max-w-xl mx-auto">
            Solo is free forever. Add governance when your team needs it.
          </p>
        </div>
      </FadeIn>

      {/* Pricing Cards */}
      <StaggerContainer className="grid md:grid-cols-3 gap-8 mb-24" staggerMs={150}>
        {TIERS.map((tier) => (
          <div
            key={tier.name}
            className={`card flex flex-col hover:shadow-lg hover:shadow-indigo-500/5 hover:-translate-y-1 transition-all duration-300 ${
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
      </StaggerContainer>

      {/* Comparison Table */}
      <FadeIn>
      <div className="max-w-4xl mx-auto mb-24">
        <h2 className="text-2xl font-bold text-center mb-10">Compare plans</h2>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700/50">
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Feature</th>
                <th className="text-center py-3 px-4 text-gray-400 font-medium">Solo</th>
                <th className="text-center py-3 px-4 text-gray-400 font-medium">Team</th>
                <th className="text-center py-3 px-4 text-gray-400 font-medium">Enterprise</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {[
                ['Repositories', 'Unlimited', 'Unlimited', 'Unlimited'],
                ['Sessions', 'Unlimited', 'Unlimited', 'Unlimited'],
                ['AI agents', 'All (auto-created)', 'Configured by admin', 'Configured by admin'],
                ['Session replay & prompts', '\u2713', '\u2713', '\u2713'],
                ['Token & cost tracking', '\u2713', '\u2713', '\u2713'],
                ['CLI tools (blame, stats, diff)', '\u2713', '\u2713', '\u2713'],
                ['Multi-account', '\u2713', '\u2713', '\u2713'],
                ['Scoped API keys', '\u2014', '\u2713', '\u2713'],
                ['Policy enforcement', '\u2014', '\u2713', '\u2713'],
                ['GitHub/GitLab PR checks', '\u2014', '\u2713', '\u2713'],
                ['AI Auto-Review', '\u2014', '\u2713', '\u2713'],
                ['Budget controls', '\u2014', '\u2713', '\u2713'],
                ['Slack notifications', '\u2014', '\u2713', '\u2713'],
                ['Audit logs', '\u2014', '\u2713', '\u2713'],
                ['Users', '1', 'Up to 25', 'Unlimited'],
                ['SSO / SAML', '\u2014', '\u2014', '\u2713'],
                ['On-premise', '\u2014', '\u2014', '\u2713'],
                ['Dedicated support', '\u2014', '\u2014', '\u2713'],
              ].map(([feature, solo, team, enterprise], i) => (
                <tr key={i}>
                  <td className="py-2.5 px-4 text-gray-300">{feature}</td>
                  <td className="py-2.5 px-4 text-center text-gray-400">{solo}</td>
                  <td className="py-2.5 px-4 text-center text-gray-300">{team}</td>
                  <td className="py-2.5 px-4 text-center text-gray-400">{enterprise}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </FadeIn>

      {/* FAQ */}
      <div className="max-w-3xl mx-auto">
        <FadeIn>
          <h2 className="text-2xl font-bold text-center mb-10">Frequently asked questions</h2>
        </FadeIn>
        <StaggerContainer className="space-y-6" staggerMs={80}>
          {FAQ.map((item, i) => (
            <div key={i} className="card">
              <h3 className="font-semibold text-gray-100 mb-2">{item.q}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{item.a}</p>
            </div>
          ))}
        </StaggerContainer>
      </div>

      {/* Bottom CTA */}
      <FadeIn>
      <div className="text-center mt-20">
        <h2 className="text-2xl font-bold mb-3">Start tracking your AI code today</h2>
        <p className="text-gray-400 mb-6">Free forever for solo developers. No credit card required.</p>
        <div className="flex gap-4 justify-center">
          <Link
            to="/register?type=developer"
            className="btn-primary px-8 py-3 text-base font-semibold rounded-xl shadow-lg shadow-indigo-600/20"
          >
            Start free &rarr;
          </Link>
          <Link
            to="/register?type=org"
            className="bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700 px-8 py-3 text-base font-semibold rounded-xl transition-colors"
          >
            Start team trial
          </Link>
        </div>
      </div>
      </FadeIn>
    </div>
  );
}
