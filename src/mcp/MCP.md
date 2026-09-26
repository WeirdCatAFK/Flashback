# MCP server

`npm run mcp` → `server.js`, with tools in `tools/read.js` and `tools/write.js`. An external process
that AI assistants launch themselves, using the snippet from Config → AI Assistant. It never
imports `src/api/access/`: every tool call goes over HTTP to a running API through `client.js`,
authenticated with `FLASHBACK_API_TOKEN`. An `.mcp.json` copied before tokens existed has no token
and gets 401 — re-copy the snippet.

stdout carries JSON-RPC frames, so diagnostics go to `console.error()` only.

## Document bodies reach a model as text

The server has no renderer, so a body reaches it as decoded text or not at all. `read_document`
returns text formats directly; for a PDF, EPUB or media file it returns sidecar metadata plus a
pointer to `read_document_text` (`/api/reader`), which paginates extracted text by the format's
native unit (`page`, `section`, `chars`, `segment`). Every tool that touches a body —
`read_document`, `read_document_text`, `update_document`, `create_highlight` — works in those terms.

## The one bytes exception: figures inside captured documents

A figure is not a body: a diagram *is* its bytes, has no text form, and is often the best front a
card can have. The exception covers content whose bytes are the content, and two carriers meet it,
each with the same three-tool split — list by metadata (no bytes), view as an MCP image block
(capped at 4 MB, never resized), attach by copying through the API:

- **EPUB** — `list_book_images` / `view_book_image` / `attach_book_image`. The images live inside the
  book's zip, where `attach_media`'s filesystem path cannot reach.
- **Web clips** — `list_clip_media` / `view_clip_image` / `attach_clip_media`. Assets start on the
  web; viewing or attaching one saves it into the clip's `media/` first, so `cached` says where the
  bytes are, never whether they may be used. `list_clip_media` also lists audio, which only
  `attach_clip_media` handles — a model cannot listen, so `view_clip_image` refuses audio.

Rasterized PDF pages and a bytes-returning `read_document` do not meet the test. A third carrier
needs the same justification.

## The card guide

`skills/flashbackCards.js` is the authoring guide `get_card_guide` serves — product content,
embedded as template literals. Its file header explains why it is embedded and how to edit it.
`tests/mcp.test.js` fails if the guide names a tool the server does not register.
