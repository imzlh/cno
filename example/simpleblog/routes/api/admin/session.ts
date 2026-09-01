import {
  clearAdminCookie,
  createAdminCookie,
  sameOrigin,
  verifyAdminToken,
} from "../../../data/auth.ts";
import { define } from "../../../utils.ts";

type Payload = Record<string, unknown>;

async function readPayload(request: Request): Promise<Payload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Payload
      : {};
  }
  const form = await request.formData();
  return Object.fromEntries(
    [...form.entries()].filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function text(payload: Payload, key: string): string {
  return typeof payload[key] === "string" ? String(payload[key]).trim() : "";
}

function safeNext(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/admin";
}

export const handler = define.handlers({
  async POST(ctx) {
    const secure = new URL(ctx.req.url).protocol === "https:";
    if (!sameOrigin(ctx.req)) {
      return new Response("Cross-origin request denied.", { status: 403 });
    }

    let payload: Payload;
    try {
      payload = await readPayload(ctx.req);
    } catch {
      return new Response("The request body could not be read.", {
        status: 400,
      });
    }

    if (text(payload, "action") === "logout") {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/admin/login?loggedout=1",
          "set-cookie": clearAdminCookie(secure),
        },
      });
    }

    const token = ctx.req.headers.get("x-admin-token")?.trim() ||
      text(payload, "token");
    if (!await verifyAdminToken(token)) {
      return new Response(null, {
        status: 303,
        headers: { location: "/admin/login?error=invalid" },
      });
    }

    const cookie = await createAdminCookie(secure);
    const next = safeNext(text(payload, "next"));
    if ((ctx.req.headers.get("accept") ?? "").includes("application/json")) {
      return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
    }
    return new Response(null, {
      status: 303,
      headers: { location: next, "set-cookie": cookie },
    });
  },
});
