/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Neutral surfaces. Emerald (Tailwind default) is reserved for gains / success.
        canvas: '#0A0A0B',
        surface: '#121215',
        elevated: '#18181B',
        line: '#27272A',
        'line-strong': '#3F3F46',
        crimson: '#E11D48',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(2px)' }, to: { opacity: 1, transform: 'none' } },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out both',
      },
    },
  },
  plugins: [],
};
