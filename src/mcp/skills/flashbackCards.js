// The card-authoring guide the MCP server hands to an AI assistant on request
// (`get_card_guide`). Product content, not vault content — it ships with the app and is
// identical for every user, so it lives here as source rather than in a vault or a data
// file the user could drift out of sync.
//
// EMBEDDED ON PURPOSE. The obvious alternative — keeping SKILL.md on disk and reading it
// at call time — has to survive being packaged inside app.asar and launched through
// Electron's bundled Node, which is a real failure mode for a nice-to-have tool. A JS
// module is just code: bundled by definition, no path resolution, no fs at runtime.
//
// EDITING. The prose below is ordinary Markdown held in template literals, so backticks
// are escaped as \` — that is the only transformation applied to it. It is otherwise
// byte-identical to the SKILL.md / references/ layout of a Claude Skill bundle, so the
// bundle can still be rebuilt from these strings if the guide is ever shipped that way too.
//
// The frontmatter fields are split out because the tool's own description is composed from
// `description` — edit it here and what the model reads about when to call the tool follows.

const flashbackCards = {
    name: 'flashback-cards',
    description:
        'Author, diagnose, and repair flashcards in the Flashback vault (spaced repetition + knowledge graph app) so they survive long-interval review — decomposing material into atomic, precisely-cued prompts and creating them through the Flashback MCP tools. Use this whenever the user asks to make, add, generate, fix, rewrite, or review flashcards, cards, prompts, or a deck in Flashback, or asks to turn a document, book, chapter, article, video, or topic into study material — even if they only say "make me some cards on X" or "card this chapter." Also use when the user says cards feel too hard, keep lapsing, are "a mouthful," or when they want to know whether a deck is well built.',

    body: `# Authoring Flashback cards

## The governing constraint

A card is a recurring task you are handing to a person for the next several years. Card design is task design. The cost of a badly formulated card is not one bad review — it is a card that lapses indefinitely, drags the scheduler, and eventually makes the user resent the deck.

Everything below follows from one rule:

**One card, one retrieval.** If answering correctly requires recalling two things that can be forgotten independently, it is two cards.

"One retrieval" means one *chunk*, not one token. A chunk can be several words long — \`tail -n 10 file.txt\` is retrieved as a single motion by anyone who knows \`tail\`. What breaks a card is composing chunks the user does not yet hold together, behind a single binary grade.

Two reasons this matters more in Flashback than in a generic SRS:

1. **Memory mechanics.** Simple items rest on a single connection that review refreshes uniformly. Complex items get partially activated, in an order that shifts with context, so no review strengthens the whole thing evenly. This is Wozniak's minimum information principle, and it is the most load-bearing idea in card design.
2. **Signal quality.** Grading is binary. A card carrying five facts is graded as one, so the ReviewLog cannot record which fact failed, and the scheduler reschedules all five on the strength of the weakest. Since Flashback's longer-term ambition is to use retention data as a quality signal, bundled cards do not merely study badly — they corrupt the measurement.

## Step 0 — read the vault before writing anything

In this order, every time:

1. \`list_categories\` — valid category names. An unrecognized value is rejected, not silently dropped.
2. \`list_cards\` with \`origin: "human"\` — the handmade cards **are the style spec**. Match their length, phrasing, and cue conventions rather than inventing a house style.
3. \`list_decks\` — locate the target deck. Note whether a new one is needed.
4. \`list_cards\` with \`sortBy: "lapses"\` — cards the user keeps failing. A high-lapse card is nearly always a formulation problem, not a memory problem. Offer to rewrite them; this is often more valuable than adding new cards.
5. If carding a document: \`list_highlights\` with \`uncardedOnly: true\`, then read the body. The user's highlights are their declaration of what matters — prefer them over your own judgment of importance.

   **Reading the body.** \`read_document\` returns \`content\` for Markdown, plain text, and \`.clip\`/\`.youtube\` stubs, plus the sidecar (existing cards, tags, highlights) for everything. For a PDF, EPUB, image, audio, or video it returns \`content: null\` — this is **not** a dead end. Call \`read_document_text\` with the same path: it extracts and paginates server-side, addressed by format. PDFs by page number, EPUBs by spine section number or href, YouTube transcripts by segment (or \`at\` = seconds to jump to a moment). Start with \`path\` alone, then follow \`next\` until \`hasMore\` is false, and \`nextCharOffset\` when a unit comes back \`truncated\`. Each response carries a \`label\` like "p. 37" or a timestamp — cite it when a card comes from a specific place.

   **Its pictures and sound.** Text extraction returns prose only, so a document's media comes from its own tools: \`list_book_images\` for an EPUB, \`list_clip_media\` for a saved web clip (which also holds any short audio the page had). Both list metadata — alt text, caption, the section or heading it sits under — so you can usually tell which figure is which without looking; \`view_book_image\`/\`view_clip_image\` when you can't. Put one on a card with \`attach_book_image\`/\`attach_clip_media\`. This is worth a call on any illustrated source: see *adding non-redundant cues* below for why a real diagram beats a description of one, and note that a pronunciation recording is the only honest front for a pronunciation card.

   Two real limits: scanned PDFs have no text layer and return nothing, and \`search_content\` only covers \`.md\`/\`.txt\` bodies, so a miss there is not evidence the vault lacks a topic — check highlights and existing cards on the media documents too.

## The house style

Read from the handmade cards, and worth preserving:

- **Fronts are terse task descriptions, not prose questions.** \`Initialize a git repository\`, not \`What is the command you would use to create a new repository in the current directory?\`
- **Concrete literals go in parentheses at the end of the front.** \`Git command to stage a file (readme.md)\` → \`git add readme.md\`. This is an elegant convention: it pins the exact expected answer without inflating the sentence the user has to parse.
- **\`type_answer\` answers are the bare artifact.** No trailing prose, no explanation, no parenthetical in \`answerText\` — it is compared literally, so anything extra is a way to fail a card the user knew. Explanation that belongs *with* this card goes in \`backText\`, which is shown after checking and never compared (a mnemonic, a why); explanation that stands on its own belongs on a separate \`basic\` card.
- **Symbol cards are irreducible pairs.** \`あ\` → \`a\`. Nothing to decompose further. This is the target shape; the further a card is from it, the more justification it needs.

## Choosing targets, then writing prompts

These are two separate jobs. Do them in order and do not merge them — merging is how you end up writing a prompt for whatever sentence you happen to be looking at.

**First, choose targets.** Read the material and mark the specific pieces worth being able to recall. Not everything is a target: things the user already knows, things trivially inferable from what they know, and things they will never need cold are all correctly skipped. When highlights exist, they are the target list.

**Then, write one or more prompts per target.** How depends on the kind of knowledge — factual, procedural, or conceptual. See \`references/knowledge-types.md\` for worked patterns for each, including closed vs. open lists and the conceptual lenses (attributes, similarities/differences, parts/wholes, causes/effects, significance).

For sets larger than roughly ten cards, show the user the target list before drafting the cards. Targets are cheap to correct; cards are not.

## Card type selection

| Type | Use for |
|---|---|
| \`type_answer\` | Production of a short exact artifact the user must type from memory: a command, an operator, a keyword, a kana, a signature fragment. \`answerText\` is graded; \`backText\` is optional notes revealed afterwards |
| \`basic\` | Anything graded by judgment: explanations, distinctions, "why", tradeoffs, heuristics |
| \`cloze\` | A target embedded in a structure where seeing the structure is itself part of the knowledge — a slot in a statement, an item in a closed list. Blanks in \`{{double braces}}\` |
| \`reversible\` | Irreducible symmetric pairs only (term ↔ symbol, word ↔ translation). Skip it when one direction is far easier than the other |
| \`custom\` | Raw HTML, for layout that carries meaning — tables, positioned diagrams |

Default to \`type_answer\` for production and \`basic\` for understanding. Cloze is fast to write and mnemonically strong, but it is the format most vulnerable to pattern matching: with a long or distinctive sentence, the user learns the shape of the sentence rather than the knowledge. Keep cloze sentences short and generic.

## Five properties, checked before saving

- **Focused** — one detail. Excess detail dulls attention and produces incomplete retrievals.
- **Precise** — unambiguous about what is being asked for. Vague questions produce vague answers.
- **Consistent** — the same answer every time. Otherwise related-but-unrecalled knowledge is actively inhibited (retrieval-induced forgetting).
- **Tractable** — answerable nearly always. If it is not, break it down or add a cue.
- **Effortful** — the answer must actually be retrieved, not inferred from the question.

Then two litmus tests:

**False positive: could the answer be produced without knowing the thing?** Long questions with distinctive wording get memorized as shapes. Cues that narrow to one possible answer give it away.

**False negative: could the user know the thing and still be marked wrong?** This is the one that kills syntax cards, and it has a reliable tell:

> If you find yourself appending a hint so that only your intended answer fits — "…using a range test", "…using a set membership test" — the front is asking for a *task outcome* when the target is a *specific construct*. Name the construct in the front instead of hinting at it. See "When several constructs satisfy the same task" below.

## Syntax, command, and code cards

This is where cards most often fail, so it gets explicit rules.

### The answer is one chunk, not one token

Production cards exist to build motor memory for things the user will actually type. That means the answer should be **a whole invocation they would really run** — not a decomposed fragment. \`tail -n 10 file.txt\` and \`Get-ChildItem -Recurse -Filter *.txt\` are correct answer shapes. Reducing them to \`-n\` or \`-Recurse\` destroys exactly what the card is for.

The unit is one *chunk*: a piece the user can already hold as a single thought. A chunk may be several tokens. \`rm -r build\` is one chunk — command, its idiomatic flag, its argument, retrieved together. What is not acceptable is a *composition of independent chunks* behind one grade.

The size of a chunk is a property of the learner, not the material. As fluency grows, what was three chunks becomes one, and cards should grow with it. So this is a ladder, not a fixed rule: write production cards at the largest size the user can currently retrieve in one motion.

### Front length is the real constraint

Compare two real cards from the vault. Both have multi-token answers; only one works.

> **Works** (level 4) — Front: \`[Bash] Show the last 10 lines of file.txt\` → Back: \`tail -n 10 file.txt\`
>
> **Stalled** (level 0) — Front: \`[SQL] Return all columns, matching each orders row to customers where orders.customer_id equals customers.id, keeping only rows that match in both tables\` → Back: \`SELECT * FROM orders INNER JOIN customers ON orders.customer_id = customers.id;\`

The answers are comparable. The fronts are not: eight words versus twenty-six. A long front is a specification the user must decode before retrieval even starts, and decoding competes with recall. **Keep fronts to roughly a dozen words, phrased as a task, with concrete values supplied compactly.**

### When several constructs satisfy the same task, name the construct

Shell tasks usually have one idiomatic answer, so a plain task description is unambiguous. Expressive languages are different: "rows where total is between 50 and 100" is satisfied by \`BETWEEN\` and by \`>= AND <=\` equally. This is a property of the language, not a defect in the card — and the fix is to put the construct in the front rather than bolting on a disambiguating hint.

Use the vault's existing convention: construct plus a compact parameter list.

| Front | Back |
|---|---|
| \`[SQL] BETWEEN filter on orders.total (50, 100)\` | \`SELECT * FROM orders WHERE total BETWEEN 50 AND 100;\` |
| \`[SQL] INNER JOIN orders to customers (orders.customer_id, customers.id), all columns\` | \`SELECT * FROM orders INNER JOIN customers ON orders.customer_id = customers.id;\` |

Whole statements preserved, motor memory intact, fronts cut by two thirds, ambiguity gone.

### When a whole statement really is too big, scaffold — don't replace

If the user keeps lapsing on a full-statement card, the sub-chunks underneath it are not yet mature. Add smaller cards for the weak pieces **alongside** the full one, and let the full one climb as its parts strengthen. Deleting it and keeping only fragments trains recognition instead of production, which is the opposite of the goal.

### Strip characters that carry no knowledge

Trailing semicolons, optional aliases, cosmetic whitespace, arbitrary casing: each is a way to fail a card the user actually knew. Keep the answer to the canonical minimum. Confirm how \`type_answer\` grades — if the comparison is exact, this is not cosmetic advice, it is the difference between a usable deck and an infuriating one.

### Fix the schema across a deck

When syntax cards need table and column names, use the same ones on every card in the deck. Otherwise the user is recalling arbitrary identifiers alongside the actual knowledge, and each card carries a private vocabulary.

## Multiple activator cues

The vault's own framing — flashcards as neuron pairs, fronts as activator neurons — converges on the consistency property from the graph side, and its prescription is correct. State it as a rule:

**When one cue legitimately maps to several answers, the cue is underspecified. Split by moving the distinguishing feature onto each front, rather than listing alternatives on one back.**

Not \`dog → chien / chienne\`, but two cards whose fronts carry complete cue sets (\`dog, masculine → chien\`; \`dog, feminine → chienne\`). Each then has exactly one correct answer, while the shared cue still activates both paths in the mind.

The corollary matters for card design generally: **adding non-redundant cues to a front is a feature; adding context is not.** An image of a dog beside the word "dog" is a second activator — more entry points to the same answer, and elaborative encoding makes it stick harder. A 26-word description of a join is context — more to parse before retrieval starts. Distinguish these ruthlessly. When a concept is genuinely visual, \`attach_media\` is cheap and worth it.

## Category mapping

Priority drives review order — vocabulary before models before production — so categories are pedagogically load-bearing, not labels.

| Category | Priority | Use for |
|---|---|---|
| Definition, Symbol, Syntax, Terminology | 0 | Irreducible vocabulary: what a term means, a glyph's reading, a construct's surface form |
| Concept, Example | 1 | Why something works, distinctions, tradeoffs; instances of usage |
| Command, Exercise | 2 | A shell/tool invocation for a task; multi-step application |

Syntax vs. Command: Syntax is a language construct's written form; Command is a tool invocation. Concept vs. Definition: Definition is what a word means, Concept is how or why something behaves.

If nothing fits, ask before calling \`create_category\`. Categories cannot be deleted, only renamed.

## Volume

Write more cards than feels natural. The instinct to economize is strong and wrong: the quantity of knowledge is fixed by the material, so coarse cards do not reduce what must be learned — they only make it harder to review. An easy card costs roughly 10–30 seconds across an entire first year.

The counterweight is not coarseness but selection. Do not card what the user already knows, and do not card completionistically. A card that no longer serves anything should be deleted, not endured.

## Mechanics and known gotchas

- Cards created through the MCP server are permanently marked \`origin: "ai"\`. This is how the user audits provenance — do not work around it.
- \`create_flashcard\` without \`path\` lands the card in the **system deck**. Putting it in a named deck is a **separate \`add_to_deck\` call**. This is easy to forget and leaves the intended deck empty.
- \`backText\` and \`answerText\` store HTML entities literally — \`&gt;\` is saved as those four characters, not \`>\`. Write the literal character, then read back and fix with \`update_flashcard\` if needed. On \`answerText\` this is not cosmetic: the stored string is what the typed input is compared against.
- **Old \`type_answer\` cards look answer-less and are not.** A card written before \`answerText\` existed reports it as null and still keeps its graded answer in \`backText\`. Read null as "old shape", not "empty card", and never overwrite \`backText\` on one without first moving its contents into \`answerText\` in the same \`update_flashcard\` call — otherwise you have deleted the answer and kept nothing.
- Anchor to source when possible: \`path\` plus \`highlightHash\` ties the card to the passage it came from, which is what makes the vault a graph rather than a pile of cards.
- \`update_flashcard\` takes the \`globalHash\` returned by \`create_flashcard\`, plus \`documentPath\` for document-anchored cards.

## Workflow

1. Read the vault (Step 0).
2. Choose targets. For sets over ~10, show the list before drafting.
3. Draft the cards, applying the five properties and both litmus tests to each.
4. Create them, then \`add_to_deck\` — do not skip this.
5. Read a sample back to verify rendering, especially anything with symbols or escapes.
6. Report what was made, and flag anything deliberately omitted and why.`,

    // Loaded only when asked for by name, the way a Claude Skill's references/ dir works:
    // the guide is large, and most card-authoring turns never need the deeper patterns.
    references: {
        'knowledge-types': {
            title: 'Prompt patterns by knowledge type',
            summary: 'Worked patterns for factual, procedural and conceptual targets; closed vs. open lists; salience cards; and a checklist for diagnosing cards already in the vault.',
            body: `# Prompt patterns by knowledge type

Read this when choosing how to turn a target into one or more cards. The three types
below usually appear together in any real source; a single paragraph often contains
factual, procedural, and conceptual material that needs different treatment.

## Contents

- [Factual knowledge](#factual-knowledge)
- [Lists: closed vs. open](#lists-closed-vs-open)
- [Procedural knowledge](#procedural-knowledge)
- [Conceptual knowledge](#conceptual-knowledge)
- [Salience and behavior cards](#salience-and-behavior-cards)
- [Revision: diagnosing cards already in the vault](#revision-diagnosing-cards-already-in-the-vault)

---

## Factual knowledge

Raw information with few internal relationships. The default and easiest case.

Pattern: one focused question, one short answer.

\`\`\`
Front: What type of chicken parts are used in stock?
Back:  Bones
\`\`\`

**Pair facts with explanations when the fact is arbitrary or the explanation is
interesting.** Explanations make facts meaningful, which makes them stick, and they
give the fact hooks to connect to later learning.

\`\`\`
Front: How do bones produce a chicken stock's rich texture?
Back:  They're full of gelatin
\`\`\`

Note the phrasing: an earlier draft asked *"Why do we use bones?"*, which invites
"because they're cheap" — a correct answer that isn't the target. Precision in the
question is what makes the answer consistent.

**Interpretation is part of the job.** Source material is often phrased in a form
that shouldn't be memorized literally. A recipe listing "2 lbs bones, 2 qt water"
is really teaching a ratio; card the ratio, not the batch size.

## Lists: closed vs. open

**Closed lists** have fixed membership — treat them as a single complex fact and
card them with cloze deletions that blank one element at a time, keeping element
order stable across variants so the list's visual shape becomes a memory aid.

\`\`\`
Front: Typical chicken stock aromatics: {{onion}}, carrots, celery, garlic, parsley
\`\`\`

**Open lists** grow indefinitely — examples of a category, applications of a
technique, things a tool is good for. Cloze fails here: anything could fill the
blank. Use three prompt types instead:

1. **Instance → tag.** "When puréeing vegetables for soup, how can I add richness
   without fat?" → "Thin with stock instead of water."
2. **A prompt about the pattern itself,** once several instances exist. "What should
   I ask myself when I notice I'm using water in savory cooking?"
3. **A fuzzy tag → instances prompt**, asking for a couple of examples. This one
   only works when supported by the first kind; alone, the user answers with the
   same two examples forever and forgets the rest.

Deciding which kind a list is depends on the user's expertise. A closed list to a
novice is often an open one to an expert.

## Procedural knowledge

Knowing how rather than knowing what. Procedures look like lists, but carding them
as lists produces unfocused prompts full of incidental detail.

**Extract the keywords first.** Strip the procedure to the words that actually carry
the knowledge. In "slowly bring to a simmer, then maintain a bare simmer for 90m,"
four phrases carry everything: *slowly*, *simmer*, *bare simmer*, *90m*. The rest is
skeleton.

**Then turn each keyword into a question.** For each: what are the important verbs,
adjectives, and adverbs? What are the conditions for moving between steps?

\`\`\`
Front: At what speed should you heat a pot of ingredients for stock?
Back:  Slowly

Front: How long must chicken stock simmer?
Back:  90m
\`\`\`

**Skip the obvious steps.** If the first and last steps follow from knowing what the
thing is, they are not targets.

**Capture branches.** Conditions, special cases, and alternate paths are usually
worth their own cards — they are the part of a procedure people actually get wrong.
If the branching is complex, a flowchart image on the card beats prose.

**Add "heads-up" cards.** Details like "this takes about an hour to come to
temperature" aren't essential to executing the procedure, but they let the user
notice when something is going wrong.

**Explanation cards are especially valuable here** — they are the difference between
following a procedure and understanding it. When the source only supports one level
of "why," phrase the answer as attributed rather than absolute.

## Conceptual knowledge

The hardest kind, and the one where a definition card creates the illusion of
understanding. Being able to recite "stock is a flavorful liquid building block" is
not knowing what stock is. The goal is a **set** of cards that collectively trace the
concept's edges.

Five lenses. Not all apply to every concept — treat them as a checklist for finding
the ones that do.

- **Attributes and tendencies** — what makes it what it is? What is always,
  sometimes, and never true of it?
- **Similarities and differences** — what does it relate to, and what distinguishes
  it from the adjacent concept it's most often confused with?
- **Parts and wholes** — examples, sub-concepts, the broader category it belongs to.
- **Causes and effects** — what does it do, what causes that, when is it used?
- **Significance and implications** — why does it matter? This is where the concept
  gets connected to something the user cares about.

**Avoid binary prompts.** Yes/no and this/that questions take little effort and
produce shallow understanding — and can often be answered without understanding the
question. Rephrase them as open questions, usually by connecting them to an example
or an implication.

\`\`\`
Weak:   Does chicken stock make vegetable dishes taste like chicken?  → No
Better: How does chicken stock affect the flavor of vegetable dishes? → Makes them taste more "complete"
\`\`\`

## Salience and behavior cards

A card can serve a purpose other than recall: keeping an idea present until it has a
chance to attach to something real. New ideas are vivid and then fade; a card can
extend that window deliberately.

\`\`\`
Front: What should I ask myself when I notice I'm using water in savory cooking?
Back:  "Should I use stock instead?"
\`\`\`

These are phrased around **situations in the user's life**, not around the idea in
the abstract. Being able to answer a factual question about something does not mean
it will occur to you when it's useful — that gap is what these cards target.

Related: **creative prompts** ("name an example you haven't given before")
deliberately violate the consistency property. They reinforce the machinery used to
generate an answer rather than any particular answer, and they benefit from the
generation effect. They're legitimate but less well understood — use them
sparingly, and never as a substitute for the retrieval cards that support them.

## Revision: diagnosing cards already in the vault

Cards are written before their problems are visible; a formulation flaw may only
surface once the interval reaches several months. Revision is therefore a normal
part of the practice, not a sign of having done it wrong.

Sort by \`lapses\` descending. For each high-lapse card, work through this:

1. **Is it bundled?** Does answering require two independently forgettable things?
   → Split it.
2. **Does it admit other correct answers?** Would a reasonable person answer
   differently and be right? → Re-aim the question at the specific construct, or add
   genuine context rather than a disambiguating hint.
3. **Is it answerable by shape?** Long or distinctive wording invites memorizing the
   question rather than the knowledge. → Shorten and generalize.
4. **Does the answer contain characters that carry no knowledge?** Trailing
   punctuation, arbitrary casing, optional whitespace. → Trim to canonical form.
5. **Is the foundation missing?** Some cards fail because the material underneath
   them was never carded. → Add the prerequisite cards; the hard one often fixes
   itself.
6. **Does the user still care about it?** → If not, delete it. Reviewing material
   nobody wants is what kills a practice.

The strongest single signal is the user's own reaction: an internal sigh at a card
during review means it needs revision, whatever the statistics say.

---

## Sources

- Piotr Wozniak, *Effective learning: twenty rules of formulating knowledge* (1999)
  and the minimum information principle.
- Andy Matuschak, *How to write good prompts: using spaced repetition to create
  understanding* (2020) — source of the five properties, the litmus tests, and the
  knowledge-type patterns above.
- Michael Nielsen, *Augmenting Long-term Memory* (2018).`,
        },
    },
};

export default flashbackCards;
