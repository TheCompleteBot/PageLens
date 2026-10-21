# Example apps

Third-party open-source apps, copied here to test PageLens on real framework-rendered pages. Each keeps its own LICENSE file.

| Folder | Domain | Upstream | Commit | License | Stack |
|---|---|---|---|---|---|
| `shadcn-admin/` | admin dashboard | https://github.com/satnaing/shadcn-admin | `e16c87f213a5ba5e45964e9b67c792105ec74d26` | MIT | Vite + React |
| `storefront/` | e-commerce | https://github.com/danielbatres/react-vite-tailwind | `0380d3c2a51a58225812fd6b6cf3717ae9129c3a` | MIT | Vite + React |
| `restaurant/` | restaurant | https://github.com/themixlyweb/react-restaurant-website-template | `83d0ec67bd1616ea7757712ebf9940cc62a91af3` | MIT | Vite + React |
| `app-landing/` | app landing page | https://github.com/bohd4nx/app-landing | `8bd07982803fffc3f247381493de492546287a1f` | MIT | Next.js 16 |
| `blog/` | blog | https://github.com/timlrx/tailwind-nextjs-starter-blog | `b45bef66b40c63b6f57c15ee8cd090682238df4c` | MIT | Next.js 15 |

`restaurant/`, `app-landing/` and `blog/` are the "fresh" sites (`tests/freshset.json`): never used while developing or tuning PageLens.

Our only changes to each app:

- The PageLens start and end markers:
  - Vite apps: in `index.html`, wrapped around `<div id="root">`.
  - `app-landing/`: in `src/app/layout.tsx`, around the page content and footer.
  - `blog/`: in `app/layout.tsx`, inside `<main>` around `{children}` (the header and footer stay outside the region). Placed directly in `<body>` next to the client components, React rendered the two marker tags a second time, so the page had two start/end pairs and PageLens paired the wrong ones.
- `public/pagelens/lib.js`: a symlink to `../../../../dist/lib.js`, so the app always serves the latest build.
- `shadcn-admin/src/main.tsx`: the router's `basepath` is set to Vite's base URL (one line), so the dashboard can also be hosted under a sub-path; it is `/` in development, so nothing changes locally. The deploy workflow publishes it at `https://thecompletebot.github.io/PageLens/dashboard/`.

## Running them

```sh
cd examples/storefront && npx vite --port 5173
cd examples/shadcn-admin && npx vite --port 5174
cd examples/restaurant && npx vite --port 5175 --host 127.0.0.1
cd examples/app-landing && npx next dev -p 3001
cd examples/blog && INIT_CWD=$PWD npx next build --no-lint && npx next start -p 3002
```

On a fresh clone, install dependencies first: `npm install` (storefront, restaurant), `npx pnpm install` (shadcn-admin), `npx pnpm@10 install` (app-landing), `node .yarn/releases/yarn-3.6.1.cjs install` (blog).

Notes found while adding PageLens:

- **Next.js lint rejects the start tag.** `next build` fails on `@next/next/no-sync-scripts`: Next.js discourages synchronous `<script src>`, which PageLens needs (`document.currentScript`). The blog is built with `--no-lint`.
- **The blog has a hydration mismatch of its own** in dev mode (also without PageLens), so it is run as a production build.
- **Scroll animations hide content.** The restaurant and app-landing fade sections in as you scroll (opacity 0 until then), and PageLens treats invisible elements as absent: before scrolling it sees 46 of 79 nodes (restaurant) and 30 of 165 (app-landing). The fresh set tests them after scrolling through once, plus a few questions without scrolling.
