import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0d10',
        surface: '#13161b',
        line: '#1f242c',
        ink: '#e6eaf0',
        dim: '#8a93a0',
        accent: '#7cf2c8',
        warn: '#ffb454',
        err: '#ff6b6b',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
