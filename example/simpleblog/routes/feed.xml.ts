import { formatPostDate, listPosts } from "../data/posts.ts";
import { define } from "../utils.ts";

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&apos;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

export const handler = define.handlers({
  async GET(ctx) {
    const posts = await listPosts();
    const origin = ctx.url.origin;
    const items = posts.map((post) => {
      const link = `${origin}/article/${encodeURIComponent(post.slug)}`;
      return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
      <category>${escapeXml(post.category)}</category>
      <description>${escapeXml(post.excerpt)}</description>
    </item>`;
    }).join("");

    const self = `${origin}/feed.xml`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Quiet line</title>
    <link>${escapeXml(origin)}</link>
    <description>Thoughtful notes on design, independent work, and the web.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${
      escapeXml(self)
    }" rel="self" type="application/rss+xml" />${items}
  </channel>
</rss>`;

    return new Response(xml, {
      headers: {
        "cache-control": "public, max-age=300, stale-while-revalidate=600",
        "content-type": "application/rss+xml; charset=utf-8",
      },
    });
  },
});
