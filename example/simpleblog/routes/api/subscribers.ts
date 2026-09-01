import { isAdminRequest } from "../../data/auth.ts";
import { deleteSubscriber, listSubscribers } from "../../data/subscribers.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!await isAdminRequest(ctx.req)) {
      return Response.json({ error: "An admin session is required." }, {
        status: 401,
      });
    }
    const subscribers = await listSubscribers();
    const wantsCsv = ctx.url.searchParams.get("format") === "csv";
    if (wantsCsv) {
      const rows = [
        "email,status,updatedAt",
        ...subscribers.map((subscriber) =>
          [subscriber.email, subscriber.status, subscriber.updatedAt]
            .map((value) => `"${value.replaceAll('"', '""')}"`).join(",")
        ),
      ];
      return new Response(rows.join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition":
            "attachment; filename=quiet-line-subscribers.csv",
          "cache-control": "no-store",
        },
      });
    }
    return Response.json({ subscribers }, {
      headers: { "cache-control": "no-store" },
    });
  },
  async POST(ctx) {
    if (!await isAdminRequest(ctx.req)) {
      return Response.json({ error: "An admin session is required." }, {
        status: 401,
      });
    }
    const contentType = ctx.req.headers.get("content-type") ?? "";
    const payload: Record<string, unknown> = contentType.includes(
        "application/json",
      )
      ? await ctx.req.json()
      : Object.fromEntries(await (await ctx.req.formData()).entries());
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    if (!email) {
      return Response.json({ error: "An email is required." }, { status: 422 });
    }
    try {
      const deleted = await deleteSubscriber(email);
      if (contentType.includes("application/json")) {
        return Response.json({ deleted });
      }
      return ctx.redirect("/admin?view=subscribers&removed=1", 303);
    } catch (error) {
      console.error("Could not remove subscriber:", error);
      return Response.json({ error: "The subscriber could not be removed." }, {
        status: 503,
      });
    }
  },
});
