import { define } from "../utils.ts";

export const handler = define.handlers({
  GET(ctx) {
    return new Response(
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${ctx.url.origin}/sitemap.xml\n`,
      {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/plain; charset=utf-8",
        },
      },
    );
  },
});
