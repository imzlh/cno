import { page } from "fresh";
import { Head } from "fresh/runtime";
import { SiteFooter, SiteHeader } from "../components/SiteChrome.tsx";
import { define } from "../utils.ts";

export const handler = define.handlers({
  GET() {
    return page({}, { status: 404 });
  },
});

export default define.page<typeof handler>(function NotFound() {
  return (
    <>
      <Head>
        <title>Page not found — Quiet line</title>
      </Head>
      <div class="site-shell">
        <SiteHeader />
        <main class="not-found container">
          <p class="eyebrow">404 / Wrong turn</p>
          <h1>
            There is nothing <em>here yet.</em>
          </h1>
          <p>
            This address does not lead to a published note. The archive is a
            better place to start.
          </p>
          <a class="text-link" href="/archive">
            Browse the archive <span aria-hidden="true">-&gt;</span>
          </a>
        </main>
        <SiteFooter />
      </div>
    </>
  );
});
