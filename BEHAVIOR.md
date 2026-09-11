# SyntaxStitch Behavior Catalog

This document records the user intent behind each reconciliation decision. It is a review surface for deciding whether a default still matches what a user most likely meant. The automated tests encode these decisions; changing a decision should update this document and its corresponding test together.

## Feedback

| Event | Current behavior | Why |
| --- | --- | --- |
| A repair increases the count | Update the status count, show the latest repair in its hover, and flash its color with a spinning sync icon for 500 ms. | A repair should be visibly attributed to SyntaxStitch without interrupting typing or opening a notification. |
| A repeated repair is suppressed by the count cooldown | Apply the repair without changing the latest-repair summary or flashing. | Repeated attempts at one boundary are one incident, so repeated visual feedback would be noisy. |
| The user opens the status hover | Show aggregate counts and the latest action, token, owning language, and line. | This gives enough context to evaluate the decision without logging source contents. |
| The user clicks the status item | Open the existing action menu, including the global enable/disable action. | Global control remains easy to discover while detailed rule controls are still being designed. |

## Structural Decisions

| Scenario | Default | Reason | Exceptions |
| --- | --- | --- | --- |
| Delete one side of a meaningful `()`, `[]`, or `{}` pair | Restore the missing glyph. | The surviving boundary still owns meaningful code or text. | Standalone grouping parentheses can be deliberately unwrapped. |
| Directly Backspace/Delete a meaningful boundary | Restore it and select the exact complete pair. | The repair is visible; another Delete removes the selection, while an arrow collapses to either edge for content editing. | Empty pairs are removed instead. Multi-cursor and selected edits do not receive direct-caret behavior. |
| Delete one side of a whitespace-only pair | Remove the surviving boundary and whitespace. | Empty structures should be easy to delete as one unit. | A direct Backspace/Delete at a closing quote selects the quoted value before deletion; comments count as meaningful content. |
| Delete both boundaries in one edit | Keep the edit. | A coordinated complete-pair edit is explicit intent. | None. |
| Replace both boundaries with another pair type | Keep the replacement. | The resulting structure is already balanced. | None. |
| Delete standalone grouping parentheses around content | Remove the counterpart and keep the content. | Grouping parentheses are commonly removed deliberately. | Call parentheses remain protected because they express invocation. |
| Delete a closer when another unmatched closer can take its place | Rebind only if pair count and language ownership remain stable. | This permits cleanup of redundant closers without stealing one from an outer structure. | Cross-language rebinding is never allowed. |
| Delete a multiline closer programmatically | Restore it and compact one trailing line break. | Programmatic edits have no caret intent; gradual compaction preserves ownership while avoiding a stuck distant closer. | Direct keyboard deletion selects the complete pair instead. |

## Quote Decisions

| Scenario | Default | Reason | Exceptions |
| --- | --- | --- | --- |
| Delete one boundary of a meaningful string or non-tag pair | Restore it. | A one-sided edit would cause syntax ownership to spill into following code. | Deleting both boundaries together is allowed. Non-direct edits can remove empty quoted values as one unit. |
| Directly delete a closing quote | Select an empty quoted value before deletion, or restore and select a meaningful quoted value after deletion. | The next Delete removes the complete value, while Left or Right collapses to the corresponding boundary for editing. | None. |
| A normal quote has no closer before an unescaped newline | Leave it unpaired and deletable. | Ordinary strings cannot claim a quote from a later line; this prevents a stray `};"` from being protected. | Explicit multiline forms remain paired. |
| Python triple quotes or C# verbatim strings cross lines | Pair and protect them. | Their language syntax explicitly permits multiline content. | Language-specific raw-string forms not yet parsed are not inferred. |
| Braces or tags appear inside a string | Do not index them as structure. | String contents belong to the quote pair. | Template interpolation explicitly re-enters code. |

## Tag Decisions

| Scenario | Default | Reason | Exceptions |
| --- | --- | --- | --- |
| Delete part of an opening or closing tag | Restore the complete token in place. | Replacing the surviving fragment avoids duplicating a tag. | Deleting one complete tag unwraps the element. |
| Delete one complete opening or closing tag | Remove its counterpart and preserve meaningful contents. | Selecting a whole token is explicit unwrap intent. | Empty paired tags are removed with their whitespace. |
| Rename a tag name | Synchronize its indexed counterpart. | Ordinary rename editing should not create a mismatch. | A temporarily empty name waits for the next typed replacement. |
| A provider inserts adjacent opening and closing tags and leaves the caret after both | Move the caret between them. | The likely next intent is typing element contents. | The correction expires after 500 ms and requires the exact document version. |

## Indentation Decisions

| Scenario | Default | Reason | Exceptions |
| --- | --- | --- | --- |
| A changed line-leading `}` has different indentation from its opener | Align it with the opening line. | The indexed owner supplies a local, deterministic indentation reference. | Disabled by `syntaxstitch.fixClosingIndentation`; non-leading closers are ignored. |
| A Python indentation boundary is orphaned | Repair the indent or dedent boundary. | Python block ownership is structural even without glyphs. | There is no full-glyph selection because a dedent has no concrete ending token. |

## Language Ownership

Pairs record the language that parsed them. HTML documents switch to JavaScript inside `<script>` and CSS inside `<style>`. JavaScript templates and JSX/TSX can switch back to HTML for markup. A resulting boundary can replace an old boundary only within the same language owner.

The unit matrix covers every language enabled by default, each bracket family, ordinary and multiline quote behavior, markup attributes, and nested HTML/JavaScript/CSS/TSX/Vue examples. Editor-host tests cover direct deletion, exact selection, tags, folding, navigation, counters, and provider caret correction.

## Existing Controls

- `syntaxstitch.enabled` disables all reconciliation.
- `syntaxstitch.structures` enables or disables `brace`, `tag`, `quote`, and `indent` families.
- `syntaxstitch.languages` limits top-level document languages.
- `syntaxstitch.fixClosingIndentation` controls only closing-brace alignment.

## Future Rule Policies - Not Implemented

Per-case disabling is intentionally not implemented yet. Independent booleans for every scenario would grow into a difficult settings matrix. Arbitrary JavaScript predicates would be expressive, but unsafe in settings, hard to explain in the UI, and difficult to migrate.

A future declarative rule should match a typed repair context:

```ts
type RepairContext = {
    documentLanguage: string;
    ownerLanguage: string;
    structure: "brace" | "tag" | "quote" | "indent";
    glyph: string;
    side: "open" | "close";
    case: "restore" | "remove-empty" | "unwrap" | "rebind" | "compact" | "align";
    directKeyboardEdit: boolean;
    nestedLanguage: boolean;
    contentLength: number;
    contentHasNewline: boolean;
};
```

Rules could then be ordered from most specific to least specific:

1. Exact case + glyph + owner language + document language.
2. Case + structure + owner language.
3. Structure + document language.
4. Structure across all languages.
5. Global default.

The first matching rule would return `allow`, `disable`, or `inherit`. A repair hover could offer shortcuts such as "Disable this exact case", "Disable quote restoration in TypeScript", or "Disable all quote repair", while opening the generated setting for review before saving it.

Before implementing this, collect real repair contexts without source contents, review which distinctions users actually need, define precedence and migration behavior, and add conflict-resolution tests. Content predicates such as length or newline presence should be declarative fields, not executable callbacks.
