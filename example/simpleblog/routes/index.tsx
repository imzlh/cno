import { page } from "fresh";
import { Head } from "fresh/runtime";
import { SiteFooter, SiteHeader } from "../components/SiteChrome.tsx";
import { formatPostDate, listPosts, type Post } from "../data/posts.ts";
import { define } from "../utils.ts";

function postHref(post: Post): string {
  return `/article/${encodeURIComponent(post.slug)}`;
}

export const handler = define.handlers({
  async GET(ctx) {
    const posts = await listPosts();
    return page({
      posts,
      subscribed: ctx.url.searchParams.get("subscribed"),
      unsubscribed: ctx.url.searchParams.get("unsubscribed"),
    }, {
      headers: { "cache-control": "public, max-age=30" },
    });
  },
});

export default define.page<typeof handler>(function Home({ data, url }) {
  const featured = data.posts.find((post) => post.featured) ?? data.posts[0];
  const latest = data.posts
    .filter((post) => post.id !== featured?.id)
    .slice(0, 3);

  return (
    <>
      <Head>
        <title>Quiet line — notes for a quieter internet</title>
        <link rel="canonical" href={`${url.origin}/`} />
        <meta
          name="description"
          content="Quiet line is a small publication about thoughtful design, independent work, and the web."
        />
        <meta
          property="og:title"
          content="Quiet line — notes for a quieter internet"
        />
        <meta
          property="og:description"
          content="Thoughtful notes on design, independent work, and the web."
        />
        <meta property="og:url" content={`${url.origin}/`} />
        {featured && <meta property="og:image" content={featured.image} />}
      </Head>

      <div class="site-shell">
        <a class="skip-link" href="#content">Skip to content</a>
        <SiteHeader active="latest" />

        <main id="content">
          <section class="hero container" aria-labelledby="hero-title">
            <div class="hero-copy">
              <p class="eyebrow">
                <span class="eyebrow-dot" aria-hidden="true"></span>
                Independent notes · Est. 2024
              </p>
              <h1 id="hero-title">
                Notes for a <em>quieter</em> internet.
              </h1>
              <p class="hero-intro">
                Essays and field notes for people making things with care. No
                hot takes, no growth hacks, just useful thoughts for the long
                way around.
              </p>
              <a class="text-link" href="/archive">
                Explore the archive <span aria-hidden="true">-&gt;</span>
              </a>
            </div>

            {featured
              ? (
                <a
                  class="hero-story"
                  href={postHref(featured)}
                  aria-label={`Read featured article: ${featured.title}`}
                >
                  <div class="hero-image-wrap">
                    <img src={featured.image} alt={featured.imageAlt} />
                    <span class="image-note">
                      Featured / {formatPostDate(featured.publishedAt)}
                    </span>
                  </div>
                  <div class="hero-story-meta">
                    <span>{featured.category}</span>
                    <span>{featured.read}</span>
                  </div>
                  <h2>{featured.title}</h2>
                  <p>{featured.excerpt}</p>
                </a>
              )
              : (
                <div class="hero-story hero-empty">
                  <p class="eyebrow">The next note</p>
                  <h2>Something thoughtful is taking shape.</h2>
                  <p>Published stories will appear here.</p>
                </div>
              )}
          </section>

          <section
            class="latest container"
            id="latest"
            aria-labelledby="latest-title"
          >
            <div class="section-heading">
              <p class="eyebrow">The latest</p>
              <h2 id="latest-title">A few things worth your time.</h2>
              <a class="text-link" href="/archive">
                View all notes <span aria-hidden="true">-&gt;</span>
              </a>
            </div>

            {latest.length > 0
              ? (
                <div class="post-grid">
                  {latest.map((post, index) => (
                    <article
                      class={`post-card post-card-${index + 1}`}
                      key={post.id}
                    >
                      <a
                        class="post-image"
                        href={postHref(post)}
                        aria-label={`Read ${post.title}`}
                      >
                        <img
                          src={post.image}
                          alt={post.imageAlt}
                          loading="lazy"
                        />
                      </a>
                      <div class="post-meta">
                        <span>{post.category}</span>
                        <span>{formatPostDate(post.publishedAt)}</span>
                      </div>
                      <h3>
                        <a href={postHref(post)}>{post.title}</a>
                      </h3>
                      <p>{post.excerpt}</p>
                      <a class="post-link" href={postHref(post)}>
                        Read note <span aria-hidden="true">-&gt;</span>
                        <span class="read-time">{post.read}</span>
                      </a>
                    </article>
                  ))}
                </div>
              )
              : (
                <div class="empty-state">
                  <p>
                    The archive is quiet for now. The next note is underway.
                  </p>
                </div>
              )}
          </section>

          <section
            class="about-strip"
            id="about"
            aria-labelledby="about-title"
          >
            <div class="container about-layout">
              <p class="eyebrow">A note from the editor</p>
              <div>
                <h2 id="about-title">
                  Good work has a <em>rhythm.</em>
                </h2>
                <p>
                  Quiet line is a one-person publication about the decisions
                  behind the screen. Written from a small desk in Taipei, sent
                  when there is something worth saying.
                </p>
                <a
                  class="text-link"
                  href="mailto:hello@quietline.example"
                >
                  Say hello <span aria-hidden="true">-&gt;</span>
                </a>
              </div>
            </div>
          </section>

          <section
            class="newsletter container"
            id="newsletter"
            aria-labelledby="newsletter-title"
          >
            <div>
              <p class="eyebrow">The Sunday letter</p>
              <h2 id="newsletter-title">A quiet note, once a month.</h2>
            </div>
            <form
              class="newsletter-form"
              action="/api/subscribe"
              method="post"
            >
              <label class="sr-only" htmlFor="email">Your email address</label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                maxLength={254}
                required
              />
              <span class="hp-field" aria-hidden="true">
                <label htmlFor="website">Website</label>
                <input
                  id="website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </span>
              <button type="submit">
                Subscribe <span aria-hidden="true">-&gt;</span>
              </button>
              {data.subscribed === "1"
                ? (
                  <p class="form-note form-message" role="status">
                    You're on the list. Check your inbox for the next note.
                  </p>
                )
                : data.subscribed === "invalid"
                ? (
                  <p class="form-note form-error" role="alert">
                    Enter a valid email address.
                  </p>
                )
                : data.subscribed === "error"
                ? (
                  <p class="form-note form-error" role="alert">
                    Subscription is temporarily unavailable. Try again later.
                  </p>
                )
                : data.unsubscribed === "1"
                ? (
                  <p class="form-note form-message" role="status">
                    You have been removed from the list.
                  </p>
                )
                : data.unsubscribed === "error"
                ? (
                  <p class="form-note form-error" role="alert">
                    We could not update that subscription. Try again later.
                  </p>
                )
                : <p class="form-note">No noise. Unsubscribe whenever.</p>}
            </form>
            {(data.subscribed === "1" || data.unsubscribed === "1") && (
              <details class="unsubscribe-details">
                <summary>Manage subscription</summary>
                <form action="/api/unsubscribe" method="post">
                  <label class="sr-only" htmlFor="unsubscribe-email">
                    Email to remove
                  </label>
                  <input
                    id="unsubscribe-email"
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    required
                  />
                  <button type="submit">Unsubscribe</button>
                </form>
              </details>
            )}
          </section>
        </main>

        <SiteFooter />
      </div>
    </>
  );
});
