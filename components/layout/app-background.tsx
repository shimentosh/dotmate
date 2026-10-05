/**
 * Ambient app background — a soft CapCut-style brand-blue gradient glow behind the
 * app content. Pure CSS, theme-aware (light/dark via CSS vars in globals.css).
 * Sits behind the app content (the topbar, sidebar and main area are transparent
 * so this shows through as one seamless surface).
 */
export default function AppBackground() {
  return (
    <div aria-hidden className="app-bg pointer-events-none absolute inset-0 overflow-hidden">
      <div className="app-bg-gradient" />
    </div>
  );
}
