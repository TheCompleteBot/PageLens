# PageLens (MVP)

A plain-JS library that adds a chat assistant to a web page. A visitor types a question ("is delivery free?", "where can I book a table?"); PageLens finds the answer in the page's own content, replies in the chat, and scrolls to and highlights the parts of the page the reply is based on. If the page doesn't have it, it says so instead of guessing.

## Using PageLens on your site

### 1. Build the library with your key

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) and put it in a `.env` file at the project root (git-ignored), under any variable name:

```
GEMINI_API_KEY=your-key-here
```

Then build, naming that variable:

```sh
git clone https://github.com/TheCompleteBot/PageLens.git
cd PageLens
node build.js --key GEMINI_API_KEY      # writes dist/lib.js with the key baked in
```

`--key` defaults to `GEMINI_API_KEY`. The build prints only the key's last 4 characters, and warns (listing the variable names in `.env`, never their values) if the variable isn't there. Copy `dist/lib.js` into your site's static files (e.g. `public/pagelens/lib.js`).

**The key is visible to anyone who loads the page** (it is inside `lib.js`), so use a key with a low spending limit or a request quota, never one with access to anything else. Fine for a prototype, not for production. Don't commit `dist/`: it contains the key.

### Or use the hosted version

A copy built with the project owner's key is published on GitHub Pages, for people they share it with:

- Library: `https://thecompletebot.github.io/PageLens/lib.js`
- Live demo: `https://thecompletebot.github.io/PageLens/demo/`

Use it like a local copy, with `src="https://thecompletebot.github.io/PageLens/lib.js"` in the start tag (step 2). It is rebuilt and redeployed on every push to `main` by `.github/workflows/deploy.yml`, which takes the key from the repository secret `PAGELENS_GEMINI_KEY`; the built file never enters the repo. To set it up on a fork: add that secret (Settings → Secrets and variables → Actions) and set Settings → Pages → Source to **GitHub Actions**. The hosted `lib.js` contains the key, so use a dedicated key with a daily request quota, and share the link only with people you trust.

### 2. Mark the part of the page the assistant may use

Put the start tag where the assistant's region begins and the end tag where it ends. PageLens only reads, and only points to, what is between them; anything outside (e.g. a header or footer) is ignored. These two tags are the only change to your page.

```html
<body>
  <header>...ignored by the assistant...</header>

  <script src="/pagelens/lib.js"
          data-start
          data-provider="gemini"></script>

  <main>...products, prices, FAQs, tables: what the assistant may read and point to...</main>

  <script data-pagelens-end></script>

  <footer>...ignored by the assistant...</footer>
</body>
```

The start tag must be a plain `<script src>`: no `async`, `defer` or `type="module"` (PageLens finds its own tag while it loads).

Attributes on the start tag:

| Attribute | Default | Meaning |
|---|---|---|
| `data-start` | required | Marks this tag as the start of the region. |
| `data-provider` | `gemini` | The only provider so far. |
| `data-model` | `gemini-3.5-flash-lite` | Model for both LLM steps. On rate limits (429) or overload (5xx) requests are retried with backoff, then fall back to `gemini-3.5-flash`. |
| `data-navigator` | `llm` | `llm` (the explorer with tools) or `search` (the top search hit, no LLM; a baseline). |
| `data-debug` | off | Developer tools: a Tree view in the chat, and a step-by-step trace of every question in the browser console. |

### 3. Framework notes

- **Plain HTML:** put the tags in the page, as above.
- **Vite, Create React App and other single-page apps:** put them in `index.html` around the app's root element, e.g. around `<div id="root"></div>`. The content is read from the live page when a question is asked, so whatever the app renders counts.
- **Next.js (app router):** put them in `app/layout.tsx`, preferably **inside `<main>` around `{children}`**:

  ```tsx
  <main>
    {/* eslint-disable-next-line @next/next/no-sync-scripts */}
    <script src="/pagelens/lib.js" data-start="" data-provider="gemini" />
    {children}
    <script data-pagelens-end="" />
  </main>
  ```

  Next.js's lint rule `no-sync-scripts` rejects the start tag, hence the disable comment (or build with `next build --no-lint`). Placing the tags directly in `<body>` next to client components made React render them twice on one test site, which breaks the region; inside `<main>` it works.

Serve the page over HTTP (`npx serve`, your dev server, or your host), not from `file://`.

### 4. What visitors get

- A chat button in the bottom-right corner, drawn in its own Shadow DOM so your CSS can't affect it (and it can't affect your page).
- While it works, a status line showing what it's doing ("Reading \"Delivery Options\"…") and the seconds elapsed.
- Replies of 1 to 3 sentences, built only from the page's text. Every fact is cited; numbers must be quoted from the page or computed from quoted numbers, or the reply is not shown.
- Numbered highlights (up to 5) on the elements the reply is based on; the page scrolls to the first, and the chat has a button per highlight.
- "I couldn't find that on this page" when it isn't there, or "…might be under X" when it could be behind a link, a "See all" page, or a chart whose values aren't readable as text.

### 5. What is sent to Gemini

The visitor's question and the visible text of your marked region (as a compact page tree), with obvious personal data (emails, long phone numbers) replaced by `[email]` / `[phone]` before anything leaves the browser. Page text is treated as untrusted (prompt-injection attempts in it are ignored). Nothing is sent from outside the region.

### 6. Current limitations

- **Content that fades in on scroll is invisible until the visitor scrolls past it.** Many landing pages animate sections in (opacity 0 until they enter the screen); PageLens skips invisible elements, so questions about those sections fail until then. On two of our test sites this hid most of the page.
- **Infinite scroll and lazy-loaded content** (not yet loaded) can't be read. Out of scope for now.
- **Guide only:** it highlights and scrolls; it never clicks, types, fills forms or navigates. It only knows the current page.
- **Text only:** no images, and no values drawn in charts (only a chart's labels).
- **English only.** Gemini is the only provider. A question takes about 5–15 s (3–5 LLM calls: 2–4 for the explorer, 1 for the answer); free-tier keys are rate-limited.
- Long paragraphs are cut at about 200 characters in the page tree, so facts at the end of long text can be missed.
- **The API key is public.** It is written into `lib.js` (open the file, or DevTools → Sources) and sent with every request (DevTools → Network, the `x-goog-api-key` header), so anyone visiting the page can copy it. Only a backend that holds the key and forwards the requests would hide it; until then, use a key with a low spending limit or a daily request quota.

Measured accuracy (see Testing below and `tests/reports/`, latest full runs): 93% of replies correct on our 60-question test set, and 94% on three open-source sites never used for development, measured after scrolling the page; 0 of 12 before scrolling, because of the first limitation.

## Developing PageLens

The rest of this file is for working on PageLens itself.

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
  answer.js               4. answer step: writes the reply from the hand-off, with checked citations
  highlight.js            5. executor: scrolls to and highlights the cited elements
  query.js                query handler: explorer -> answer step -> highlights -> chat reply
  widget.js               5. chat widget (Shadow DOM) + debug Tree view
  main.js                 public debug API + startup
build.js                joins src/ into dist/lib.js (no dependencies)
dist/lib.js             the built file that pages include (generated, git-ignored; don't edit)
demo/index.html         sample e-commerce homepage
examples/               open-source React apps used for testing
tests/                  question sets (cases.json, testset.json, freshset.json), runner (run.mjs), reports/
```

## Building

Pages load `dist/lib.js`, which is generated and not committed (it contains the API key). Build it after cloning, and after editing anything in `src/`:

```sh
node build.js                       # build once, key from .env's GEMINI_API_KEY
node build.js --key GEMINI_API_KEY_3   # use another .env variable as the key
node build.js --watch --key key1    # rebuild on every save (leave it running; it restarts itself if build.js changes)
```

The key comes only from the build (see "Using PageLens on your site"); there is no key attribute on the start tag. To switch keys, rebuild with another `--key`.

## Running the demo

1. Build the library with your key: `node build.js --key GEMINI_API_KEY` (see "Building").
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

The three fresh-site apps (restaurant, app landing page, blog) and their commands, install steps and integration notes are in `examples/README.md`.

On a fresh clone, install dependencies first: `npm install` in `storefront`, `npx pnpm install` in `shadcn-admin`.

## Debug tools

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

## Answer step and highlights

The answer step (`src/answer.js`, same model as the explorer) gets only the hand-off and returns JSON: a short `reply` with markers like `[1]`, and `citations`, each an id from the hand-off plus the exact words quoted from it. Code checks it before anything is shown:

- every citation id is in the hand-off, and its quote is found word for word in that text (case, dashes and separators ignored);
- every number in the reply appears in a quote, or follows from quoted numbers by simple arithmetic (a sum, a difference, a ratio, the total), or is a small count.

A failed check is sent back once with the reasons; a second failure gives "I found related information on this page, but couldn't confirm an exact answer", with nothing highlighted. `abstain` needs no LLM call.

**What gets highlighted is exactly what the reply cites**, not the explorer's targets: each quote is narrowed to the smallest element holding it, then lifted to its record (a product card, a customer row), so a name and a price from one row are one highlight. Up to 5, numbered in reply order; the page scrolls to the first, and the chat shows a button per highlight that scrolls to it. The boxes are drawn in their own Shadow DOM layer over the page; the page itself is never changed.

While a question is being answered, the chat shows what PageLens is doing, taken from the explorer's real steps ("Searching this page for \"free delivery\"", "Reading \"Delivery Options\"", "Writing the answer"), with the seconds elapsed and "still working" after 15 s. The chat shows only the reply; with `data-debug`, the full journey (explorer turns, hand-off, answer step's attempts and checks) is printed to the browser console. `await PageLens.answer('...')` runs the whole pipeline from the console.

## Search

The explorer's `search(text)` tool ranks nodes two ways and merges the rankings with Reciprocal Rank Fusion:

- **Keywords (BM25F)**, local and free: exact words, rare words weighted higher.
- **Meaning (embeddings)**: `gemini-embedding-001`, so "television" finds "TV". Page texts are embedded once per page and cached; later queries only embed the query.

Search can be limited to one subtree with `within`, e.g. `search('snowboard jacket', 'n4')` ranks only the nodes inside `n4` (say, a product list), so nav links and other sections can't crowd the results. Empty results come with a hint on what to try next.

Without a usable key (a build without one, or a key the API rejects), search uses keywords only. In the console, `await PageLens.debugSearch('jacket')` (or `debugSearch('jacket', 'n4')`) shows how each ranking placed the results.

## Testing the explorer

Three sets of questions:

- `tests/cases.json`: the **dev set** (demo, dashboard). Tune prompts and code against it.
- `tests/testset.json`: the **test set**. 60 held-out questions on the demo, dashboard and storefront, with their expected action, the page nodes that hold the answer (`evidence`), and a reference answer. Only run it to measure, never to tune: otherwise its scores stop meaning anything. Its header documents the format and the metrics.
- `tests/freshset.json`: the **fresh-site set** (`--set fresh`). 51 questions on three sites never used for development (restaurant, app landing page, blog), including 4 asked without scrolling to measure the scroll-animation limitation. Sites marked `"scroll": true` are scrolled through once after loading.

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
node tests/run.mjs --set test --answer --keys key1,key2,key3,key4   # all three stages
```

The report scores each stage separately:

- **Retrieval** (the automatic first search, before any LLM call): recall@1/3/8 of the needed evidence among the search hits, and MRR.
- **Explorer**: answerable, action accuracy, target and context recall, target precision, abstain precision/recall, cost.
- **Answer step** (with `--answer`, one more LLM call per query): end-to-end correctness (what the visitor sees), reply status (answered / couldn't confirm / abstained), first-try check pass rate, fact recall against the reference answer's key values, highlight recall/precision.
- **Abstain** as binary classification for both the explorer's decision and the final reply: TPR, TNR, precision, accuracy and Cohen's kappa (cases where both abstaining and answering are acceptable are left out).

API keys: the runner uses every `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, ... in `.env`, or exactly the variables named with `--keys` (any names, e.g. `key1,key2`), one headless Chrome per key, swapping the key into the page's Gemini requests. Rate limits are per Google Cloud project, so extra keys only help if they have their own quota. Each worker spaces its queries ~10 s apart (`--gap`). Every run saves a readable report to `tests/reports/<time>-<set>.md` (committed, so the history of scores stays in the repo) and every run's details to `tests/results/` (git-ignored). `node tests/run.mjs --report tests/results/<file>.json` rebuilds a report from saved details with the current scoring. Rates are over completed runs: runs that failed with an error (e.g. a 429 rate limit) are counted separately (`err`), and `node tests/run.mjs --retry-errors tests/results/<file>.json` reruns just those and saves a new report. `kw` counts runs where search fell back to keywords only.
