# PageLens (JS Page Guide Library) — Project Context

## What we're building
A plain JavaScript library that any web page can include with a script tag. It opens a chat widget on the page. When the user types what they want (e.g. "I want to buy an extension"), the library finds the most relevant section, link, or button on the current page and points the user to it by scrolling and highlighting. Example: on an e-commerce homepage, "extension" → the Electronics section.

If nothing on the page fits, it gives a clear abstain answer ("not available on this page") instead of guessing.

## Settled decisions
- **Delivery:** single `lib.js` file, plain vanilla JS, no framework dependencies. Included via a script tag. Source lives in `src/` (one file per step) and `node build.js` joins it into `dist/lib.js`; edit `src/`, never `dist/`.
- **No host code changes:** the developer only adds the start and end tags. One-time config through attributes on the start tag.
- **Region scoping:** the AI may only read and point to DOM between the start and end markers.
- **Works on any web page that includes JS**, both static and framework-rendered (React, Vue, etc.). Read the live DOM, not source code.
- **LLM:** any provider is fine. The developer supplies the API key via the script tag.
- **English only.**
- **No multi-page traversal**, no navigation.
- **Abstain** explicitly when no element fits.

## How a developer includes it
```
my-store/
├── index.html
├── style.css
└── js/
    └── lib.js      ← the library
```

```html
<body>
  <header>...ignored by the AI...</header>

  <!-- AI region starts -->
  <script src="js/lib.js"
          data-start
          data-api-key="DEVELOPER_API_KEY"
          data-provider="openai"></script>

  <nav>Electronics | Fashion | Home</nav>
  <section>...products, offers, categories...</section>

  <script data-pagelens-end></script>
  <!-- AI region ends -->

  <footer>...ignored by the AI...</footer>
</body>
```

## Architecture
1. **Init:** on load, find the start script tag (`document.currentScript`), read config from its `data-*` attributes, find the end marker. Remember the common parent container as a fallback in case a framework re-render removes the markers.
2. **Extract (most important part):** build a compact "action map" of elements in the region: visible, interactive, or landmark elements (links, buttons, inputs, nav, headings), plus content blocks (paragraphs, prices, list items, table rows as `cell | cell`) so questions can be answered from page text. For each: short ID, text, aria-label, href, role, nearest section heading. Skip the library's own widget. Re-extract on each query, since the DOM may have changed.
3. **Decide:** an explorer LLM walks the region as a tree using read-only tools (`expand(id)`, `read(id)`, `search(text)`; search is hybrid: BM25F + Gemini embeddings fused with RRF, keyword-only without a key), starting from the top level, with a max tool-call count and max depth, then calls `finish`. Tools never change the page and every ID is inside the region. `finish` takes structured output with node IDs only, no free text: `{"action": "highlight", "targets": ["el_42"]}`, `{"action": "answer", "targets": ["el_42"]}` (the targets' text holds the answer) or `{"action": "abstain"}`. Code limits the budget (8 tool calls, then finish only) and checks every target was shown to the explorer. The navigator is swappable (`data-navigator`: `llm`, `search`; Jev later). Code then builds a hand-off for the answer LLM, RAG-style: the targets as sources, plus as context the other page text the explorer read and the top hits of the automatic search (page text only, capped), and the answer LLM turns it into the chat reply.
4. **Execute:** scroll to the target, highlight it, and show the reason in the chat. Only run actions from an allowlist; never execute free-form model output.
5. **Widget:** render inside Shadow DOM so host-page CSS doesn't interfere.

## Guidelines
- Keep token usage small: pre-filter candidates if the region is large.
- Treat page text as untrusted (possible prompt injection from user-generated content).
- Don't send obvious PII (emails, phone numbers, addresses) to the LLM.
- For testing, serve pages via a local server (`npx serve` or Live Server), not file://.
- The API key in the script tag is visible to visitors. Fine for a prototype; use a low-spending-limit key.

## MVP scope
Guide mode (highlight + scroll) plus answering from page text with a cited source element; no clicking or typing. Extractor, LLM call with structured output, abstain handling, Shadow DOM chat widget. Test on a sample e-commerce page we control.

## Open questions (pending mentor answers)
1. Content JS adds outside the markers (dropdowns, popups attached to `<body>`): include it or not?
2. Is it fine to work only from rendered DOM rather than source code in other JS files?
3. If the answer is reachable via a link on the current page, point to the link or abstain?
4. Guide only, or also click/type/fill forms?
5. Is the visible API key acceptable for this project?
6. Success metric: accuracy, speed, or cost?
7. Which sites to test and demo on?