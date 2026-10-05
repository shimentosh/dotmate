"use client";

import Link, { type LinkProps } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { useNavGuard } from "@/contexts/nav-guard-context";
import { isBusyForNav } from "@/store/active-tasks";

type GuardedLinkProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    children?: ReactNode;
  };

function hrefToString(href: LinkProps["href"]): string {
  return typeof href === "string" ? href : href.toString();
}

/**
 * Drop-in replacement for `next/link` that warns before navigating away while a
 * kill-on-nav task is running. Uses Next 16's `<Link onNavigate>` — which fires
 * synchronously before client navigation and can `preventDefault()` — so the
 * busy check must be synchronous; the async confirm re-issues the nav on "Leave".
 *
 * No-op (plain Link) when nothing is running, or when only the query/hash of the
 * current path changes (no unmount → nothing to lose).
 */
export const GuardedLink = forwardRef<HTMLAnchorElement, GuardedLinkProps>(
  function GuardedLink({ href, onNavigate, children, ...rest }, ref) {
    const router = useRouter();
    const pathname = usePathname();
    const { confirmLeave } = useNavGuard();

    return (
      <Link
        ref={ref}
        href={href}
        {...rest}
        onNavigate={(e) => {
          onNavigate?.(e);
          if (!isBusyForNav()) return;
          const target = hrefToString(href);
          const targetPath = target.split(/[?#]/)[0];
          // Same-pathname change (query/hash only) doesn't unmount → don't guard.
          if (targetPath === "" || targetPath === pathname) return;
          e.preventDefault();
          void confirmLeave().then((leave) => {
            if (!leave) return;
            if (rest.replace) router.replace(target);
            else router.push(target);
          });
        }}
      >
        {children}
      </Link>
    );
  },
);
