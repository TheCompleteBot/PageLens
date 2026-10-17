# Example apps

Third-party open-source React apps, copied here to test PageLens on real framework-rendered pages. Each keeps its own LICENSE file.

| Folder | Upstream | Commit | License |
|---|---|---|---|
| `shadcn-admin/` | https://github.com/satnaing/shadcn-admin | `e16c87f213a5ba5e45964e9b67c792105ec74d26` | MIT |
| `storefront/` | https://github.com/danielbatres/react-vite-tailwind | `0380d3c2a51a58225812fd6b6cf3717ae9129c3a` | MIT |

Our only changes to each app:

- `index.html`: the PageLens start and end markers wrapped around `<div id="root">`.
- `public/pagelens/lib.js`: a symlink to `../../../../dist/lib.js`, so the app always serves the latest build.

See the main README for how to run them.
