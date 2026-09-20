# SyntaxStitch Behavior Catalog

This document records the user intent behind each reconciliation decision. It is a review surface for deciding whether a default still matches what a user most likely meant. The automated tests encode these decisions; changing a decision should update this document and its corresponding test together.

## Feedback

| Event | Current behavior | Why |
| --- | --- | --- |
| A repair increases the count | Update the status count, show the latest repair in its hover, and flash its color with a spinning sync icon for 500 ms. | A repair should be visibly attributed to SyntaxStitch without interrupting typing or opening a notification. |
| A repeated repair is suppressed by the count cooldown | Apply the repair without changing the latest-repair summary or flashing. | Repeated attempts at one boundary are one incident, so repeated visual feedback would be noisy. |
| The user opens the status hover | Show aggregate counts and the latest action, token, owning language, and line. | This gives enough context to evaluate the decision without logging source contents. |
| The user clicks the status item | Open the existing action menu, including the global enable/disable action. | Global control remains easy to discover while detailed rule controls are still being designed. |
| A repair is triggered by recognized direct Backspace/Delete while the document is open, visible, and the window is focused | Count it as `direct`. | These combined signals are the strongest available evidence of an active user edit. | If any signal is false, count it as `indirect`. |
| A repair is triggered by any other document change | Count it as `indirect`. | VS Code does not expose whether the source was Copilot, paste, another extension, or a workspace edit. | It must not be labeled specifically as Copilot. |
| A repair is recorded | Include whether the document is open, visible in an editor, and whether the VS Code window is focused in the reconciliation log. | These signals help investigate background edits without pretending they identify the edit source. | They do not change the `user` versus `external/unknown` classification. |

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
| Insert a mismatched closing `)`, `]`, or `}` in a clear changed span | Remove only that newly introduced closer. | A directly introduced orphan should not damage surrounding ownership. | Balanced or ambiguous edits remain untouched. |
| Delete the opening brace of a malformed document-level wrapper | Remove the matching outer closer and preserve the inner text. | Accidental wrappers should be easy to unwrap. | A valid wrapper keeps normal boundary restoration and selection behavior. |
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
| Delete an exactly selected complete paired element | Remove both tags and preserve the content between them. | The selection identifies an explicit unwrap request after a repaired boundary. | Partial or ambiguous selections are ordinary edits. |
| Rename a tag name | Synchronize its indexed counterpart. | Ordinary rename editing should not create a mismatch. | A temporarily empty name waits for the next typed replacement. |
| A provider inserts adjacent opening and closing tags and leaves the caret after both | Move the caret between them. | The likely next intent is typing element contents. | The correction expires after 500 ms and requires the exact document version. |
| Rename a tag through direct replacement or delete-then-type editing | Update both the opening and closing tag names. | The pair remains structurally synchronized while attributes and contents stay intact. | A temporarily empty name waits for the next replacement. |

## Indentation Decisions

| Scenario | Default | Reason | Exceptions |
| --- | --- | --- | --- |
| A changed line-leading `}` has different indentation from its opener | Align it with the opening line. | The indexed owner supplies a local, deterministic indentation reference. | Disabled by `syntaxstitch.fixClosingIndentation`; non-leading closers are ignored. |
| A Python indentation boundary is orphaned | Repair the indent or dedent boundary. | Python block ownership is structural even without glyphs. | There is no full-glyph selection because a dedent has no concrete ending token. |

## Language Ownership

Pairs record the language that parsed them. HTML documents switch to JavaScript inside `<script>` and CSS inside `<style>`. JavaScript templates and JSX/TSX can switch back to HTML for markup. A resulting boundary can replace an old boundary only within the same language owner.

The unit matrix covers every language enabled by default, each bracket family, ordinary and multiline quote behavior, markup attributes, and nested HTML/JavaScript/CSS/TSX/Vue examples. Editor-host tests cover direct deletion, exact selection, tags, folding, navigation, counters, and provider caret correction.

The scanner also treats JavaScript and TypeScript regular-expression literals as opaque, tracks nested template expressions, and recognizes JSX/TSX fragments (`<>...</>`) as HTML-owned tag pairs. These helpers are language-scoped through `syntaxstitch.languages` rather than separate per-helper switches.

## Selection Decisions

| Scenario | Default | Reason | Exceptions |
| --- | --- | --- | --- |
| Extend a forward selection one character over a matched closing brace | Include its immediately adjacent opener while preserving the native selection extension. | Selecting a complete pair is usually more useful than leaving a balanced selection asymmetrical. | Reversed, multi-cursor, non-adjacent, tag, quote, and ambiguous selections are unchanged. |
| Extend an already exact balanced brace selection over its enclosing closer | Expand to the enclosing brace pair. | This supports repeated `Shift+Right` expansion through nested expressions without a new command. | The previous selection must be an exact indexed pair. |

## Nested Select Decisions

Nested Select is an interactive navigation and editing mode, entered with **SyntaxStitch: Enter Nested Select**. The separate structural selection commands expand or contract a normal selection. See the [README guide](README.md#nested-select) for setup, keybindings, and a button-editing example. These behaviors are part of the current release.

| Scenario | Current behavior |
| --- | --- |
| Enter with one highlighted region containing complete bracket or tag pairs | Build a navigable root set from the outermost indexed pairs inside that region. |
| Press Right or Left while navigating structures | Enter the focused child structure or return to its parent structure. |
| Press Up or Down while navigating structures | Cycle matching peers at the current nesting depth, deriving equivalent nested peers when needed. |
| Tab through the focus | Enter local content and property/value components. Attributes are visited before nested markup when both are present. |
| Shift+Tab at a nested property boundary | Return to the parent component path at its final component. |
| Press Up or Down while navigating components | Cycle matching properties by key; cycle values only when both their key and value match. Missing properties are skipped and the eligible set wraps. |
| Shift+Arrow on an HTML attribute | Select its complete `key="value"` clause; repeat to add adjacent matching clauses across peer elements, including discontiguous ranges. |
| Type into a focused selection, then press Enter | Finish typing and wait for mirrored edits before resuming navigation. |
| Return to a saved parent after editing | Restore its selection set and focus with rebased offsets. |
| Edit a markup attribute value | Match the attribute key on other elements with the same tag name within the chosen mirroring scope, independently of attribute order. Original selection is the default; enclosing structure and entire document are opt-in scopes. Missing keys are skipped. Quoted values containing whitespace use the same rules for typing and paste; destination quotes are escaped and unquoted peers are quoted when necessary. |
| Edit an attribute name | Capture the original key and match that key on elements with the same tag name, regardless of attribute order. After applying a rename, subsequent keystrokes follow the new key. Skip peers that already have the new name. |
| Finish an HTML ID value edit | Number participating IDs within the chosen scope in document order, skipping values already reserved by untouched elements anywhere in the document. Decode HTML entities when comparing IDs, including IDs on void elements. Empty or whitespace-containing bases are not numbered. Only an edited `id` key triggers this step; other keys cannot overwrite IDs. |
| Toggle a highlight or remove a selection entry | Change the navigation set or its presentation without deleting source text. Toggled-off elements are excluded from attribute propagation and unique-ID renumbering. |
| Press Escape while typing | Return to navigation; another Escape exits. Existing edits remain. |
| Close the last tab for a document | Cancel queued attribute edits and prevent automatic repairs without an open editor tab. Explicit user commands can still open a document. |
| Revert or reload clean saved content | Reindex without repairing or making the buffer dirty again; clear stale selection state and pending edits. |

Pending mirrors apply automatically after a 100 ms pause, or immediately when finishing typing. Targets, source text, document version and selection session are captured before navigation can change the focus. Undo/redo, conflicting edits, replacement sessions, pause, scope changes and closed documents invalidate stale work. Every document has one pending transaction, including when opened in multiple panes. Native typing and mirrored edits join the open undo group; scripted callers may introduce their own undo stops.

Editor-host regressions cover mirrored edits from a middle element, attribute-key isolation with reordered attributes, parent restoration, disk reverts, closed documents, and closing a tab with propagation queued.

## Existing Controls

- **Pause / Resume This File** suspends automatic changes for this document until resumed or the document closes. Resume reindexes the current text.
- **Skip Next Edit / Cancel Skip** bypasses the next nonempty external text-change event in the active document, including multi-cursor batches, whether or not repair would have been needed. Invoking it again cancels the pending skip. Internal repair changes do not consume it.
- Pause and skip cancel pending mirrored edits and clear Nested Select. They do not undo edits already applied.
- `syntaxstitch.mirroringScope` defaults to `selection`; `enclosing` captures the nearest strict container on entry (or falls back to selection), and `document` permits whole-document matching. The session picker changes scope without changing settings. Bounds follow edits independently of navigation. Attribute mirroring and ID numbering use the same bounds; inner-text mirroring additionally requires eligible navigation peers.
- Nested Select previews the target ranges and count, with contextual navigation or typing hints in its status hover.
- Undo and redo are authoritative, like disk reloads: cancel queued propagation, clear selection state, and reindex without fresh automatic edits.
- Recent Repairs retains the last 100 applied repair records in session memory, including cooldown-suppressed repeats, with a rule explanation and the recorded location. No source snippets are retained; later edits may move recorded locations.

- `syntaxstitch.enabled` disables all reconciliation.
- `syntaxstitch.structures` enables or disables `square`, `parenthesis`, `curly`, `tag`, `quote`, and `indent` families. The legacy `brace` value remains supported as an umbrella for all three bracket kinds.
- `syntaxstitch.languages` limits top-level document languages.
- `syntaxstitch.fixClosingIndentation` controls only closing-brace alignment.
- `syntaxstitch.languages` scopes all language-sensitive repair and scanning helpers, including tag synchronization, regex literals, template expressions, JSX/TSX fragments, and Python indentation.

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

- Saving flushes queued mirrored edits and exits the document’s Nested Select sessions before later save participants run. Pending progress counts peer replacements; cancelled transactions report a brief status message.
