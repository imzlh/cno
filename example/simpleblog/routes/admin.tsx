import { page } from "fresh";
import { Head } from "fresh/runtime";
import AdminEditorAssist from "../islands/AdminEditorAssist.tsx";
import { isAdminRequest } from "../data/auth.ts";
import {
  dateInputValue,
  formatPostDate,
  getPost,
  isPublicPost,
  isStorageAvailable,
  listPosts,
  type Post,
} from "../data/posts.ts";
import {
  listSubscribers,
  maskEmail,
  type Subscriber,
} from "../data/subscribers.ts";
import { define } from "../utils.ts";

type AdminView = "overview" | "posts" | "compose" | "subscribers";

interface AdminData {
  allPosts: Post[];
  posts: Post[];
  subscribers: Subscriber[];
  editing: Post | null;
  view: AdminView;
  query: string;
  status: string;
  subscriberQuery: string;
  editMissing: boolean;
  tokenConfigured: boolean;
  storageAvailable: boolean;
  publishedCount: number;
  draftCount: number;
  scheduledCount: number;
  activeSubscribers: number;
  saved: string | null;
  deleted: boolean;
  updated: boolean;
  subscriberRemoved: boolean;
  error: string | null;
}

function viewValue(value: string | null): AdminView {
  return value === "posts" || value === "compose" || value === "subscribers"
    ? value
    : "overview";
}

function isScheduled(post: Post): boolean {
  return post.status === "published" &&
    Date.parse(post.publishedAt) > Date.now();
}

function statusLabel(post: Post): string {
  return isScheduled(post) ? "scheduled" : post.status;
}

function readingMinutes(post: Post | null): number {
  const minutes = Number.parseInt(post?.read ?? "5", 10);
  return Number.isFinite(minutes) ? minutes : 5;
}

function matchesPost(post: Post, query: string, status: string): boolean {
  const search = query.toLocaleLowerCase();
  const matchesQuery = !search ||
    [post.title, post.excerpt, post.body, post.category]
      .join(" ").toLocaleLowerCase().includes(search);
  const matchesStatus = !status ||
    (status === "scheduled" ? isScheduled(post) : post.status === status);
  return matchesQuery && matchesStatus;
}

export const handler = define.handlers({
  async GET(ctx) {
    if (!await isAdminRequest(ctx.req)) {
      const next = encodeURIComponent(`${ctx.url.pathname}${ctx.url.search}`);
      return ctx.redirect(`/admin/login?next=${next}`, 303);
    }

    const allPosts = await listPosts({ includeDrafts: true });
    const editSlug = ctx.url.searchParams.get("edit") ?? "";
    const editing = editSlug ? await getPost(editSlug, true) : null;
    const requestedView = viewValue(ctx.url.searchParams.get("view"));
    const view: AdminView = editing ? "compose" : requestedView;
    const query = (ctx.url.searchParams.get("q") ?? "").trim();
    const status = (ctx.url.searchParams.get("status") ?? "").trim();
    const subscriberQuery = (ctx.url.searchParams.get("subscriber") ?? "")
      .trim();
    const posts = allPosts.filter((post) => matchesPost(post, query, status));
    const subscribers = (await listSubscribers()).filter((subscriber) =>
      !subscriberQuery ||
      subscriber.email.toLocaleLowerCase().includes(
        subscriberQuery.toLocaleLowerCase(),
      )
    );
    const storageAvailable = await isStorageAvailable();
    let tokenConfigured = false;
    try {
      tokenConfigured = Boolean(Deno.env.get("QUIETLINE_ADMIN_TOKEN")?.trim());
    } catch {
      tokenConfigured = false;
    }

    return page({
      allPosts,
      posts,
      subscribers,
      editing,
      view,
      query,
      status,
      subscriberQuery,
      editMissing: Boolean(editSlug && !editing),
      tokenConfigured,
      storageAvailable,
      publishedCount: allPosts.filter(isPublicPost).length,
      draftCount: allPosts.filter((post) => post.status === "draft").length,
      scheduledCount: allPosts.filter(isScheduled).length,
      activeSubscribers: subscribers.filter((item) =>
        item.status === "active"
      ).length,
      saved: ctx.url.searchParams.get("saved"),
      deleted: ctx.url.searchParams.has("deleted"),
      updated: ctx.url.searchParams.has("updated"),
      subscriberRemoved: ctx.url.searchParams.has("removed"),
      error: ctx.url.searchParams.get("error"),
    }, {
      headers: {
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  },
});

function Notice({
  data,
}: {
  data: AdminData;
}) {
  return (
    <div class="admin-notices" aria-live="polite">
      {!data.tokenConfigured && (
        <div class="admin-notice is-warning" role="status">
          Set <code>QUIETLINE_ADMIN_TOKEN</code> before saving changes.
        </div>
      )}
      {data.tokenConfigured && !data.storageAvailable && (
        <div class="admin-notice is-error" role="alert">
          Deno KV is unavailable. Check <code>QUIETLINE_KV_PATH</code>{" "}
          and restart the server.
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
      {data.subscriberRemoved && (
        <div class="admin-notice is-success" role="status">
          Subscriber removed.
        </div>
      )}
      {(data.error || data.editMissing) && (
        <div class="admin-notice is-error" role="alert">
          {data.error ?? "That note could not be found."}
        </div>
      )}
    </div>
  );
}

function WorkspaceNav({ active }: { active: AdminView }) {
  return (
    <nav class="admin-workspace-nav" aria-label="Editorial workspace">
      <a class={active === "overview" ? "is-active" : ""} href="/admin">
        Overview
      </a>
      <a class={active === "posts" ? "is-active" : ""} href="/admin?view=posts">
        Articles
      </a>
      <a
        class={active === "compose" ? "is-active" : ""}
        href="/admin?view=compose"
      >
        Write
      </a>
      <a
        class={active === "subscribers" ? "is-active" : ""}
        href="/admin?view=subscribers"
      >
        Subscribers
      </a>
    </nav>
  );
}

function PostRow({ item, compact = false }: { item: Post; compact?: boolean }) {
  const label = statusLabel(item);
  return (
    <article class={`admin-post-row ${compact ? "is-compact" : ""}`}>
      {!compact && <img src={item.image} alt="" loading="lazy" />}
      <div class="admin-post-copy">
        <div>
          <span class={`post-status is-${label}`}>{label}</span>
          {item.featured && <span class="featured-label">Featured</span>}
        </div>
        <h3>{item.title}</h3>
        <p>
          {item.category} · {formatPostDate(item.publishedAt)} · {item.read}
        </p>
      </div>
      <div class="admin-row-actions">
        {item.status === "published" && !isScheduled(item) && (
          <a href={`/article/${encodeURIComponent(item.slug)}`}>View</a>
        )}
        {(item.status !== "published" || isScheduled(item)) && (
          <a href={`/article/${encodeURIComponent(item.slug)}?preview=1`}>
            Preview
          </a>
        )}
        <a href={`/admin?view=compose&edit=${encodeURIComponent(item.slug)}`}>
          Edit
        </a>
        <form method="post" action="/api/posts">
          <input type="hidden" name="action" value="toggle" />
          <input type="hidden" name="slug" value={item.slug} />
          <input type="hidden" name="returnTo" value="/admin?view=posts" />
          <button type="submit">
            {item.status === "published" ? "Unpublish" : "Publish"}
          </button>
        </form>
      </div>
    </article>
  );
}

function Overview({ data }: { data: AdminData }) {
  const recent = data.allPosts.slice(0, 4);
  return (
    <div class="admin-overview">
      <dl class="admin-metrics">
        <div>
          <dt>Published</dt>
          <dd>{String(data.publishedCount).padStart(2, "0")}</dd>
          <span>visible notes</span>
        </div>
        <div>
          <dt>In progress</dt>
          <dd>{String(data.draftCount).padStart(2, "0")}</dd>
          <span>private drafts</span>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>{String(data.scheduledCount).padStart(2, "0")}</dd>
          <span>queued to publish</span>
        </div>
        <div>
          <dt>Readers</dt>
          <dd>{String(data.activeSubscribers).padStart(2, "0")}</dd>
          <span>active letters</span>
        </div>
      </dl>
      <div class="admin-overview-grid">
        <section class="admin-panel" aria-labelledby="recent-title">
          <div class="admin-panel-heading">
            <div>
              <p class="eyebrow">Library pulse</p>
              <h2 id="recent-title">Recent notes</h2>
            </div>
            <a href="/admin?view=posts">Open library -&gt;</a>
          </div>
          <div class="admin-posts admin-posts-compact">
            {recent.length > 0
              ? recent.map((item: Post) => (
                <PostRow key={item.id} item={item} compact />
              ))
              : <p class="empty-state">No notes yet.</p>}
          </div>
        </section>
        <aside class="admin-pulse" aria-labelledby="pulse-title">
          <p class="eyebrow">Next actions</p>
          <h2 id="pulse-title">Keep the desk moving.</h2>
          <a class="admin-action-link" href="/admin?view=compose">
            <b>+</b>
            <span>
              <strong>Write a new note</strong>
              <small>Start with a clear promise.</small>
            </span>
          </a>
          <a class="admin-action-link" href="/admin?view=posts&status=draft">
            <b>02</b>
            <span>
              <strong>Review drafts</strong>
              <small>{data.draftCount} notes need a decision.</small>
            </span>
          </a>
          <a class="admin-action-link" href="/admin?view=subscribers">
            <b>→</b>
            <span>
              <strong>Check the letter list</strong>
              <small>{data.activeSubscribers} active readers.</small>
            </span>
          </a>
        </aside>
      </div>
    </div>
  );
}

function PostsView({ data }: { data: AdminData }) {
  return (
    <section
      class="admin-panel admin-library-view"
      aria-labelledby="library-title"
    >
      <div class="admin-panel-heading">
        <div>
          <p class="eyebrow">Content library</p>
          <h2 id="library-title">Every note in one place.</h2>
        </div>
        <a class="admin-solid-link" href="/admin?view=compose">
          Write a note <span aria-hidden="true">-&gt;</span>
        </a>
      </div>
      <form class="admin-filter-bar" method="get" action="/admin">
        <input type="hidden" name="view" value="posts" />
        <label>
          <span>Search</span>
          <input
            type="search"
            name="q"
            value={data.query}
            placeholder="Title, body, category"
          />
        </label>
        <label>
          <span>Status</span>
          <select name="status" value={data.status}>
            <option value="">All statuses</option>
            <option value="published">Published</option>
            <option value="draft">Drafts</option>
            <option value="scheduled">Scheduled</option>
          </select>
        </label>
        <button type="submit">Filter</button>
        {(data.query || data.status) && (
          <a class="filter-reset" href="/admin?view=posts">Clear</a>
        )}
      </form>
      <div class="admin-library-meta">
        <span>{data.posts.length} matching notes</span>
        <span>Sorted by publication date</span>
      </div>
      <div class="admin-posts admin-posts-library">
        {data.posts.length > 0
          ? data.posts.map((item: Post) => (
            <PostRow
              key={item.id}
              item={item}
            />
          ))
          : (
            <div class="empty-state">
              <p>No notes match this view.</p>
              <a class="text-link" href="/admin?view=compose">
                Start a new note <span aria-hidden="true">-&gt;</span>
              </a>
            </div>
          )}
      </div>
    </section>
  );
}

function ComposeView({ data }: { data: AdminData }) {
  const post = data.editing as Post | null;
  return (
    <section aria-labelledby="compose-title">
      <div class="admin-panel-heading compose-heading">
        <div>
          <p class="eyebrow">{post ? "Editing note" : "New note"}</p>
          <h2 id="compose-title">{post?.title ?? "Give the idea a shape."}</h2>
        </div>
        {post && <a href="/admin?view=compose">Start fresh</a>}
      </div>
      <form
        id="post-editor"
        class="editor-form editor-form-workspace"
        method="post"
        action="/api/posts"
      >
        <input type="hidden" name="returnTo" value="/admin?view=compose" />
        {post && <input type="hidden" name="originalSlug" value={post.slug} />}
        <div class="compose-layout">
          <div class="compose-canvas">
            <div class="field field-wide field-title">
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
                rows={18}
                minLength={80}
                maxLength={30_000}
                placeholder="Begin with the thought that keeps returning."
                required
              >
                {post?.body ?? ""}
              </textarea>
              <span class="field-hint">
                Blank lines split paragraphs. Use <code>##</code>{" "}
                for a section heading and <code>&gt;</code> for a pull quote.
              </span>
            </div>
            <AdminEditorAssist
              initialTitle={post?.title ?? ""}
              initialSlug={post?.slug ?? ""}
              initialBody={post?.body ?? ""}
            />
          </div>
          <aside class="publish-rail" aria-label="Publishing settings">
            <div class="publish-rail-head">
              <span>Publish settings</span>
              <span
                class={`system-status ${
                  data.storageAvailable ? "is-ready" : ""
                }`}
              >
                <i aria-hidden="true"></i>
                {data.storageAvailable ? "KV ready" : "Offline"}
              </span>
            </div>
            <div class="field">
              <label htmlFor="status">Status</label>
              <select id="status" name="status" value={post?.status ?? "draft"}>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </div>
            <div class="field">
              <label htmlFor="publishedAt">Publish date</label>
              <input
                id="publishedAt"
                name="publishedAt"
                type="date"
                value={dateInputValue(
                  post?.publishedAt ?? new Date().toISOString(),
                )}
                required
              />
              <span class="field-hint">
                Future dates stay private until the moment arrives.
              </span>
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
                placeholder="generated-from-title"
              />
            </div>
            <div class="field">
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
            <div class="field">
              <label htmlFor="image">Cover image URL</label>
              <input
                id="image"
                name="image"
                type="url"
                value={post?.image ?? ""}
                placeholder="https://images.unsplash.com/..."
                required
              />
            </div>
            <div class="field">
              <label htmlFor="imageAlt">Image description</label>
              <input
                id="imageAlt"
                name="imageAlt"
                type="text"
                value={post?.imageAlt ?? ""}
                minLength={5}
                maxLength={180}
                placeholder="What is visible?"
                required
              />
            </div>
            <label class="check-field">
              <input
                type="checkbox"
                name="featured"
                checked={post?.featured ?? false}
              />
              <span>
                <b>Feature on home</b>
                <small>Only one note can lead the homepage.</small>
              </span>
            </label>
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
            </div>
            <p class="publish-rail-note">
              Changes are written directly to Deno KV.
            </p>
          </aside>
        </div>
      </form>
    </section>
  );
}

function SubscribersView({ data }: { data: AdminData }) {
  return (
    <section
      class="admin-panel admin-subscriber-view"
      aria-labelledby="subscribers-title"
    >
      <div class="admin-panel-heading">
        <div>
          <p class="eyebrow">Sunday letter</p>
          <h2 id="subscribers-title">People who asked for the quiet.</h2>
        </div>
        <a class="admin-solid-link" href="/api/subscribers?format=csv">
          Export CSV <span aria-hidden="true">-&gt;</span>
        </a>
      </div>
      <form
        class="admin-filter-bar subscriber-filter"
        method="get"
        action="/admin"
      >
        <input type="hidden" name="view" value="subscribers" />
        <label>
          <span>Find a reader</span>
          <input
            type="search"
            name="subscriber"
            value={data.subscriberQuery}
            placeholder="name@example.com"
          />
        </label>
        <button type="submit">Search</button>
        {data.subscriberQuery && (
          <a class="filter-reset" href="/admin?view=subscribers">Clear</a>
        )}
      </form>
      <div class="admin-library-meta">
        <span>{data.subscribers.length} records</span>
        <span>{data.activeSubscribers} active</span>
      </div>
      <div class="subscriber-list subscriber-list-full">
        {data.subscribers.length > 0
          ? data.subscribers.map((subscriber: Subscriber) => (
            <div class="subscriber-row" key={subscriber.email}>
              <span>{maskEmail(subscriber.email)}</span>
              <span
                class={`post-status is-${
                  subscriber.status === "active" ? "published" : "draft"
                }`}
              >
                {subscriber.status}
              </span>
              <time dateTime={subscriber.updatedAt}>
                {formatPostDate(subscriber.updatedAt)}
              </time>
              <form method="post" action="/api/subscribers">
                <input type="hidden" name="email" value={subscriber.email} />
                <button type="submit">Remove</button>
              </form>
            </div>
          ))
          : <p class="empty-state">No subscribers match this search.</p>}
      </div>
    </section>
  );
}

export default define.page<typeof handler>(function Admin({ data }) {
  const titles: Record<AdminView, string> = {
    overview: "A calm place to publish.",
    posts: "Every note, kept close.",
    compose: data.editing ? "Refine the note." : "Give the idea a shape.",
    subscribers: "A small, thoughtful audience.",
  };
  return (
    <>
      <Head>
        <title>{titles[data.view]} — Quiet line</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div class="admin-shell">
        <a class="skip-link" href="#admin-content">Skip to workspace</a>
        <header class="admin-topbar container">
          <a
            class="wordmark"
            href="/admin"
            aria-label="Quiet line editorial desk"
          >
            <span class="wordmark-mark" aria-hidden="true">ql</span>
            <span>editorial desk</span>
          </a>
          <WorkspaceNav active={data.view} />
          <div class="admin-topbar-actions">
            <a href="/" class="admin-view-site">
              View site <span aria-hidden="true">-&gt;</span>
            </a>
            <form
              class="admin-logout"
              action="/api/admin/session"
              method="post"
            >
              <input type="hidden" name="action" value="logout" />
              <button type="submit">Sign out</button>
            </form>
          </div>
        </header>
        <main id="admin-content" class="admin-main container">
          <header class="admin-page-heading">
            <div>
              <p class="eyebrow">Quiet line / editorial workspace</p>
              <h1>{titles[data.view]}</h1>
              <p>
                {data.view === "overview"
                  ? "A short view of what is published, what is waiting, and what deserves your next hour."
                  : data.view === "compose"
                  ? "Write in the wide lane. Keep the decisions close at hand."
                  : data.view === "posts"
                  ? "Search, preview, and move notes through their lifecycle."
                  : "Keep the letter list tidy and export it when you need it."}
              </p>
            </div>
            <a class="admin-primary-link" href="/admin?view=compose">
              New note <span aria-hidden="true">+</span>
            </a>
          </header>
          <Notice data={data} />
          {data.view === "overview" && <Overview data={data} />}
          {data.view === "posts" && <PostsView data={data} />}
          {data.view === "compose" && <ComposeView data={data} />}
          {data.view === "subscribers" && <SubscribersView data={data} />}
        </main>
      </div>
    </>
  );
});
