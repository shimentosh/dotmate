"use client";
import * as React from "react";
import { brand } from "@/brand.config";

/** DotMirror symbol (the mark from dotmirror.com's logo), two interlocking pieces. */
export const MARK_BLUE_PATH =
  "M12.5789 15.9892H20.9785C21.103 15.9892 21.2178 15.9277 21.2857 15.8243L30.7347 1.52637H11.6218C7.99514 1.52637 4.90694 4.16832 4.34589 7.7529L0.661063 31.2717C0.486442 32.389 1.34985 33.3979 2.48003 33.3979H4.31032L9.439 18.2415C9.89495 16.8946 11.1561 15.9892 12.5789 15.9892Z";
export const MARK_SHAPE_PATH =
  "M35.4865 1.52637H34.2673L23.7448 17.4492C23.1288 18.3805 22.0956 18.9367 20.98 18.9367H12.5804C12.4219 18.9367 12.2829 19.037 12.2311 19.1873L7.42261 33.3995H25.9922C29.5801 33.3995 32.6456 30.8158 33.2519 27.2797L37.3006 3.68002C37.493 2.55469 36.628 1.52637 35.4865 1.52637Z";

/**
 * The app mark — the DotMirror symbol. The blue piece is always the brand accent;
 * the other piece follows the theme like DotMirror's own logo (black on light,
 * white on dark). `tone="light"` forces white for always-dark surfaces (splash).
 */
export function BrandMark({ size = 28, className = "", tone = "auto" }: {
  size?: number; className?: string; tone?: "auto" | "light";
}) {
  return (
    <svg width={size} height={size} viewBox="0 -1.5 38 38" fill="none" xmlns="http://www.w3.org/2000/svg"
      className={`${tone === "light" ? "text-white" : "text-zinc-900 dark:text-white"} ${className}`} aria-hidden="true">
      <path d={MARK_BLUE_PATH} fill={brand.accent} />
      <path d={MARK_SHAPE_PATH} fill="currentColor" />
    </svg>
  );
}
