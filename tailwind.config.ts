import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        "surface-2": "var(--color-surface-2)",
        fg: "var(--color-fg)",
        muted: "var(--color-muted)",
        accent: "var(--color-accent)",
        edge: "var(--color-border)",
        success: "var(--color-success)",
        warn: "var(--color-warn)",
        error: "var(--color-error)",
        info: "var(--color-info)",
        brass: "var(--color-brass)",
        parchment: "var(--color-parchment)",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        command: ["var(--font-command)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
