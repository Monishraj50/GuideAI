// AtruneAI brand mark.
//
// Six isometric cubes arranged in an A: 5 navy structural + 1 teal AI core.
// Apex is a wireframe (intent before it's built); the teal cube at center is
// the AI itself. Faint navy lines trace the A skeleton; brighter teal lines
// mark the crossbar through the AI core.
//
// Designed at viewBox 64x64. For sizes <24, prefer the simpler 4-cube favicon
// at app/icon.svg.

interface Props {
  size?: number;
  className?: string;
  /** When true, the teal AI cube pulses gently — useful on the sign-in hero. */
  pulse?: boolean;
}

export function AtruneMark({ size = 24, className, pulse }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Atrune"
      className={className}
    >
      <g strokeLinecap="round" fill="none">
        <g stroke="#0F2A4F" strokeWidth="1" opacity="0.55">
          <line x1="27.67" y1="13.5" x2="22" y2="24" />
          <line x1="36.33" y1="13.5" x2="42" y2="24" />
          <line x1="22" y1="24" x2="12" y2="52" />
          <line x1="42" y1="24" x2="52" y2="52" />
        </g>
        <g stroke="#14B8A6" strokeWidth="1.3" opacity="0.85">
          <line x1="22" y1="24" x2="32" y2="37" />
          <line x1="42" y1="24" x2="32" y2="37" />
        </g>
      </g>
      <g transform="translate(32 11)">
        <path
          d="M0 -5 L4.33 -2.5 L4.33 2.5 L0 5 L-4.33 2.5 L-4.33 -2.5 Z"
          fill="white"
          stroke="#0F2A4F"
          strokeWidth="0.8"
          strokeLinejoin="round"
          opacity="0.95"
        />
        <g stroke="#0F2A4F" strokeWidth="0.6" opacity="0.45">
          <line x1="0" y1="0" x2="0" y2="-5" />
          <line x1="0" y1="0" x2="4.33" y2="-2.5" />
          <line x1="0" y1="0" x2="-4.33" y2="-2.5" />
        </g>
      </g>
      {[
        { x: 22, y: 24 },
        { x: 42, y: 24 },
        { x: 12, y: 52 },
        { x: 52, y: 52 },
      ].map((c) => (
        <g key={`${c.x}-${c.y}`} transform={`translate(${c.x} ${c.y})`}>
          <path d="M0 -5 L4.33 -2.5 L0 0 L-4.33 -2.5 Z" fill="#3D5A85" />
          <path d="M4.33 -2.5 L4.33 2.5 L0 5 L0 0 Z" fill="#1E3A5F" />
          <path d="M-4.33 -2.5 L-4.33 2.5 L0 5 L0 0 Z" fill="#0F2A4F" />
          <path
            d="M0 -5 L4.33 -2.5 L4.33 2.5 L0 5 L-4.33 2.5 L-4.33 -2.5 Z"
            fill="none"
            stroke="#0F2A4F"
            strokeWidth="0.5"
            strokeLinejoin="round"
          />
        </g>
      ))}
      <g
        transform="translate(32 37)"
        className={pulse ? 'animate-pulse' : undefined}
      >
        <path d="M0 -5 L4.33 -2.5 L0 0 L-4.33 -2.5 Z" fill="#5EEAD4" />
        <path d="M4.33 -2.5 L4.33 2.5 L0 5 L0 0 Z" fill="#14B8A6" />
        <path d="M-4.33 -2.5 L-4.33 2.5 L0 5 L0 0 Z" fill="#0F766E" />
        <path
          d="M0 -5 L4.33 -2.5 L4.33 2.5 L0 5 L-4.33 2.5 L-4.33 -2.5 Z"
          fill="none"
          stroke="#0F2A4F"
          strokeWidth="0.5"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
