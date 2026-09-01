import { useEffect, useState } from "preact/hooks";

interface AdminEditorAssistProps {
  initialBody: string;
  initialSlug: string;
  initialTitle: string;
}

function slugify(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function Preview({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/).map((block) => block.trim()).filter(
    Boolean,
  );
  return (
    <div class="editor-preview-body">
      {blocks.length === 0
        ? (
          <p class="editor-preview-empty">
            Your note preview will appear here.
          </p>
        )
        : blocks.map((block, index) => {
          if (block.startsWith("## ")) {
            return <h3 key={index}>{block.slice(3)}</h3>;
          }
          if (block.startsWith("> ")) {
            return <blockquote key={index}>{block.slice(2)}</blockquote>;
          }
          if (block.split("\n").every((line) => line.startsWith("- "))) {
            return (
              <ul key={index}>
                {block.split("\n").map((line) => (
                  <li key={line}>{line.slice(2)}</li>
                ))}
              </ul>
            );
          }
          return <p key={index}>{block}</p>;
        })}
    </div>
  );
}

export default function AdminEditorAssist({
  initialBody,
  initialSlug,
  initialTitle,
}: AdminEditorAssistProps) {
  const [title, setTitle] = useState(initialTitle);
  const [slug, setSlug] = useState(initialSlug);
  const [body, setBody] = useState(initialBody);
  const [previewing, setPreviewing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const minutes = Math.max(1, Math.ceil(words / 200));

  useEffect(() => {
    const form = document.querySelector<HTMLFormElement>("#post-editor");
    if (!form) return;
    const titleField = form.elements.namedItem("title") as
      | HTMLInputElement
      | null;
    const slugField = form.elements.namedItem("slug") as
      | HTMLInputElement
      | null;
    const bodyField = form.elements.namedItem("body") as
      | HTMLTextAreaElement
      | null;
    if (!titleField || !slugField || !bodyField) return;

    let slugWasEdited = Boolean(
      slugField.value && slugField.value !== slugify(titleField.value),
    );
    const handleTitle = () => {
      setTitle(titleField.value);
      setDirty(true);
      if (!slugWasEdited) {
        const nextSlug = slugify(titleField.value);
        slugField.value = nextSlug;
        setSlug(nextSlug);
      }
    };
    const handleSlug = () => {
      slugWasEdited = true;
      setSlug(slugField.value);
      setDirty(true);
    };
    const handleBody = () => {
      setBody(bodyField.value);
      setDirty(true);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLocaleLowerCase() === "s"
      ) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };

    titleField.addEventListener("input", handleTitle);
    slugField.addEventListener("input", handleSlug);
    bodyField.addEventListener("input", handleBody);
    document.addEventListener("keydown", handleKey);
    globalThis.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      titleField.removeEventListener("input", handleTitle);
      slugField.removeEventListener("input", handleSlug);
      bodyField.removeEventListener("input", handleBody);
      document.removeEventListener("keydown", handleKey);
      globalThis.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [dirty]);

  return (
    <div class="editor-assist">
      <div class="editor-assist-stats" aria-live="polite">
        <span>
          <b>{words}</b> words
        </span>
        <span>
          <b>{minutes}</b> min read
        </span>
        <span class={dirty ? "is-dirty" : ""}>
          {dirty ? "Unsaved changes" : "Ready to publish"}
        </span>
        {slug && <span class="editor-slug">/{slug}</span>}
      </div>
      <button
        type="button"
        class="editor-preview-toggle"
        aria-expanded={previewing}
        onClick={() => setPreviewing((value) => !value)}
      >
        {previewing ? "Close preview" : "Preview note"}
      </button>
      {previewing && (
        <section class="editor-preview" aria-label="Note preview">
          <div class="editor-preview-head">
            <span>Reader preview</span>
            <span>{title || "Untitled note"}</span>
          </div>
          <h2>{title || "Untitled note"}</h2>
          <Preview body={body} />
        </section>
      )}
    </div>
  );
}
