/**
 * The route map — labels + parents for every page, shared by the sidebar (nav
 * groups) and the title bar (breadcrumb). Adding a tool = one entry here plus its
 * card in components/tool-gallery.tsx.
 */
import {
  Home, Scissors, Film, Shuffle, Images, GalleryHorizontal, Music2, Mic, Layers,
  Ear, FileText, Wand2, Download, type LucideIcon,
} from "lucide-react";

export interface RouteEntry {
  label: string;
  parent?: string;
}

export const ROUTES: Record<string, RouteEntry> = {
  "/":                                      { label: "Home" },
  "/tools":                                 { label: "Tools" },
  "/tools/quick-trim":                      { label: "Quick Trim",        parent: "/tools" },
  "/tools/video-trimmer":                   { label: "Quick Trim",        parent: "/tools" },
  "/tools/merger":                          { label: "Clip Merger",       parent: "/tools" },
  "/tools/audio-merger":                    { label: "Audio Toolkit",     parent: "/tools" },
  "/tools/file-shuffler":                   { label: "File Shuffler",     parent: "/tools" },
  "/tools/video-downloader":                { label: "Video Downloader",  parent: "/tools" },
  "/tools/bulk-voice":                      { label: "Bulk Voice",        parent: "/tools" },
  "/video-studio":                          { label: "Studio" },
  "/video-studio/image-to-video":           { label: "Image to Video",    parent: "/video-studio" },
  "/video-studio/carousel-to-video":        { label: "Carousel Video",    parent: "/video-studio" },
  "/video-studio/text-to-voice":            { label: "AI Voiceover",      parent: "/video-studio" },
  "/video-studio/voice-to-text":            { label: "Speech to Text",    parent: "/video-studio" },
  "/video-studio/script-writer":            { label: "Script Writer",     parent: "/video-studio" },
  "/video-studio/script-to-image-prompts":  { label: "Script to Image Prompts", parent: "/video-studio" },
  "/setup":                                 { label: "Setup" },
};

export interface NavItem { href: string; label: string; icon: LucideIcon }
export interface NavGroup { section?: string; items: NavItem[] }

/** Sidebar navigation, grouped by what the tool works on. */
export const NAV: NavGroup[] = [
  { items: [{ href: "/", label: "Home", icon: Home }] },
  {
    section: "Video",
    items: [
      { href: "/tools/quick-trim",               label: "Quick Trim",       icon: Scissors },
      { href: "/tools/merger",                   label: "Clip Merger",      icon: Film },
      { href: "/video-studio/image-to-video",    label: "Image to Video",   icon: Images },
      { href: "/video-studio/carousel-to-video", label: "Carousel Video",   icon: GalleryHorizontal },
      { href: "/tools/file-shuffler",            label: "File Shuffler",    icon: Shuffle },
    ],
  },
  {
    section: "Audio & Voice",
    items: [
      { href: "/tools/audio-merger",             label: "Audio Toolkit",    icon: Music2 },
      { href: "/video-studio/text-to-voice",     label: "AI Voiceover",     icon: Mic },
      { href: "/tools/bulk-voice",               label: "Bulk Voice",       icon: Layers },
      { href: "/video-studio/voice-to-text",     label: "Speech to Text",   icon: Ear },
    ],
  },
  {
    section: "Writing",
    items: [
      { href: "/video-studio/script-writer",           label: "Script Writer",  icon: FileText },
      { href: "/video-studio/script-to-image-prompts", label: "Image Prompts",  icon: Wand2 },
    ],
  },
  {
    section: "Download",
    items: [
      { href: "/tools/video-downloader",         label: "Video Downloader", icon: Download },
    ],
  },
];

/* Title-case a raw route segment for a fallback label ("quick-trim" → "Quick Trim"). */
const MINOR_WORDS = new Set(["to", "a", "an", "the", "of", "and", "or", "for", "in", "on", "with", "by", "vs"]);
const ACRONYMS: Record<string, string> = { ai: "AI", tts: "TTS", stt: "STT", url: "URL", mp4: "MP4" };
export function prettifySegment(seg: string): string {
  const words = seg.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return "Home";
  return words
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (ACRONYMS[lw]) return ACRONYMS[lw];
      if (i > 0 && MINOR_WORDS.has(lw)) return lw;
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(" ");
}

/** Resolve a pathname (with or without a trailing slash) to its route entry. */
export function routeFor(pathname: string): RouteEntry {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES[p] ?? { label: prettifySegment(p.split("/").filter(Boolean).pop() ?? "") };
}
