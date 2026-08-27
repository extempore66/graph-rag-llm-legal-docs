# Candidate CLAUDE.md directives

Staging file. Nothing here is active — a directive only takes effect once it is
moved into a real `CLAUDE.md` (project root, or `~/.claude/CLAUDE.md` for all
projects). Kept separate so the decision to adopt one stays deliberate.

---

## Directive: plain language in anything a reader sees cold

**Status:** candidate · recorded 2026-08-27

### The rule, in directive form

> Write for a reader seeing this for the first time, with no context and no
> chance to ask a question.
>
> Keep the register professional and business-like. Do **not** dumb down the
> substance, the numbers, or the argument — simplify the *phrasing*.
>
> Specifically:
> - Prefer the ordinary word to the field-specific one when both are exact.
>   "35 questions in 5 categories", not "35 questions across 5 strata".
> - Spell out any term of art on first use, or replace it.
> - One idea per sentence. Break the sentence that carries two.
> - Cut nuance that only a second reading would recover. If a phrase needs
>   re-reading to parse, it fails — move the nuance to presenter notes,
>   an appendix, or spoken delivery.
> - Density of *language* is the target, not density of *content*. Do not
>   solve it by deleting material.
>
> Applies to: slides, README files, executive summaries, release notes, UI
> copy, and anything else read cold by someone who was not in the room.
> Does not apply to: code comments, internal technical reference docs, or
> conversation with the user.

### The original request, verbatim

Recorded as written, on the interview deck for ArangoDB:

> Ok I will stop here, I think I reached a good plateau for your brilliance and
> usefulness. I wil review this through the eyes of a person who sees this for
> the first time. Your language and the overall look and feel and phrasing of
> the entire deck is still too dense and full of nuanced language a human cannot
> readily wrap their brain around when seeing this for the first time. Do not do
> anything on your own If you are up for a challenge to simplify this further,
> not the amount but as phrasing, let me know. The language in principle should
> stay professional and business like but for instance you talk about the 35
> questions in 5 "strata" instead of saying things like 35 questions divided in
> 5 categories or even taxonomies. See if you can simplify the language along
> these lines but do not write anything in slides, plan and propose something
> here first.

### Why it was needed

The deck was written by someone (me) who had every one of its facts already in
working memory. Phrases like "strata", "reserved slots are a scar", "the
credibility purchase" and "a bi-encoder inherits stage one's recall" are
*compressions* — each one is accurate, and each one costs a first-time reader a
pause to unpack. Four or five pauses per slide is what "too dense" means. The
fix is not less content; it is spending more words on the same content.
