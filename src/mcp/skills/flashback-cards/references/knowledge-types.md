---
title: Prompt patterns by knowledge type
summary: Worked patterns for factual, procedural and conceptual targets; closed vs. open lists; salience cards; and a checklist for diagnosing cards already in the vault.
---
# Prompt patterns by knowledge type

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

```
Front: What type of chicken parts are used in stock?
Back:  Bones
```

**Pair facts with explanations when the fact is arbitrary or the explanation is
interesting.** Explanations make facts meaningful, which makes them stick, and they
give the fact hooks to connect to later learning.

```
Front: How do bones produce a chicken stock's rich texture?
Back:  They're full of gelatin
```

Note the phrasing: an earlier draft asked *"Why do we use bones?"*, which invites
"because they're cheap" — a correct answer that isn't the target. Precision in the
question is what makes the answer consistent.

Interpretation is part of the job. Source material is often phrased in a form
that shouldn't be memorized literally. A recipe listing "2 lbs bones, 2 qt water"
is really teaching a ratio; card the ratio, not the batch size.

## Lists: closed vs. open

Closed lists have fixed membership — treat them as a single complex fact and
card them with cloze deletions that blank one element at a time, keeping element
order stable across variants so the list's visual shape becomes a memory aid.

```
Front: Typical chicken stock aromatics: {{onion}}, carrots, celery, garlic, parsley
```

Open lists grow indefinitely — examples of a category, applications of a
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

```
Front: At what speed should you heat a pot of ingredients for stock?
Back:  Slowly

Front: How long must chicken stock simmer?
Back:  90m
```

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

```
Weak:   Does chicken stock make vegetable dishes taste like chicken?  → No
Better: How does chicken stock affect the flavor of vegetable dishes? → Makes them taste more "complete"
```

## Salience and behavior cards

A card can serve a purpose other than recall: keeping an idea present until it has a
chance to attach to something real. New ideas are vivid and then fade; a card can
extend that window deliberately.

```
Front: What should I ask myself when I notice I'm using water in savory cooking?
Back:  "Should I use stock instead?"
```

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

Sort by `lapses` descending. For each high-lapse card, work through this:

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

## Sources

- Piotr Wozniak, *Effective learning: twenty rules of formulating knowledge* (1999)
  and the minimum information principle.
- Andy Matuschak, *How to write good prompts: using spaced repetition to create
  understanding* (2020) — source of the five properties, the litmus tests, and the
  knowledge-type patterns above.
- Michael Nielsen, *Augmenting Long-term Memory* (2018).
