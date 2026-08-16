import { define } from "../utils.ts";

export default define.page(function App({ Component }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f3f1ec" />
        <meta property="og:site_name" content="Quiet line" />
        <link rel="icon" href="/favicon.ico" />
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Quiet line RSS"
          href="/feed.xml"
        />
      </head>
      <body>
        <Component />
      </body>
    </html>
  );
});
