import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Layered greys for depth
        bg:       '#07090c',
        surface:  '#0f1318',
        surface2: '#161b22',
        line:     '#222933',
        line2:    '#2e3744',
        ink:      '#e6eaf0',
        ink2:     '#c2c9d4',
        dim:      '#7a8392',
        dim2:     '#525a67',
        // Accents
        accent:   '#5cf2c0',
        accent2:  '#26d3a3',
        warn:     '#ffb454',
        warn2:    '#f59e0b',
        err:      '#ff6b6b',
        err2:     '#dc2626',
        // Tier colors (model-aware)
        haiku:    '#5cc8a8',
        sonnet:   '#a98cf2',
        opus:     '#f29ccb',
        // Subtle info
        info:     '#7dd3fc',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
      },
      boxShadow: {
        soft:  '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 1px 2px 0 rgba(0,0,0,0.4)',
        glow:  '0 0 24px -8px rgba(92,242,192,0.35)',
        glowR: '0 0 24px -8px rgba(255,107,107,0.35)',
      },
      animation: {
        pulse: 'pulse 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 1.4s linear infinite',
        slideUp: 'slideUp 0.18s ease-out',
        fadeIn: 'fadeIn 0.14s ease-out',
      },
      keyframes: {
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        slideUp: {
          '0%':   { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)',   opacity: '1' },
        },
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
export default config;
