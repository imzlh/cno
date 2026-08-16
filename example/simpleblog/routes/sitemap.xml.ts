import { listPosts } from "../data/posts.ts";
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
    const staticUrls = ["/", "/archive"];
    const urls = staticUrls.map((path) => `
  <url><loc>${escapeXml(`${origin}${path}`)}</loc></url>`).join("");
    const postUrls = posts.map((post) => `
  <url>
    <loc>${
      escapeXml(`${origin}/article/${encodeURIComponent(post.slug)}`)
    }</loc>
    <lastmod>${post.updatedAt}</lastmod>
  </url>`).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}${postUrls}
</urlset>`;
    return new Response(xml, {
      headers: {
        "cache-control": "public, max-age=300, stale-while-revalidate=600",
        "content-type": "application/xml; charset=utf-8",
      },
    });
  },
});
