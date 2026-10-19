# PageLens (MVP)

A plain-JS library that adds a chat widget to a page. When the user types what they're looking for, it scrolls to and highlights the most relevant element in the marked region, or says the answer isn't on this page.

## Layout

```
src/                    the library source, one file per step
  init.js                 1. config + finding the AI region
  extract.js              2. describing visible elements and content
  tree.js                 2b. page tree + read-only explorer tools
  gemini.js               Gemini REST client (embeddings for now)
  search.js               hybrid search: BM25F + Gemini embeddings, merged with RRF
  trace.js                developer trace: logs each query's journey to the console
  preview.js              query handler (preview mode until the LLM step)
  widget.js               5. chat widget (Shadow DOM) + debug Tree view
  main.js                 public debug API + startup
build.js                joins src/ into dist/lib.js (no dependencies)
dist/lib.js             the built file that pages include (generated, git-ignored; don't edit)
demo/index.html         sample e-commerce homepage
examples/               open-source React apps used for testing
```

## Building

Pages load `dist/lib.js`, which is generated and not committed. Build it after cloning, and after editing anything in `src/`:

```sh
node build.js             # build once
node build.js --watch     # rebuild on every save (leave it running; it restarts itself if build.js changes)
node build.js --release   # build without the development API key (for anything you share or deploy)
```

### Development API key

For local development, put your Gemini key in `.env` at the project root (git-ignored):

```
GEMINI_API_KEY=your-key-here
```

`build.js` bakes it into `dist/lib.js` as a fallback, so pages work without editing `data-api-key`. A real `data-api-key` on the start tag always wins; the dev key is used only when it's missing or a `YOUR_...` placeholder, and the console says so. The build output shows only the key's last 4 characters. Never deploy a dev build: use `--release`.

## Running the demo

1. Open `demo/index.html` and replace `YOUR_GEMINI_API_KEY` in the start `<script>` tag with your Gemini API key (from Google AI Studio). Use a key with a low spending limit, because anyone who views the page can see it. Don't commit the key.
2. From the **project root** (not `demo/`), run:

   ```sh
   npx serve .
   ```

3. Open the URL it prints and add `/demo/`, e.g. `http://localhost:3000/demo/`.

Serve the files over HTTP instead of opening them from `file://`. The demo loads the library from the absolute path `/dist/lib.js`, which only works when the server root is the project root.

## Running the example apps

Each app wraps its React root in the PageLens markers and serves the library from `public/pagelens/lib.js`, a symlink to `dist/lib.js`.

```sh
cd examples/storefront && npx vite --port 5173      # shop, data from FakeStoreAPI
cd examples/shadcn-admin && npx vite --port 5174    # admin dashboard
```

On a fresh clone, install dependencies first: `npm install` in `storefront`, `npx pnpm install` in `shadcn-admin`.

## Adding it to a page

```html
<script src="lib.js" data-start data-api-key="KEY" data-provider="gemini"></script>
  ... the only content the assistant may read and point to ...
<script data-pagelens-end></script>
```

Add `data-debug` to the start tag for developer tools:

- a **Tree** view in the widget, showing the page tree the explorer walks;
- a **query trace** in the browser console. Every chat query prints one group: the tree, the query words, the keyword ranking (BM25F scores), the meaning ranking (similarities, cutoff, cache use), rank fusion (RRF), and what the explorer receives. `await PageLens.tools.search('...')` in the console prints the search part.

## Search

The explorer's `search(text)` tool ranks nodes two ways and merges the rankings with Reciprocal Rank Fusion:

- **Keywords (BM25F)**, local and free: exact words, rare words weighted higher.
- **Meaning (embeddings)**: `gemini-embedding-001`, so "television" finds "TV". Page texts are embedded once per page and cached; later queries only embed the query.

Without a usable key (none, a `YOUR_...` placeholder, or one the API rejects), search uses keywords only. In the console, `await PageLens.debugSearch('jacket')` shows how each ranking placed the results.
