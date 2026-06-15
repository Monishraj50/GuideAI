// Atrium.AI brand mark.
//
// A stylized "A" built from two diagonal walls + a horizontal crossbeam, with
// a small filled circle at the apex: the *oculus*, the central opening in a
// Roman atrium that lets light in. Reads as both the letter A and the
// architectural cross-section.
//
// Designed to look intentional at sizes 14–64. Larger sizes get a thicker
// stroke proportionally. Color is `currentColor` so it inherits from parent
// (use `text-bg` on a gradient box, or `text-accent` standalone).

interface Props {
  size?: number;
  className?: string;
  /** When true, the oculus dot pulses gently — useful on the sign-in hero. */
  pulse?: boolean;
}

export function AtriumMark({ size = 14, className, pulse }: Props) {
  // viewBox 24×24; lines + dot scale with the container.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Atrium"
      className={className}
    >
      {/* Left wall of the A */}
      <path
        d="M3.5 21 L12 4.2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      {/* Right wall of the A */}
      <path
        d="M20.5 21 L12 4.2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      {/* Crossbeam — the impluvium edge at the floor of the courtyard */}
      <path
        d="M7.5 14.5 L16.5 14.5"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      {/* Oculus — the opening at the apex that lets light in */}
      <circle
        cx="12"
        cy="8.6"
        r="1.55"
        fill="currentColor"
        className={pulse ? 'animate-pulse' : undefined}
      />
    </svg>
  );
}
