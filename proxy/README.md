# PageLens proxy

A Cloudflare Worker (`worker.js`, about 50 lines) that keeps the Gemini API key off the page. Without it, the key is baked into `lib.js`, and anyone who opens the file can read it.

```
browser (lib.js, no key) ──► proxy (checks the request, adds the key) ──► Gemini
```

`lib.js` still runs in the visitor's browser (extraction, tree, search ranking, explorer loop, checks, highlights); only its Gemini requests go through the proxy, and the replies come back unchanged.

## What it allows

1. **Allowed sites only:** the page's `Origin` must be in `ALLOWED_ORIGINS` (`wrangler.toml`): the GitHub Pages site, and any local dev server (`http://localhost:*`, `https://localhost:*`, `http://127.0.0.1:*`, any port). Other websites, and scripts that send no `Origin`, get 403. Note that `localhost` means whoever's computer the page runs on, so anyone with the proxy URL can use it from a local page; the limits below are what bound that.
2. **Only PageLens's calls:** `generateContent` on `gemini-3.5-flash-lite` / `gemini-3.5-flash` and `batchEmbedContents` on `gemini-embedding-001`, POST only. Anything else gets 404, so it can't be used as a general Gemini endpoint.
3. **Body size cap:** 256 KB (413 above that).
4. **Rate limit per visitor:** 60 calls a minute per IP address (a question makes about 6–10), answered with 429 like Gemini's own limit, so `lib.js` backs off as usual.

A script can fake the `Origin` header, so 2–4 and the key's own quota (set one in Google Cloud) limit what such a caller can do. The key itself is never sent to any browser.

## Setup (once)

1. Create a free Cloudflare account: https://dash.cloudflare.com/sign-up
2. Log in and deploy, from this folder:
   ```sh
   cd proxy
   npx wrangler@4 login
   npx wrangler@4 deploy
   ```
   It prints the worker's URL, e.g. `https://pagelens-proxy.<your-subdomain>.workers.dev`.
3. Store the key as a secret (it asks for the value; it is never written to a file):
   ```sh
   npx wrangler@4 secret put GEMINI_KEY
   ```
4. Build PageLens against it:
   ```sh
   node build.js --proxy https://pagelens-proxy.<your-subdomain>.workers.dev
   ```
5. For the GitHub Pages site: add a repository **variable** (not a secret; the URL is public) `PAGELENS_PROXY_URL` with that URL, under Settings → Secrets and variables → Actions → Variables. The deploy workflow then builds with `--proxy`, and the `PAGELENS_GEMINI_KEY` secret is no longer used.

To allow another developer's deployed site, add its origin (e.g. `https://their-shop.com`) to `ALLOWED_ORIGINS` in `wrangler.toml` and run `npx wrangler@4 deploy` again. `*` allows every site (then only the rate limit and the key's quota protect it).

## Testing locally

```sh
cd proxy
echo "GEMINI_KEY=your-key" > .dev.vars     # git-ignored
npx wrangler@4 dev --port 8787
node build.js --proxy http://127.0.0.1:8787   # from the repo root
```

Every `localhost` / `127.0.0.1` port is already allowed.
