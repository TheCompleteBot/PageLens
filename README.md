# PageLens (MVP)

A plain-JS library that adds a chat widget to a page. When the user types what they're looking for, it scrolls to and highlights the most relevant element in the marked region, or says the answer isn't on this page.

## Layout

```
src/                    the library source, one file per step
  init.js                 1. config + finding the AI region
  extract.js              2. describing visible elements and content
  tree.js                 2b. page tree + read-only explorer tools
  gemini.js               Gemini REST client: embeddings + generation with function calling
  search.js               hybrid search: BM25F + Gemini embeddings, merged with RRF
  trace.js                developer trace: logs each query's journey to the console
  explorer.js             3. explorer: picks the node(s) for a query (LLM with tools, or search only)
  query.js                query handler: explorer result -> chat reply (preview until the answer step)
  widget.js               5. chat widget (Shadow DOM) + debug Tree view
  main.js                 public debug API + startup
build.js                joins src/ into dist/lib.js (no dependencies)
dist/lib.js             the built file that pages include (generated, git-ignored; don't edit)
demo/index.html         sample e-commerce homepage
examples/               open-source React apps used for testing
tests/                  explorer test set (cases.json) and runner (run.mjs)
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

Optional attributes on the start tag:

| Attribute | Default | Meaning |
|---|---|---|
| `data-model` | `gemini-3.5-flash-lite` | Model the explorer uses. Rate-limit (429) and overload (5xx) errors are retried with exponential backoff and jitter; if the model stays unavailable, it falls back to `gemini-3.5-flash`. |
| `data-navigator` | `llm` | How targets are chosen: `llm` (the explorer with tools) or `search` (top search hit, no LLM; a baseline for comparison). |
| `data-debug` | off | Developer tools, below. |

Add `data-debug` to the start tag for developer tools:

- a **Tree** view in the widget, showing the page tree the explorer walks;
- a **query trace** in the browser console. Every chat query prints one group: the tree, the automatic first search (query words, BM25F scores, similarities, RRF), every explorer turn (model, time, tokens, tool calls and their results), and the result. `await PageLens.explore('...')` runs the explorer without the chat; `await PageLens.tools.search('...')` prints just a search.

## Explorer

For each query the explorer starts from the page's top level plus `search(query)`, then calls tools until it calls `finish`:

- `expand(id)`, `read(id)`, `search(text, within?)`: read-only; they never change the page.
- `finish(action, targets)`: `answer` (the targets' text holds the information asked for), `highlight` (point to the targets) or `abstain` (not on this page). It returns node IDs only, no text for the user, so it can pick the wrong node but can't make up facts.

Limits, enforced in code: 8 tool calls (then only `finish` is allowed), 3 searches including the first, repeated calls refused, 30 s. A `finish` whose targets the explorer was never shown is sent back once to be fixed; a second bad one becomes `abstain`.

Targets nested inside another target are dropped (a product card already contains its price).

The answer step (next) gets a **hand-off** built by code, like retrieved chunks in RAG. It holds only page text (no tool calls, search lists or model-written text), capped at 3000 characters, in this order:

1. `sources`: the explorer's targets, cited and highlighted.
2. `context` from what the explorer `read()` (`via: "read"`), minus text already in a source.
3. `context` from the top 2 hits of each search the explorer made itself (`via: "search"`), latest first: these are reworded into the page's terms or scoped to a section.
4. `context` from the top 3 hits of the automatic first search (`via: "search"`), hits found by both keyword and meaning first, skipping any that overlap something already included. This keeps high-scoring evidence from branches the explorer never opened, e.g. a second figure elsewhere on the page.

Budget rules: every tool result says how many calls and searches are left; a search with the same words as an earlier one (including the automatic first search) is refused; `expand`/`read` of a node inside one already read is answered from memory for free. Card summaries (product records, small titled groups) include `details`, the text inside them, so prices and figures are visible without reading each card.

For now the chat reply shows the hand-off; writing the answer and highlighting on the page come next.

## Search

The explorer's `search(text)` tool ranks nodes two ways and merges the rankings with Reciprocal Rank Fusion:

- **Keywords (BM25F)**, local and free: exact words, rare words weighted higher.
- **Meaning (embeddings)**: `gemini-embedding-001`, so "television" finds "TV". Page texts are embedded once per page and cached; later queries only embed the query.

Search can be limited to one subtree with `within`, e.g. `search('snowboard jacket', 'n4')` ranks only the nodes inside `n4` (say, a product list), so nav links and other sections can't crowd the results. Empty results come with a hint on what to try next.

Without a usable key (none, a `YOUR_...` placeholder, or one the API rejects), search uses keywords only. In the console, `await PageLens.debugSearch('jacket')` (or `debugSearch('jacket', 'n4')`) shows how each ranking placed the results.

## Testing the explorer

Two sets of queries, for all three sites:

- `tests/cases.json`: the **dev set**. Tune prompts and code against it.
- `tests/testset.json`: the **test set**. 60 held-out questions with their expected action, the page nodes that hold the answer (`evidence`), and a reference answer for the answer step later. Only run it to measure, never to tune: otherwise its scores stop meaning anything. Its header documents the format and the metrics.

Evidence is matched by text (node IDs change), against the page tree the explorer sees. `--check` verifies, without any LLM call, that every evidence item still matches a node on the live page; run it after changing a page, the extractor, or the set.

`tests/run.mjs` runs each case several times in headless Chrome (the model doesn't answer the same way every time) and reports per-case pass rates plus metrics, overall, per site and per question type: success, action accuracy, evidence recall, target precision, abstain precision/recall, and tool calls, tokens and seconds per query.

```sh
node build.js                       # a development build (uses the .env key)
npx serve .                         # demo at :3000 (in another terminal)
cd examples/shadcn-admin && npx vite --port 5174   # dashboard (another terminal)
cd examples/storefront && npx vite --port 5173     # storefront (another terminal)

node tests/run.mjs                  # dev set, 3 runs per case
node tests/run.mjs --set test       # test set
node tests/run.mjs --set test --check
node tests/run.mjs --site dashboard --runs 5 --only "profit"
```

API keys: the runner uses every `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, ... in `.env`, one headless Chrome per key, swapping the key into the page's Gemini requests. Rate limits are per Google Cloud project, so extra keys only help if they have their own quota. Each worker spaces its queries ~10 s apart (`--gap`). Every run saves a readable report to `tests/reports/<time>-<set>.md` (committed, so the history of scores stays in the repo) and every run's details to `tests/results/` (git-ignored). `node tests/run.mjs --report tests/results/<file>.json` rebuilds a report from saved details with the current scoring. Rates are over completed runs: runs that failed with an error (e.g. a 429 rate limit) are counted separately (`err`), and `node tests/run.mjs --retry-errors tests/results/<file>.json` reruns just those and saves a new report. `kw` counts runs where search fell back to keywords only.
