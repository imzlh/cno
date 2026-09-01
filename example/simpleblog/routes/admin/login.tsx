import { page } from "fresh";
import { Head } from "fresh/runtime";
import { hasAdminSession, isAdminTokenConfigured } from "../../data/auth.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (await hasAdminSession(ctx.req)) return ctx.redirect("/admin");
    const requestedNext = ctx.url.searchParams.get("next") ?? "/admin";
    const next =
      requestedNext.startsWith("/") && !requestedNext.startsWith("//")
        ? requestedNext
        : "/admin";
    return page({
      error: ctx.url.searchParams.get("error"),
      loggedOut: ctx.url.searchParams.has("loggedout"),
      tokenConfigured: isAdminTokenConfigured(),
      next,
    }, {
      headers: {
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  },
});

export default define.page<typeof handler>(function AdminLogin({ data }) {
  return (
    <>
      <Head>
        <title>Sign in — Quiet line editorial desk</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div class="admin-shell admin-login-shell">
        <main class="admin-login container">
          <a class="wordmark" href="/" aria-label="Quiet line home">
            <span class="wordmark-mark" aria-hidden="true">ql</span>
            <span>editorial desk</span>
          </a>
          <div class="admin-login-copy">
            <p class="eyebrow">Private workspace</p>
            <h1>Make room for an idea.</h1>
            <p>
              Sign in to manage drafts, schedule notes, and curate the home
              page.
            </p>
          </div>
          {!data.tokenConfigured && (
            <div class="admin-notice is-warning" role="alert">
              Set <code>QUIETLINE_ADMIN_TOKEN</code> before signing in.
            </div>
          )}
          {data.error && (
            <div class="admin-notice is-error" role="alert">
              {data.error === "invalid"
                ? "That token is not valid."
                : data.error}
            </div>
          )}
          {data.loggedOut && (
            <div class="admin-notice is-success" role="status">
              You are signed out.
            </div>
          )}
          <form
            class="admin-login-form"
            action="/api/admin/session"
            method="post"
          >
            <input type="hidden" name="next" value={data.next} />
            <label htmlFor="login-token">Admin token</label>
            <input
              id="login-token"
              name="token"
              type="password"
              autoComplete="current-password"
              required
              disabled={!data.tokenConfigured}
            />
            <button type="submit" disabled={!data.tokenConfigured}>
              Enter editor <span aria-hidden="true">-&gt;</span>
            </button>
          </form>
          <a class="admin-login-back" href="/">
            Return to quiet line <span aria-hidden="true">-&gt;</span>
          </a>
        </main>
      </div>
    </>
  );
});
