---
title: Prompt patterns by knowledge type
summary: Patterns for factual, procedural and conceptual targets, closed and open lists, salience cards, and a checklist to diagnose cards that already exist.
---
# Prompt patterns by knowledge type

Read this when you choose how to turn a target into cards. A real source usually mixes the three types below. A single paragraph often holds factual, procedural and conceptual material, and each needs a different treatment.

## Contents

- [Factual knowledge](#factual-knowledge)
- [Lists: closed and open](#lists-closed-and-open)
- [Procedural knowledge](#procedural-knowledge)
- [Conceptual knowledge](#conceptual-knowledge)
- [Salience and behavior cards](#salience-and-behavior-cards)
- [Revision: diagnose cards that already exist](#revision-diagnose-cards-that-already-exist)

## Factual knowledge

A fact is raw information with few internal relations. It is the default and easiest case.

The pattern is one focused question and one short answer.

```
Front: What type of chicken parts go into stock?
Back:  Bones
```

Pair a fact with an explanation when the fact is arbitrary or the explanation is interesting. An explanation gives a fact meaning, so the user keeps it. It also gives the fact hooks for later learning.

```
Front: How do bones give a chicken stock its rich texture?
Back:  They're full of gelatin
```

Look at the phrasing. An earlier draft asked "Why do we use bones?". That question invites "because they're cheap", a correct answer that misses the target. A precise question gives a consistent answer.

Interpretation is part of the job. A source often phrases a fact in a form that the user should not memorize word for word. A recipe that lists "2 lbs bones, 2 qt water" teaches a ratio. Card the ratio, not the batch size.

## Lists: closed and open

The members of a closed list never change. Treat it as a single complex fact. Card it with cloze cards that each blank one element. Keep the element order the same on every card, so the shape of the list helps memory.

```
Front: Typical chicken stock aromatics: {{onion}}, carrots, celery, garlic, parsley
```

An open list grows without end. Examples are the members of a category, the uses of a technique, or the jobs a tool does well. Cloze fails here, because anything can fill the blank. Use these three prompt types instead.

1. An instance with its tag. "When I puree vegetables for soup, how can I add richness without fat?" has the answer "Thin with stock instead of water."
2. A prompt about the pattern itself, once several instances exist. "What should I ask myself when I notice I'm using water in savory cooking?"
3. A prompt from a loose tag to its instances, which asks for a couple of examples. This type works only beside the first type. Alone, it makes the user give the same two examples forever and forget the rest.

The user's expertise decides which kind a list is. A novice's closed list is often an open list for an expert.

## Procedural knowledge

Procedural knowledge is knowing how, not knowing what. A procedure looks like a list. But cards that treat it as a list ask unfocused questions full of incidental detail.

First, extract the keywords. Cut the procedure down to the words that carry the knowledge. In "slowly bring to a simmer, then hold a bare simmer for 90 minutes", four phrases carry everything: "slowly", "simmer", "bare simmer" and "90 minutes". The rest is structure.

Then turn each keyword into a question. Ask which verbs, adjectives and adverbs matter. Ask what conditions move the cook from one step to the next.

```
Front: At what speed should you heat a pot of ingredients for stock?
Back:  Slowly

Front: How long must chicken stock simmer?
Back:  90 minutes
```

Skip the obvious steps. If the first and last steps follow from what the thing is, they are not targets.

Capture branches. Conditions, special cases and other paths usually deserve their own cards, because people get these parts wrong. When the branches are complex, a flowchart image on the card beats prose.

Add warning cards. A detail such as "this takes about an hour to reach temperature" is not part of the procedure. It lets the user notice when something goes wrong.

Explanation cards matter most here. They mark the difference between following a procedure and understanding it. When the source gives only one level of "why", phrase the answer as the source's claim, not as an absolute fact.

## Conceptual knowledge

A concept is the hardest kind. Here a definition card gives a false sense of understanding. To recite "stock is a flavorful liquid building block" is not to know what stock is. The goal is a set of cards that together trace the edges of the concept.

Use five lenses. Not every lens fits every concept. Use them as a checklist to find the ones that fit.

- Attributes and tendencies: what makes it what it is? What is always, sometimes and never true of it?
- Similarities and differences: what does it relate to? What separates it from the concept that people most often confuse it with?
- Parts and wholes: its examples, its sub-concepts and the broader category that holds it.
- Causes and effects: what does it do, what causes that, and when do people use it?
- Significance and implications: why does it matter? This lens connects the concept to something that the user cares about.

Avoid binary prompts. A yes or no question, or a choice between two options, takes little effort and builds shallow understanding. The user can often answer it without understanding the question. Turn it into an open question, usually by connecting it to an example or an implication.

```
Weak:   Does chicken stock make vegetable dishes taste like chicken?  No
Better: How does chicken stock affect the flavor of vegetable dishes? It makes them taste more "complete"
```

## Salience and behavior cards

A card can serve a purpose other than recall. It can keep an idea present until the idea attaches to something real. A new idea is vivid at first and then fades. A card can extend that window on purpose.

```
Front: What should I ask myself when I notice I'm using water in savory cooking?
Back:  "Should I use stock instead?"
```

Phrase these cards around situations in the user's life, not around the abstract idea. A user who can answer a factual question about an idea may still not think of it when it is useful. These cards target that gap.

Creative prompts belong to the same family. A prompt such as "name an example you haven't given before" breaks the consistency property on purpose. It trains the process that produces an answer, not one particular answer, and it gains from the generation effect. Creative prompts are legitimate but less well understood. Use them rarely. Never use them in place of the recall cards that support them.

## Revision: diagnose cards that already exist

A card's problems often show only after you write it. A wording fault may appear only when the interval reaches several months. So revision is a normal part of the practice, not a sign of a mistake.

Sort the cards by `lapses`, highest first. Ask these questions about each card with many lapses.

1. Does it bundle facts? If the answer needs two things that the user can forget separately, split the card.
2. Does it accept other correct answers? If a reasonable person can answer differently and be right, aim the question at the specific construct. You can also add real context, but do not add a hint that only rules out the other answers.
3. Can the user answer it by its shape? Long or distinctive wording makes the user memorize the question instead of the knowledge. Shorten the question and make it more general.
4. Does the answer hold characters that carry no knowledge? Trailing punctuation, arbitrary letter case and optional spaces are examples. Trim the answer to its canonical form.
5. Is the foundation missing? Some cards fail because nobody carded the material under them. Add the prerequisite cards. The hard card often recovers by itself.
6. Does the user still care about it? If not, delete it. Reviewing material that nobody wants kills a practice.

The strongest single signal is the user's own reaction. If the user sighs at a card during review, the card needs revision, whatever the statistics say.

## Sources

- Piotr Wozniak, "Effective learning: twenty rules of formulating knowledge" (1999), and the minimum information principle.
- Andy Matuschak, "How to write good prompts: using spaced repetition to create understanding" (2020). It is the source of the five properties, the two tests and the knowledge type patterns above.
- Michael Nielsen, "Augmenting Long-term Memory" (2018).
