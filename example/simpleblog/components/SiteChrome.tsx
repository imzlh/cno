import type { ComponentChildren } from "preact";

interface SiteHeaderProps {
  active?: "latest" | "archive";
  actionHref?: string;
  actionLabel?: string;
}

export function SiteHeader({
  active,
  actionHref = "/#newsletter",
  actionLabel = "Get the letter",
}: SiteHeaderProps) {
  return (
    <header class="site-header container">
      <a class="wordmark" href="/" aria-label="Quiet line home">
        <span class="wordmark-mark" aria-hidden="true">ql</span>
        <span>quiet line</span>
      </a>
      <nav class="site-nav" aria-label="Primary navigation">
        <a class={active === "latest" ? "active" : undefined} href="/#latest">
          Latest
        </a>
        <a
          class={active === "archive" ? "active" : undefined}
          href="/archive"
        >
          Archive
        </a>
        <a href="/#about">About</a>
      </nav>
      <a class="header-link" href={actionHref}>
        {actionLabel} <span aria-hidden="true">-&gt;</span>
      </a>
    </header>
  );
}

interface SiteFooterProps {
  children?: ComponentChildren;
}

export function SiteFooter({ children }: SiteFooterProps) {
  return (
    <footer class="site-footer container">
      <span class="footer-mark">ql / 26</span>
      <span>{children ?? "Made slowly on the internet."}</span>
      <div class="footer-links">
        <a href="/archive">Archive</a>
        <a href="/feed.xml">RSS</a>
        <a href="mailto:hello@quietline.example">Contact</a>
        <a href="/admin">Editor</a>
      </div>
    </footer>
  );
}
