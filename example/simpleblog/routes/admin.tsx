import { page } from "fresh";
import { Head } from "fresh/runtime";
import {
  dateInputValue,
  formatPostDate,
  getPost,
  isStorageAvailable,
  listPosts,
  type Post,
} from "../data/posts.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const posts = await listPosts({ includeDrafts: true });
    const editSlug = ctx.url.searchParams.get("edit") ?? "";
    const editing = editSlug ? await getPost(editSlug, true) : null;
    const storageAvailable = await isStorageAvailable();
    let publishingEnabled = false;
    try {
      publishingEnabled = Boolean(
        Deno.env.get("QUIETLINE_ADMIN_TOKEN")?.trim(),
      );
    } catch {
      publishingEnabled = false;
    }
    return page({
      posts,
      editing,
      editMissing: Boolean(editSlug && !editing),
      tokenConfigured: publishingEnabled,
      storageAvailable,
      saved: ctx.url.searchParams.get("saved"),
      deleted: ctx.url.searchParams.has("deleted"),
      updated: ctx.url.searchParams.has("updated"),
      error: ctx.url.searchParams.get("error"),
    }, {
      headers: {
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  },
});

function readingMinutes(post: Post | null): number {
  const minutes = Number.parseInt(post?.read ?? "5", 10);
  return Number.isFinite(minutes) ? minutes : 5;
}

export default define.page<typeof handler>(function Admin({ data }) {
  const post = data.editing;
  const publishedCount = data.posts.filter((item) =>
    item.status === "published"
  ).length;
  const publishingReady = data.tokenConfigured && data.storageAvailable;

  return (
    <>
      <Head>
        <title>Editorial desk — Quiet line</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div class="admin-shell">
        <a class="skip-link" href="#admin-content">Skip to editor</a>
        <header class="admin-topbar container">
          <a
            class="wordmark"
            href="/admin"
            aria-label="Quiet line editorial desk"
          >
            <span class="wordmark-mark" aria-hidden="true">ql</span>
            <span>editorial desk</span>
          </a>
          <nav aria-label="Editor navigation">
            <a href="/">View site</a>
            <a href="/archive">Archive</a>
          </nav>
          <span
            class={`system-status ${publishingReady ? "is-ready" : ""}`}
          >
            <i aria-hidden="true"></i>
            {publishingReady
              ? "Publishing ready"
              : data.tokenConfigured
              ? "Storage offline"
              : "Read only"}
          </span>
        </header>

        <main id="admin-content" class="admin-main container">
          <header class="admin-intro">
            <div>
              <p class="eyebrow">Quiet line / Deno KV</p>
              <h1>{post ? "Refine the note." : "Make room for an idea."}</h1>
            </div>
            <dl class="admin-totals">
              <div>
                <dt>Published</dt>
                <dd>{publishedCount}</dd>
              </div>
              <div>
                <dt>Drafts</dt>
                <dd>{data.posts.length - publishedCount}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{data.posts.length}</dd>
              </div>
            </dl>
          </header>

          {!data.tokenConfigured && (
            <div class="admin-notice is-warning" role="status">
              Set <code>QUIETLINE_ADMIN_TOKEN</code> before saving changes.
            </div>
          )}
          {data.tokenConfigured && !data.storageAvailable && (
            <div class="admin-notice is-error" role="alert">
              Deno KV is unavailable. Check <code>QUIETLINE_KV_PATH</code>{" "}
              and restart the server before saving.
            </div>
          )}
          {data.saved && (
            <div class="admin-notice is-success" role="status">
              The note was saved to Deno KV.
            </div>
          )}
          {data.deleted && (
            <div class="admin-notice is-success" role="status">
              The note was removed from the archive.
            </div>
          )}
          {data.updated && (
            <div class="admin-notice is-success" role="status">
              Publication status updated.
            </div>
          )}
          {(data.error || data.editMissing) && (
            <div class="admin-notice is-error" role="alert">
              {data.error ?? "That note could not be found."}
            </div>
          )}

          <section class="admin-compose" aria-labelledby="compose-title">
            <div class="admin-section-heading">
              <div>
                <p class="eyebrow">{post ? "Editing" : "New note"}</p>
                <h2 id="compose-title">{post?.title ?? "Untitled draft"}</h2>
              </div>
              {post && <a href="/admin">Start a new note</a>}
            </div>

            <form class="editor-form" method="post" action="/api/posts">
              {post && (
                <input type="hidden" name="originalSlug" value={post.slug} />
              )}

              <div class="field field-wide">
                <label htmlFor="title">Title</label>
                <input
                  id="title"
                  name="title"
                  type="text"
                  value={post?.title ?? ""}
                  minLength={3}
                  maxLength={140}
                  placeholder="A clear, specific title"
                  required
                />
              </div>

              <div class="field">
                <label htmlFor="category">Category</label>
                <input
                  id="category"
                  name="category"
                  type="text"
                  value={post?.category ?? "Field notes"}
                  minLength={2}
                  maxLength={40}
                  required
                />
              </div>
              <div class="field">
                <label htmlFor="slug">URL slug</label>
                <input
                  id="slug"
                  name="slug"
                  type="text"
                  value={post?.slug ?? ""}
                  maxLength={96}
                  placeholder="generated-from-the-title"
                />
              </div>

              <div class="field field-wide">
                <label htmlFor="excerpt">Excerpt</label>
                <textarea
                  id="excerpt"
                  name="excerpt"
                  rows={3}
                  minLength={20}
                  maxLength={280}
                  placeholder="The short promise shown in the archive."
                  required
                >
                  {post?.excerpt ?? ""}
                </textarea>
              </div>

              <div class="field field-wide">
                <label htmlFor="body">Article</label>
                <textarea
                  id="body"
                  name="body"
                  rows={15}
                  minLength={80}
                  maxLength={30_000}
                  placeholder="Begin with the thought that keeps returning."
                  required
                >
                  {post?.body ?? ""}
                </textarea>
                <span class="field-hint">
                  Paragraphs are separated by a blank line.
                </span>
              </div>

              <div class="field field-wide">
                <label htmlFor="image">Cover image</label>
                <input
                  id="image"
                  name="image"
                  type="url"
                  value={post?.image ?? ""}
                  placeholder="https://images.unsplash.com/..."
                  required
                />
              </div>
              <div class="field field-wide">
                <label htmlFor="imageAlt">Image description</label>
                <input
                  id="imageAlt"
                  name="imageAlt"
                  type="text"
                  value={post?.imageAlt ?? ""}
                  minLength={5}
                  maxLength={180}
                  placeholder="Describe what is visible in the cover"
                  required
                />
              </div>

              <div class="field field-small">
                <label htmlFor="publishedAt">Publication date</label>
                <input
                  id="publishedAt"
                  name="publishedAt"
                  type="date"
                  value={dateInputValue(
                    post?.publishedAt ?? new Date().toISOString(),
                  )}
                  required
                />
              </div>
              <div class="field field-small">
                <label htmlFor="readingMinutes">Reading time</label>
                <div class="number-field">
                  <input
                    id="readingMinutes"
                    name="readingMinutes"
                    type="number"
                    value={readingMinutes(post)}
                    min={1}
                    max={99}
                    required
                  />
                  <span>min</span>
                </div>
              </div>
              <div class="field field-small">
                <label htmlFor="status">Status</label>
                <select
                  id="status"
                  name="status"
                  value={post?.status ?? "draft"}
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                </select>
              </div>
              <label class="check-field">
                <input
                  type="checkbox"
                  name="featured"
                  checked={post?.featured ?? false}
                />
                <span>
                  <b>Feature on home</b>
                  <small>Uses this note as the lead story.</small>
                </span>
              </label>

              <div class="field field-token">
                <label htmlFor="adminToken">Admin token</label>
                <input
                  id="adminToken"
                  name="adminToken"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellcheck={false}
                  required
                />
              </div>

              <div class="editor-actions">
                <button class="admin-primary" type="submit">
                  {post ? "Save changes" : "Save note"}
                </button>
                {post && (
                  <button
                    class="admin-danger"
                    type="submit"
                    name="action"
                    value="delete"
                  >
                    Delete note
                  </button>
                )}
                <span>Changes are written directly to Deno KV.</span>
              </div>
            </form>
          </section>

          <section class="admin-library" aria-labelledby="library-title">
            <div class="admin-section-heading">
              <div>
                <p class="eyebrow">Library</p>
                <h2 id="library-title">All notes</h2>
              </div>
              <span>{data.posts.length} records</span>
            </div>

            <div class="admin-posts">
              {data.posts.length > 0
                ? data.posts.map((item) => (
                  <article class="admin-post-row" key={item.id}>
                    <img src={item.image} alt="" loading="lazy" />
                    <div class="admin-post-copy">
                      <div>
                        <span class={`post-status is-${item.status}`}>
                          {item.status}
                        </span>
                        {item.featured && (
                          <span class="featured-label">Featured</span>
                        )}
                      </div>
                      <h3>{item.title}</h3>
                      <p>
                        {item.category} · {formatPostDate(item.publishedAt)} ·
                        {" "}
                        {item.read}
                      </p>
                    </div>
                    <div class="admin-row-actions">
                      {item.status === "published" && (
                        <a href={`/article/${encodeURIComponent(item.slug)}`}>
                          View
                        </a>
                      )}
                      <a href={`/admin?edit=${encodeURIComponent(item.slug)}`}>
                        Edit
                      </a>
                    </div>
                  </article>
                ))
                : (
                  <div class="empty-state">
                    <p>No notes yet. The editor is ready.</p>
                  </div>
                )}
            </div>
          </section>
        </main>
      </div>
    </>
  );
});
