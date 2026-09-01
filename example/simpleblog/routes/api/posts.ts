import {
  deletePost,
  getPost,
  listPosts,
  PostConflictError,
  type PostInput,
  PostNotFoundError,
  savePost,
  slugify,
  StorageUnavailableError,
} from "../../data/posts.ts";
import { isAdminRequest } from "../../data/auth.ts";
import { define } from "../../utils.ts";

type Payload = Record<string, unknown>;

function wantsJson(request: Request): boolean {
  return request.headers.get("content-type")?.includes("application/json") ??
    false;
}

async function readPayload(request: Request): Promise<Payload> {
  if (wantsJson(request)) {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Expected a JSON object.");
    }
    return value as Payload;
  }

  const data = await request.formData();
  const payload: Payload = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === "string") payload[key] = value;
  }
  return payload;
}

function text(payload: Payload, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function validImageSource(value: string): boolean {
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parsePostInput(
  payload: Payload,
): { input?: PostInput; errors: string[] } {
  const errors: string[] = [];
  const title = text(payload, "title");
  const slug = slugify(text(payload, "slug") || title);
  const category = text(payload, "category");
  const excerpt = text(payload, "excerpt");
  const body = text(payload, "body");
  const image = text(payload, "image");
  const imageAlt = text(payload, "imageAlt");
  const publishedDate = text(payload, "publishedAt");
  const readingMinutes = Number(text(payload, "readingMinutes"));
  const status = text(payload, "status");

  if (title.length < 3 || title.length > 140) {
    errors.push("Title must be between 3 and 140 characters.");
  }
  if (!slug) errors.push("A valid slug is required.");
  if (category.length < 2 || category.length > 40) {
    errors.push("Category must be between 2 and 40 characters.");
  }
  if (excerpt.length < 20 || excerpt.length > 280) {
    errors.push("Excerpt must be between 20 and 280 characters.");
  }
  if (body.length < 80 || body.length > 30_000) {
    errors.push("Article body must be between 80 and 30,000 characters.");
  }
  if (!validImageSource(image)) errors.push("Enter a valid image URL or path.");
  if (imageAlt.length < 5 || imageAlt.length > 180) {
    errors.push("Image description must be between 5 and 180 characters.");
  }
  if (
    !Number.isInteger(readingMinutes) || readingMinutes < 1 ||
    readingMinutes > 99
  ) {
    errors.push("Reading time must be between 1 and 99 minutes.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) {
    errors.push("Choose a valid publication date.");
  }
  if (status !== "draft" && status !== "published") {
    errors.push("Choose draft or published status.");
  }

  if (errors.length > 0) return { errors };

  return {
    errors,
    input: {
      title,
      slug,
      category,
      excerpt,
      body,
      image,
      imageAlt,
      read: `${readingMinutes} min read`,
      publishedAt: `${publishedDate}T12:00:00.000Z`,
      status: status as PostInput["status"],
      featured: payload.featured === true || text(payload, "featured") === "on",
    },
  };
}

function errorResponse(
  request: Request,
  message: string,
  status: number,
): Response {
  return wantsJson(request)
    ? Response.json({ error: message }, { status })
    : new Response(message, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
}

function adminRedirect(
  ctx: { redirect(path: string, status?: number): Response },
  value: string,
  returnTo = "/admin",
) {
  const target = returnTo.startsWith("/admin") && !returnTo.startsWith("//")
    ? returnTo
    : "/admin";
  return ctx.redirect(
    `${target}${target.includes("?") ? "&" : "?"}${value}`,
    303,
  );
}

export const handler = define.handlers({
  async GET() {
    const posts = await listPosts();
    return Response.json({ posts }, {
      headers: { "cache-control": "public, max-age=30" },
    });
  },

  async POST(ctx) {
    if (!await isAdminRequest(ctx.req)) {
      const configured = Deno.env.get("QUIETLINE_ADMIN_TOKEN")?.trim();
      if (!configured) {
        return errorResponse(
          ctx.req,
          "Publishing is disabled until QUIETLINE_ADMIN_TOKEN is configured.",
          503,
        );
      }
      return errorResponse(
        ctx.req,
        "An admin session or token is required.",
        401,
      );
    }

    let payload: Payload;
    try {
      payload = await readPayload(ctx.req);
    } catch {
      return errorResponse(ctx.req, "The request body could not be read.", 400);
    }

    const action = text(payload, "action") || "save";
    const returnTo = text(payload, "returnTo");

    try {
      if (action === "delete") {
        const slug = text(payload, "originalSlug") || text(payload, "slug");
        if (!slug) {
          return errorResponse(ctx.req, "A post slug is required.", 422);
        }
        await deletePost(slug);
        return wantsJson(ctx.req)
          ? Response.json({ deleted: slug })
          : adminRedirect(ctx, "deleted=1", returnTo || "/admin?view=posts");
      }

      if (action === "toggle") {
        const slug = text(payload, "slug");
        const post = await getPost(slug, true);
        if (!post) throw new PostNotFoundError(slug);
        const saved = await savePost({
          ...post,
          status: post.status === "published" ? "draft" : "published",
        }, post.slug);
        return wantsJson(ctx.req)
          ? Response.json({ post: saved })
          : adminRedirect(ctx, "updated=1", returnTo || "/admin?view=posts");
      }

      if (action !== "save") {
        return errorResponse(ctx.req, "Unknown post action.", 400);
      }

      const parsed = parsePostInput(payload);
      if (!parsed.input) {
        if (wantsJson(ctx.req)) {
          return Response.json({ errors: parsed.errors }, { status: 422 });
        }
        const message = encodeURIComponent(parsed.errors[0]);
        return ctx.redirect(`/admin?view=compose&error=${message}`, 303);
      }

      const originalSlug = text(payload, "originalSlug") || undefined;
      const saved = await savePost(parsed.input, originalSlug);
      return wantsJson(ctx.req)
        ? Response.json({ post: saved }, { status: originalSlug ? 200 : 201 })
        : ctx.redirect(
          `/admin?view=compose&edit=${encodeURIComponent(saved.slug)}&saved=${
            encodeURIComponent(saved.slug)
          }`,
          303,
        );
    } catch (error) {
      if (
        error instanceof PostConflictError ||
        error instanceof PostNotFoundError
      ) {
        return errorResponse(ctx.req, error.message, 409);
      }
      if (error instanceof StorageUnavailableError) {
        return errorResponse(ctx.req, error.message, 503);
      }
      console.error("Could not update post:", error);
      return errorResponse(ctx.req, "The post could not be updated.", 500);
    }
  },
});
