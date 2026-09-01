import { define } from "../../utils.ts";
import { saveSubscriber } from "../../data/subscribers.ts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const handler = define.handlers({
  async POST(ctx) {
    const contentType = ctx.req.headers.get("content-type") ?? "";
    let email = "";
    let website = "";

    try {
      if (contentType.includes("application/json")) {
        const payload: unknown = await ctx.req.json();
        if (typeof payload === "object" && payload !== null) {
          const record = payload as Record<string, unknown>;
          email = typeof record.email === "string" ? record.email.trim() : "";
          website = typeof record.website === "string"
            ? record.website.trim()
            : "";
        }
      } else {
        const form = await ctx.req.formData();
        const emailValue = form.get("email");
        const websiteValue = form.get("website");
        email = typeof emailValue === "string" ? emailValue.trim() : "";
        website = typeof websiteValue === "string" ? websiteValue.trim() : "";
      }
    } catch {
      return contentType.includes("application/json")
        ? Response.json({ error: "The request body could not be read." }, {
          status: 400,
        })
        : ctx.redirect("/?subscribed=invalid#newsletter", 303);
    }

    const valid = email.length <= 254 && EMAIL_PATTERN.test(email);
    const accepted = valid || website.length > 0;

    if (valid && !website) {
      try {
        await saveSubscriber(email);
      } catch (error) {
        console.error("Could not save subscriber:", error);
        return contentType.includes("application/json")
          ? Response.json(
            { error: "Subscription is temporarily unavailable." },
            { status: 503 },
          )
          : ctx.redirect("/?subscribed=error#newsletter", 303);
      }
    }

    if (contentType.includes("application/json")) {
      return accepted
        ? Response.json({ accepted: true })
        : Response.json({ error: "Enter a valid email address." }, {
          status: 422,
        });
    }

    return ctx.redirect(
      accepted
        ? "/?subscribed=1#newsletter"
        : "/?subscribed=invalid#newsletter",
      303,
    );
  },
});
