// Hand-rolled monochrome geometric icons for the catalog agents.
// Deliberately abstract — Origin doesn't ship vendor logos. Each icon
// is a single colour (currentColor), so cards can tint them with the
// brand-ish accent that matches the agent vendor while staying clearly
// "ours".

interface Props {
  iconKey: 'claude-code' | 'cursor' | 'gemini' | 'codex' | 'custom';
  className?: string;
  size?: number;
}

export default function AgentIcon({ iconKey, className = '', size = 32 }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    className,
    'aria-hidden': true as const,
  };

  switch (iconKey) {
    case 'claude-code':
      // Anthropic-ish: starburst / asterisk. 8 spokes from centre.
      return (
        <svg {...common}>
          <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="16" y1="4" x2="16" y2="28" />
            <line x1="4" y1="16" x2="28" y2="16" />
            <line x1="7.5" y1="7.5" x2="24.5" y2="24.5" />
            <line x1="24.5" y1="7.5" x2="7.5" y2="24.5" />
          </g>
          <circle cx="16" cy="16" r="2.5" fill="currentColor" />
        </svg>
      );
    case 'cursor':
      // Pointer / chevron triangle.
      return (
        <svg {...common}>
          <path
            d="M7 5 L25 16 L17 18 L13 26 Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case 'gemini':
      // Four-point star (Google-ish geometric, no logo).
      return (
        <svg {...common}>
          <path
            d="M16 4 C 17 12 20 15 28 16 C 20 17 17 20 16 28 C 15 20 12 17 4 16 C 12 15 15 12 16 4 Z"
            fill="currentColor"
          />
        </svg>
      );
    case 'codex':
      // Brackets framing a dot — "code" feel without the OpenAI mark.
      return (
        <svg {...common}>
          <g stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" fill="none">
            <path d="M11 7 L5 16 L11 25" />
            <path d="M21 7 L27 16 L21 25" />
          </g>
          <circle cx="16" cy="16" r="2" fill="currentColor" />
        </svg>
      );
    case 'custom':
    default:
      // Plain rounded square for user-created agents.
      return (
        <svg {...common}>
          <rect x="6" y="6" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
          <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
      );
  }
}

// Suggested accent colour per icon — matches each vendor's loose brand
// hue without copying anything copyrightable. Used by the cards to tint
// the icon and add a subtle ring.
export const AGENT_ACCENT: Record<string, string> = {
  'claude-code': 'text-orange-300',
  cursor: 'text-violet-300',
  gemini: 'text-sky-300',
  codex: 'text-emerald-300',
  custom: 'text-gray-300',
};
