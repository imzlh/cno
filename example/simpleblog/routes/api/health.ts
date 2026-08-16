import { isStorageAvailable, listPosts } from "../../data/posts.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET() {
    const [storage, posts] = await Promise.all([
      isStorageAvailable(),
      listPosts(),
    ]);
    const ready = storage;
    return Response.json({
      status: ready ? "ok" : "degraded",
      storage: ready ? "ready" : "unavailable",
      publishedPosts: posts.length,
      timestamp: new Date().toISOString(),
    }, {
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  },
});
