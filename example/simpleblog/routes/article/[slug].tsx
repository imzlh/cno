import { page } from "fresh";
import { Head } from "fresh/runtime";
import { SiteFooter, SiteHeader } from "../../components/SiteChrome.tsx";
import { isAdminRequest } from "../../data/auth.ts";
import { formatPostDate, getPost, listPosts } from "../../data/posts.ts";
import ArticleTools from "../../islands/ArticleTools.tsx";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const preview = ctx.url.searchParams.get("preview") === "1" &&
      await isAdminRequest(ctx.req);
    const post = await getPost(ctx.params.slug, preview);
    const posts = post ? await listPosts({ includeDrafts: preview }) : [];
    const position = post ? posts.findIndex((item) => item.id === post.id) : -1;
    const related = post
      ? posts.filter((item) =>
        item.id !== post.id && item.category === post.category
      )
        .concat(
          posts.filter((item) =>
            item.id !== post.id && item.category !== post.category
          ),
        )
        .slice(0, 2)
      : [];
    return page({
      post,
      preview,
      related,
      newer: position > 0 ? posts[position - 1] : null,
      older: position >= 0 ? posts[position + 1] ?? null : null,
    }, {
      status: post ? 200 : 404,
      headers: preview ? { "cache-control": "no-store" } : undefined,
    });
  },
});

function ArticleBody({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/).map((block) => block.trim()).filter(
    Boolean,
  );
  return (
    <div class="article-body">
      {blocks.map((block, index) => {
        if (block.startsWith("## ")) {
          return <h2 key={index}>{block.slice(3)}</h2>;
        }
        if (block.startsWith("> ")) {
          return <blockquote key={index}>{block.slice(2)}</blockquote>;
        }
        return <p key={index}>{block}</p>;
      })}
    </div>
  );
}

export default define.page<typeof handler>(function ArticlePage({ data, url }) {
  if (!data.post) {
    return (
      <>
        <Head>
          <title>Note not found — Quiet line</title>
        </Head>
        <div class="site-shell">
          <SiteHeader />
          <main class="not-found container">
            <p class="eyebrow">404 / Missing note</p>
            <h1>
              This page has gone <em>quiet.</em>
            </h1>
            <p>The note may have moved, or it may still be taking shape.</p>
            <a class="text-link" href="/archive">
              Browse the archive <span aria-hidden="true">-&gt;</span>
            </a>
          </main>
          <SiteFooter />
        </div>
      </>
    );
  }

  const post = data.post;
  return (
    <>
      <Head>
        <title>{post.title} — Quiet line</title>
        {data.preview && <meta name="robots" content="noindex, nofollow" />}
        <link
          rel="canonical"
          href={`${url.origin}/article/${encodeURIComponent(post.slug)}`}
        />
        <meta name="description" content={post.excerpt} />
        <meta property="og:title" content={post.title} />
        <meta property="og:description" content={post.excerpt} />
        <meta property="og:image" content={post.image} />
        <meta
          property="og:url"
          content={`${url.origin}/article/${encodeURIComponent(post.slug)}`}
        />
        <meta property="og:type" content="article" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={post.title} />
        <meta name="twitter:description" content={post.excerpt} />
        <meta name="twitter:image" content={post.image} />
        <meta property="article:published_time" content={post.publishedAt} />
        <meta property="article:modified_time" content={post.updatedAt} />
      </Head>
      <div class="site-shell">
        <a class="skip-link" href="#article">Skip to article</a>
        <SiteHeader
          actionHref="/archive"
          actionLabel="Back to archive"
        />
        <main id="article">
          <article class="article-page" data-reading-target>
            <header class="article-header container">
              <a class="article-back" href="/archive">
                <span aria-hidden="true">&lt;-</span> All notes
              </a>
              <div class="article-heading">
                {data.preview && <p class="preview-badge">Private preview</p>}
                <p class="eyebrow">{post.category}</p>
                <h1>{post.title}</h1>
                <p class="article-deck">{post.excerpt}</p>
                <div class="article-byline">
                  <span>{formatPostDate(post.publishedAt)}</span>
                  <span>{post.read}</span>
                  <span>Quiet line editorial</span>
                </div>
              </div>
            </header>

            <figure class="article-cover container">
              <img src={post.image} alt={post.imageAlt} />
              <figcaption>{post.imageAlt}</figcaption>
            </figure>

            <div class="article-tools-wrap container">
              <ArticleTools slug={post.slug} />
            </div>

            <div class="article-content container">
              <aside class="article-aside">
                <span>Filed under</span>
                <strong>{post.category}</strong>
              </aside>
              <ArticleBody body={post.body} />
            </div>
            {(data.newer || data.older) && (
              <nav class="article-neighbors container" aria-label="More notes">
                {data.older
                  ? (
                    <a href={`/article/${encodeURIComponent(data.older.slug)}`}>
                      <span>Older note</span>
                      <strong>{data.older.title}</strong>
                      <b aria-hidden="true">&lt;-</b>
                    </a>
                  )
                  : <span />}
                {data.newer
                  ? (
                    <a href={`/article/${encodeURIComponent(data.newer.slug)}`}>
                      <span>Newer note</span>
                      <strong>{data.newer.title}</strong>
                      <b aria-hidden="true">-&gt;</b>
                    </a>
                  )
                  : <span />}
              </nav>
            )}
          </article>

          {data.related.length > 0 && (
            <section class="related container" aria-labelledby="related-title">
              <div class="section-heading">
                <p class="eyebrow">Keep reading</p>
                <h2 id="related-title">Two more for the road.</h2>
              </div>
              <div class="related-grid">
                {data.related.map((item) => (
                  <article class="related-item" key={item.id}>
                    <a
                      class="post-image"
                      href={`/article/${encodeURIComponent(item.slug)}`}
                    >
                      <img
                        src={item.image}
                        alt={item.imageAlt}
                        loading="lazy"
                      />
                    </a>
                    <div class="post-meta">
                      <span>{item.category}</span>
                      <span>{item.read}</span>
                    </div>
                    <h3>
                      <a href={`/article/${encodeURIComponent(item.slug)}`}>
                        {item.title}
                      </a>
                    </h3>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>
        <SiteFooter />
      </div>
    </>
  );
});
