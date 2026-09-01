import { useEffect, useState } from "preact/hooks";

interface ArticleToolsProps {
  slug: string;
}

const STORAGE_PREFIX = "quiet-line:saved:";

function storageKey(slug: string): string {
  return `${STORAGE_PREFIX}${slug}`;
}

function clampProgress(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function copyWithSelection(value: string): boolean {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textArea.remove();
  return copied;
}

export default function ArticleTools({ slug }: ArticleToolsProps) {
  const [hydrated, setHydrated] = useState(false);
  const [saved, setSaved] = useState(false);
  const [progress, setProgress] = useState(0);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    setHydrated(true);
    try {
      setSaved(localStorage.getItem(storageKey(slug)) === "1");
    } catch {
      // Private browsing and restricted storage should not disable reading.
    }

    const updateProgress = () => {
      const target = document.querySelector<HTMLElement>(
        "[data-reading-target]",
      );
      if (!target) return;

      const top = globalThis.scrollY + target.getBoundingClientRect().top;
      const distance = Math.max(
        1,
        target.offsetHeight - globalThis.innerHeight,
      );
      setProgress(clampProgress(((globalThis.scrollY - top) / distance) * 100));
    };

    updateProgress();
    globalThis.addEventListener("scroll", updateProgress, { passive: true });
    globalThis.addEventListener("resize", updateProgress);
    return () => {
      globalThis.removeEventListener("scroll", updateProgress);
      globalThis.removeEventListener("resize", updateProgress);
    };
  }, [slug]);

  const announce = (message: string) => {
    setFeedback(message);
    globalThis.setTimeout(() => setFeedback(""), 2600);
  };

  const toggleSaved = () => {
    const next = !saved;
    setSaved(next);
    try {
      if (next) {
        localStorage.setItem(storageKey(slug), "1");
      } else {
        localStorage.removeItem(storageKey(slug));
      }
    } catch {
      // Keep the in-memory toggle useful even when storage is unavailable.
    }
    announce(next ? "Saved on this device" : "Removed from saved notes");
  };

  const copyLink = async () => {
    const url = globalThis.location.href;
    let copied = false;
    try {
      if (typeof navigator.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) copied = copyWithSelection(url);
    announce(copied ? "Link copied" : "Copy failed; use the address bar");
  };

  const shareLink = async () => {
    const url = globalThis.location.href;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: document.title, url });
        announce("Shared");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }
    await copyLink();
  };

  return (
    <div class={`article-tools ${hydrated ? "is-ready" : ""}`}>
      <div
        class="article-progress"
        role="progressbar"
        aria-label="Reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }}></span>
      </div>
      <div class="article-tool-actions">
        <button
          type="button"
          class="article-tool-button"
          aria-pressed={saved}
          onClick={toggleSaved}
        >
          {saved ? "Saved" : "Save note"}
        </button>
        <button
          type="button"
          class="article-tool-button"
          onClick={copyLink}
        >
          Copy link
        </button>
        <button
          type="button"
          class="article-tool-button article-tool-share"
          onClick={shareLink}
        >
          Share
        </button>
      </div>
      <span class="article-tool-feedback" aria-live="polite">
        {feedback}
      </span>
    </div>
  );
}
