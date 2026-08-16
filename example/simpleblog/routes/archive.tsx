import { page } from "fresh";
import { Head } from "fresh/runtime";
import { SiteFooter, SiteHeader } from "../components/SiteChrome.tsx";
import { formatPostDate, listPosts } from "../data/posts.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const posts = await listPosts();
    const query = (ctx.url.searchParams.get("q") ?? "").trim();
    const category = (ctx.url.searchParams.get("category") ?? "").trim();
    const queryLower = query.toLocaleLowerCase();
    const filtered = posts.filter((post) => {
      const matchesQuery = !queryLower ||
        `${post.title} ${post.excerpt} ${post.category}`
          .toLocaleLowerCase()
          .includes(queryLower);
      const matchesCategory = !category || post.category === category;
      return matchesQuery && matchesCategory;
    });
    const categories = [...new Set(posts.map((post) => post.category))].sort();
    return page({ posts: filtered, categories, query, category });
  },
});

export default define.page<typeof handler>(function Archive({ data, url }) {
  return (
    <>
      <Head>
        <title>Archive — Quiet line</title>
        <link rel="canonical" href={`${url.origin}/archive`} />
        <meta
          name="description"
          content="Browse every Quiet line essay and field note."
        />
      </Head>
      <div class="site-shell">
        <a class="skip-link" href="#content">Skip to content</a>
        <SiteHeader active="archive" />
        <main id="content" class="archive-page container">
          <header class="archive-intro">
            <p class="eyebrow">The full archive</p>
            <h1>
              Every note, <em>kept close.</em>
            </h1>
            <p>
              Essays on thoughtful design, independent work, and a web with
              enough room to think.
            </p>
          </header>

          <form class="archive-filter" method="get" action="/archive">
            <label>
              <span>Search</span>
              <input
                type="search"
                name="q"
                value={data.query}
                placeholder="A title or idea"
              />
            </label>
            <label>
              <span>Category</span>
              <select name="category" value={data.category}>
                <option value="">All notes</option>
                {data.categories.map((category) => (
                  <option value={category} key={category}>{category}</option>
                ))}
              </select>
            </label>
            <button type="submit">Filter archive</button>
            {(data.query || data.category) && (
              <a class="filter-reset" href="/archive">Clear</a>
            )}
          </form>

          <section class="archive-list" aria-label="Published notes">
            <div class="archive-count">
              <span>{String(data.posts.length).padStart(2, "0")}</span>
              <span>{data.posts.length === 1 ? "note" : "notes"}</span>
            </div>
            {data.posts.length > 0
              ? data.posts.map((post, index) => (
                <article class="archive-item" key={post.id}>
                  <span class="archive-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <a
                    class="archive-thumb"
                    href={`/article/${encodeURIComponent(post.slug)}`}
                  >
                    <img src={post.image} alt={post.imageAlt} loading="lazy" />
                  </a>
                  <div class="archive-item-copy">
                    <div class="post-meta">
                      <span>{post.category}</span>
                      <span>{formatPostDate(post.publishedAt)}</span>
                    </div>
                    <h2>
                      <a href={`/article/${encodeURIComponent(post.slug)}`}>
                        {post.title}
                      </a>
                    </h2>
                    <p>{post.excerpt}</p>
                  </div>
                  <a
                    class="archive-read"
                    href={`/article/${encodeURIComponent(post.slug)}`}
                    aria-label={`Read ${post.title}`}
                  >
                    <span>{post.read}</span>
                    <b aria-hidden="true">-&gt;</b>
                  </a>
                </article>
              ))
              : (
                <div class="empty-state archive-empty">
                  <p>No notes match those filters.</p>
                  <a class="text-link" href="/archive">
                    Return to the full archive{" "}
                    <span aria-hidden="true">-&gt;</span>
                  </a>
                </div>
              )}
          </section>
        </main>
        <SiteFooter />
      </div>
    </>
  );
});
