/**
 * Brand configuration — the ONE place the product's user-visible identity lives.
 *
 * Rebranding = edit this file, plus the literal `productName` / `identifier` /
 * `mainBinaryName` / window titles in `src-tauri/tauri.conf.json` (Tauri reads
 * those at build time and cannot import TypeScript), the `<title>` in
 * `public/splashscreen.html`, and the `BRAND_*` constants in
 * `src-tauri/src/branding.rs`.
 */
export const brand = {
  /** Display name shown in the window chrome, splash, About section, titles. */
  name: "DotMate",
  /**
   * Short machine slug — prefixes every localStorage key / DOM event name. Kept from
   * the original build so existing installs keep their settings (changing it resets
   * them and re-runs first-run setup; public/theme-init.js hard-codes it too).
   */
  slug: "free-tools",
  /** One-line description (About section, <meta name="description">). */
  tagline: "Local-first video, audio and AI tools that run on your computer.",
  /** Accent gradient used for primary buttons and the brand mark. */
  accentFrom: "#3D7EFD",
  accentTo: "#0047D1",
  /** Solid accent (focus rings, active indicators). */
  accent: "#0057FC",
  /**
   * Support / website URL shown in Settings → About. Empty = hidden. Set this to
   * the vendor's own support page before shipping.
   */
  supportUrl: "https://github.com/shimentosh/dotmate",
  /** "Developed by" credit — sidebar footer, Settings → About, splash screen. */
  developer: {
    name: "DotMirror",
    url: "https://dotmirror.com/",
    /** Wordmark for light / dark surfaces (public/brand/). */
    logoOnLight: "/brand/dotmirror-logo-dark-text.svg",
    logoOnDark: "/brand/dotmirror-logo-light-text.svg",
    /** Personal site shown next to the credit. */
    personalUrl: "http://shimanto.xyz/",
    personalLabel: "shimanto.xyz",
  },
} as const;

/** Namespaced storage key: `free-tools:<key>`. Use for every localStorage key. */
export function storageKey(key: string): string {
  return `${brand.slug}:${key}`;
}
