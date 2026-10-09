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
        ink: {
          950: '#060b09',
          900: '#0a120f',
          850: '#0e1814',
          800: '#121e19',
          700: '#1a2a23',
          600: '#25392f',
          500: '#3a5246',
        },
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(16,185,129,0.25), 0 8px 30px -12px rgba(16,185,129,0.45)',
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 10px 30px -18px rgba(0,0,0,0.8)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'none' } },
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgba(16,185,129,0.55)' },
          '100%': { boxShadow: '0 0 0 10px rgba(16,185,129,0)' },
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
      },
      animation: {
        'fade-in': 'fade-in 220ms ease-out both',
        'pulse-ring': 'pulseRing 1.4s ease-out infinite',
        shimmer: 'shimmer 2.2s linear infinite',
      },
    },
  },
  plugins: [],
};
