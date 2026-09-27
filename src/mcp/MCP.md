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
`read_document`, `read_document_text`, `update_document` — works in those terms.

## Cards come from the user's highlights

Every card created through the MCP is anchored to a highlight the user made: `create_flashcard`
requires a document `path` and the `highlightHash` of a highlight in it, checks that the
highlight exists, and writes the card with `location: { type: 'highlight', id }`. There is no
standalone creation. A highlight is the user choosing what is worth remembering, so the rule
keeps AI cards on those choices and under the user's supervision, and stops an assistant from
mass-producing cards out of a document. One highlight may still carry several cards, since
splitting a passage into single retrievals is what the card guide teaches.

Two consequences:

- **The MCP cannot create highlights.** A highlight records no author, so a model that could
  highlight could card anything. `update_highlight` and `delete_highlight` remain.
- **Reading is unrestricted.** Context is how a model cards a highlight well, so every reading
  tool still reaches the whole document. The rule limits what becomes a card, not what can be
  read.

It is enforced in the tool handler, not the API. The handler is the only path a model has to
the vault, and the app itself (and imports) must stay free to make document-less cards.

## Small answers by default

A model reads every character a tool returns, and a vault's raw payloads are large: the due
queue repeats each card's full row in `queue`, `due` and `new`; a folder listing carries every
child's whole sidecar; a heavily carded book's sidecar holds hundreds of cards and highlights.
Handed over as they come, those ran to 88k–735k characters and had to be parsed with scripts.
So the handlers shape them (`tools/shape.js`, and the helpers at the top of `read.js`): counts,
names and text clipped to 160 characters by default, with a named opt-in for the rest
(`sidecar: "full"`, `queueLimit`, `verbose`). Every path-named field leaves with forward slashes,
matching what the tools accept.

Bulk deletion follows the same caution in the other direction. `delete_flashcards` resolves a
selection (hashes, or `list_cards`' filters) and returns a preview; only a second call with
`confirm` and the previewed `expectedCount` deletes, so a set that changed in between is refused
rather than deleted unseen. It deletes through the per-card route, so every rule that route
enforces still applies.

## Tools speak the app's terms

A model relays what it reads to the user, so tool descriptions and the `INSTRUCTIONS` in
`server.js` describe the data the way the app shows it. How well a card is held is its `gap`
between reviews and the band it falls in (`GAP_BANDS`, imported from `src/shared/intervals.js`
so the two cannot drift), not its raw `level`. That is how `list_cards`, `get_card_overview`,
`list_decks`' `standing` and `get_statistics`' `bands` present cards. Categories carry the
1-based `level` the Metadata screen numbers them by, tags carry their reach, and
`get_recent_changes` folds a run of identical commits the way Seal History does. A tool that
reshapes an API response does it in the handler; the API stays the source of the data.

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
