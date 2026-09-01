import { unsubscribe } from "../../data/subscribers.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const email = String(form.get("email") ?? "").trim();
    if (!email) return ctx.redirect("/?unsubscribed=invalid#newsletter", 303);
    try {
      await unsubscribe(email);
      return ctx.redirect("/?unsubscribed=1#newsletter", 303);
    } catch (error) {
      console.error("Could not unsubscribe:", error);
      return ctx.redirect("/?unsubscribed=error#newsletter", 303);
    }
  },
});
