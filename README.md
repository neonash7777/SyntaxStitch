# SyntaxStitch

<p align="center"><img src="media/icon.png" width="128" height="128" alt="SyntaxStitch logo: a neon stitched S between colorful code braces"></p>

**Keep your code together—and move through it with ease. SyntaxStitch repairs AI-induced syntax breakage, reduces token churn from failed edits, and adds Nested Select for structured keyboard navigation and edits.**

Cross-platform: works in VS Code on Windows, macOS, and Linux.

SyntaxStitch watches structural edits and repairs orphaned brackets, quotes, tags, and Python indentation before one missing boundary turns the rest of the file into syntax-error confetti. It works with AI edits, paste replacements, multi-cursor changes, and ordinary typing—helping you recover faster and avoid the extra prompt cycles and token burn caused by broken code.

With **[Nested Select](#nested-select)**, highlight a region, step into its structures and properties, and edit matching HTML attribute values from the keyboard. Move up to the parent or across to the next element without rebuilding your selection. See the [full guide](#nested-select) below.

Behind the scenes, SyntaxStitch maintains a UUID-backed shadow index of paired boundaries. If an edit destroys one side, SyntaxStitch checks whether the surviving side now matches another boundary. It repairs only genuinely orphaned structures.

No cloud service. No source upload. No setup required.

## Supported Structures

| Structure | Examples | Behavior |
| --- | --- | --- |
| Brackets | `()`, `[]`, `{}` | Restores one deleted side when its indexed partner would otherwise be orphaned. Deletes the whole pair when its interior is only whitespace, unwraps a malformed document-level wrapper, and removes newly introduced mismatched closers when their edit location is clear. |
| Quotes | `'...'`, `"..."`, `` `...` ``, `'''...'''`, `"""..."""` | Restores one deleted quote without treating quoted braces or tags as structure. Includes HTML attribute quotes and JavaScript template literals. |
| Markup tags | `<section>...</section>`, `<>...</>` | Synchronizes both tag names, restores a damaged boundary and selects the full element, removes the counterpart when one complete tag is deleted exactly, or unwraps an exactly selected element while preserving its content. |
| Python indentation | Indent and dedent boundaries | Tracks block boundaries and repairs an orphaned side. |
| Closing-brace indentation | Line-leading `}` | Realigns a changed closer with its matched opening brace. |

SyntaxStitch is enabled by default for JavaScript, TypeScript, JSON, HTML, XML, Vue, Svelte, Astro, CSS, SCSS, Less, Python, C#, Java, Go, and Rust. Language coverage can be changed with `syntaxstitch.languages`.

## Features

- [Nested Select](#nested-select) for navigating structures, their contents, and editable properties with the keyboard; includes matching HTML attribute-value edits.
- UUID-backed, language-scoped structural pairs for braces, quotes, tags, and Python indentation boundaries.
- Embedded-language transitions for JavaScript in `<script>`, CSS in `<style>`, and HTML inside JavaScript template literals and JSX/TSX.
- Descending batch analysis so lower-file changes do not invalidate earlier offsets.
- Exact token restoration for one-sided brace and tag deletion.
- Guarded repair edits that cannot recursively trigger more repairs.
- JSON Lines records in the **SyntaxStitch** output channel for agent/tool synchronization.
- Persistent workspace repair statistics split across `()`, `[]`, `{}`, `<>`, `""`, and `\t` structures.
- Repair summaries show the net total, totals by repair kind, and direct/indirect counts within each kind. `direct` requires a direct Backspace/Delete while the document is open, visible, and focused; `indirect` includes Copilot, paste, other extensions, workspace edits, and any edit missing one of those context signals.
- Reconciliation logs include a stable `rule` identifier, such as `restore-partial-tag`, `restore-closer`, `remove-empty-pair`, or `align-closing-indent`, alongside the repair kind.
- Compact, accessible `{S} total` status-bar control; hover for the per-structure breakdown or click for actions.
- An inline `owner L12↔L28 17 Lines` label after each closing boundary, where `owner` is the declaration or opening tag. Modifier-click the owner to select its defining statement and block, `↔` to select the content between delimiters, either line number to select that line, or the line count to select the complete range. Hover the owner for folding and structural selection actions. **Fold / unfold contents** folds every collapsible child; when all children are folded, it unfolds only the direct children.
- Localized closing-brace indentation repair based on the matched opening brace.
- Context-aware Structural Tab navigation through closing tags and across correctly indented line-leading `}` boundaries.
- Regex-aware scanning that ignores bracket-like characters inside JavaScript and TypeScript regular-expression literals.
- Nested template-literal tracking, including nested `${...}` expressions and markup inside templates.
- Forward selection balancing: when `Shift+Right` reaches a matched closing brace, the adjacent or enclosing opener is included without replacing the editor's native selection command.

## Why SyntaxStitch?

A single missing `)`, `]`, `}`, closing tag, or dedent can break syntax highlighting and force the next AI edit to work from malformed code. SyntaxStitch keeps the buffer structurally coherent while preserving deliberate changes, including edits that remove redundant boundaries.

It is a guardrail, not a formatter or compiler replacement. Your existing language server remains the authority for language semantics.

### Edit Intent

SyntaxStitch distinguishes an accidental one-sided edit from a deliberate structural edit. It uses the indexed pair, the resulting document, the edit shape, and direct keyboard intent rather than blindly replacing every missing token.

See [BEHAVIOR.md](BEHAVIOR.md) for the complete decision catalog, exceptions, test coverage, and the not-yet-implemented design for rule-specific controls.

| Edit | Response | Why |
| --- | --- | --- |
| Delete one side of a whitespace-only `()`, `[]`, `{}`, quote, or paired tag | Remove the surviving boundary and interior whitespace. | An empty pair behaves as one unit, so restoring half of it would interfere with ordinary cleanup. |
| Delete exactly one complete opening or closing tag | Remove its indexed counterpart and preserve the element contents. | Selecting the whole tag is explicit intent to unwrap the element. |
| Delete an exactly selected complete element after a boundary repair | Remove both tags and preserve the content between them. | The repaired selection identifies an explicit unwrap request. | Partial or ambiguous selections are left as ordinary edits. |
| Delete either boundary of standalone grouping parentheses such as `(cat)` | Remove its indexed counterpart and preserve `cat`. | A same-line grouping edit is explicit intent to unwrap the expression; call arguments remain protected. |
| Replace an opening or closing tag name, including delete-then-type editing | Apply the same name to its indexed counterpart. | Ordinary `<section>` to `<div>` editing should remain fluid without creating a mismatched closing tag. |
| Delete one side of a brace, call parenthesis, bracket, or quote containing code, comments, or text | Restore the missing boundary. | Meaningful content still needs its structural owner. Comments count as meaningful content. |
| Backspace/Delete a meaningful boundary directly | Restore it and select the complete pair, such as `{ ... }`, `(x, y)`, or `<p>...</p>`. | Selecting the restored structure makes the repair visible and gives the next edit an explicit target. |
| Delete part of a multi-character boundary such as the `>` in `</p>` | Replace the surviving `</p` fragment with exactly one complete `</p>`. | Replacing the damaged token in place avoids duplicating a full tag behind its surviving fragment. |
| An HTML provider inserts adjacent `<p></p>` and leaves the cursor after `</p>` | Move the cursor between `<p>` and `</p>`. | The provider generates the tags; SyntaxStitch only corrects the temporary caret position so typing can continue inside the element. |
| Press Tab immediately before an indexed closing tag | Jump to the next closing tag, such as from `</h1>` to `</p>`. | Closing tags form a useful outward path through nested markup. |
| Press Tab immediately before a correctly indented line-leading `}` | Jump just past the `}`. | The block is already aligned, so adding more indentation is less useful than crossing its structural boundary. A misindented `}` keeps normal Tab behavior. |
| Backspace/Delete a meaningful closing boundary, including one among adjacent closers such as `add(x))` | Restore it and select its complete pair. | The next Delete removes the selected structure, while an arrow key collapses the selection to either boundary for editing its contents. |
| Repeatedly delete nested empty pairs | Remove one layer per attempt and leave the caret at the next boundary. | Removing one layer at a time keeps the behavior predictable without collapsing unrelated nesting. |
| Select and remove both boundaries together | Allow the edit. | A complete-pair edit is explicit intent to remove or unwrap that structure. |
| Paste, AI, or multi-cursor edit both boundaries together | Allow the coordinated edit. | Changing both boundaries in one operation signals deliberate intent, so SyntaxStitch preserves the edit as a whole. |
| Replace a boundary with an equivalent token or tag | Keep the replacement without adding another boundary. | The resulting structure is already balanced. |
| Type or paste a mismatched closing `)`, `]`, or `}` into a clear edit span | Remove only the newly introduced mismatched closer. | The edit is unambiguous and the user's surrounding text remains untouched. | Already balanced or ambiguous edits are left as entered. |
| Delete the opening brace of a malformed document-level wrapper | Remove its matching outer closer and preserve the wrapped content. | This makes it easy to unwrap an accidental wrapper. | A valid wrapper restores the deleted opener and selects the complete pair. |
| Remove a closer when an unused later closer can complete the pair | Reassign the later closer only when the number of pairs in scope stays the same. | This repairs malformed code without taking a closer from an enclosing pair. |
| Programmatically delete a protected multiline closer | Restore it while removing one trailing line break per attempt. | Programmatic edits provide no caret intent; gradual compaction preserves the structure while moving the closer toward its content. |

Direct selection and caret movement apply only to Backspace/Delete operations with one caret and no selection. Selections, multi-cursor edits, paste operations, and AI or workspace edits are handled as complete changes.

SyntaxStitch does not auto-close newly typed HTML tags. VS Code's HTML service, Emmet, or another language provider may create the closing tag. When a provider inserts an adjacent empty pair and leaves the cursor after the closing tag, SyntaxStitch moves the cursor inside. The pending correction applies only to the current document version and expires after 500 ms.

### Language Ownership

Every shadow pair records its active language. HTML tags use HTML rules, `<script>` bodies use JavaScript, `<style>` bodies use CSS, and markup in JavaScript templates or JSX/TSX switches back to HTML rules. Quotes and comments prevent brace-like text from being treated as structure. SyntaxStitch also checks language ownership when matching boundaries after an edit, so a JavaScript closer cannot adopt an HTML or CSS boundary.

### Structural Selection

**Select Matching Structure** selects the pair at either boundary and expands through enclosing pairs. **Select Inner Structure** retraces previous selections exactly. Without selection history, it contracts toward the active edge. The history resolves ambiguity in blocks with multiple siblings, where position alone cannot identify the previously selected child.

When a single empty cursor is immediately before a closing tag, Tab moves to the next closing tag in document order. Before a line-leading `}`, it jumps past the boundary only when the closing line's indentation exactly matches the indexed opening line. Otherwise, Tab retains its normal indentation behavior.

SyntaxStitch yields Tab to VS Code while a snippet, suggestion, inline suggestion, read-only editor, or Tab-moves-focus mode is active. Outside a recognized structural boundary, the command delegates directly to VS Code's normal Tab command.

When a normal forward selection is extended one character at a time with `Shift+Right`, SyntaxStitch preserves the native extension and may move the selection start left to include a matching opener. This applies when the added character is a matched closing brace immediately following the selected content, and it can continue outward when the previous selection was already an exact balanced brace pair. It does not change reversed selections or ambiguous text selections.

## Nested Select

Nested Select turns a highlighted region into a set of structural selections you can explore and edit from the keyboard. Use **SyntaxStitch: Enter Nested Select** to start this interactive mode. The separate **Select Matching Structure** and **Select Inner Structure** commands expand or contract a normal editor selection.

### Start with a selection

1. Highlight a region containing complete paired structures, such as several HTML elements or a function body with its braces. Start with one nonempty selection.
2. Run **SyntaxStitch: Enter Nested Select**, or press `Ctrl+Alt+S` (`Cmd+Option+S`, `Cmd+Option+Enter`, or `Cmd+Option+Right` on macOS).
3. Use the highlighted focus to choose a structure, move into its contents, and select a property or value to edit. If the region contains no complete indexed bracket or tag pair, the mode does not start.

Navigation has three stages: **structure** selects complete pairs or elements; **inner** selects their contents; **components** exposes HTML attribute names and values or CSS declaration names, values, and individual value parts. Nested markup begins at the outer selected siblings and descends one structural level at a time.

### Navigation quick reference

These controls apply while navigating. Typing into a focused selection switches to editing that selection.

| To… | Press |
| --- | --- |
| Cycle matching structures or matching component peers | `Up` / `Down` |
| Enter the focused child structure | `Right` |
| Return to the parent structure | `Left` |
| Advance through contents and local property/value components | `Tab` |
| Reverse the local component path; at a nested property boundary, return to the parent component path | `Shift+Tab` |
| Finish typing and resume navigation | `Enter` |
| Leave typing mode, then exit Nested Select | `Escape`, then `Escape` again if needed |

`Up` and `Down` remain on the current structural or component axis: they wrap among matching peers and skip peers that do not have the matching property. `Right` and `Left` traverse the structural tree. While navigating, `Enter` drills into the focus; while typing, it finishes the edit. Exiting does not undo edits.

Additional selection controls:

| To… | Press |
| --- | --- |
| Focus the first / last selection | `Home` / `End` |
| Toggle the focused highlight | `Space` |
| Expand an attribute name or value to its full clause | `Shift+Left` / `Shift+Right` |
| Add the previous / next matching attribute clause to the current selection | `Shift+Left` / `Shift+Right` again |
| Remove the focused selection entry without deleting source text | `Delete` |

Attribute-clause expansion selects the complete source text, such as `class="primary"`. Further expansion includes matching clauses from peer elements even when their ranges are discontiguous; peers missing that attribute are skipped. Returning to a saved parent level restores its selection set and focus, including positions adjusted by edits.

### Example: edit button classes

```html
<button class="btn" id="one" aria-label="Say Hello">Hello</button>
<button class="btn" id="two" aria-label="Increment Counter">Increment</button>
<button class="btn" id="three" aria-label="Reset Counter">Reset</button>
```

1. Highlight all three elements and enter the mode.
2. Press `Down` to focus the middle button, then `Right` to enter its body.
3. Press `Tab` to reach the attribute components, then `Tab` again to move from the `class` name to its value, `btn`.
4. Type `primary`, then press `Enter` to finish. The buttons' class values become `primary`; their IDs and labels stay unchanged.
5. Press `Left` to return to the element level, then `Up` or `Down` to choose another element. Press `Escape` to exit.

### Matching attribute edits

For markup edits, matching uses the **attribute key and tag name**: a button's `class` value updates other buttons' `class` values, even if their attributes are ordered differently. In Nested Select peer navigation, a selected property name cycles by key, while a selected value cycles only among peers with the same key and value. Editing `aria-label`, `title`, or `data-*` values must not overwrite an `id` or a different attribute key. An element without the matching key is skipped.

Matching currently considers elements with the same tag name throughout the document, including those outside the initial highlighted region. It does not require their previous attribute values to match. Property-name edits use the corresponding attribute position instead; this is distinct from matching values by key. Automatic value propagation currently skips changes containing whitespace, so use a single-token value such as `primary` for this workflow.

When finishing an HTML `id` value edit with `Enter`, participating IDs receive numbered suffixes in document order, such as `test_1`, `test_2`, and `test_3`. This finalization applies only to the `id` key. Other attribute values are not numbered. This is not a document-wide ID uniqueness validator.

Automatic repairs require an open editor tab. Closing the tab cancels queued attribute edits, and reverting or reloading saved content does not trigger repairs that make the file dirty again.

## Installation

Install **SyntaxStitch** from the VS Code Marketplace, or download the `.vsix` attached to a [GitHub Release](https://github.com/neonash7777/SyntaxStitch/releases) and run **Extensions: Install from VSIX...**.

SyntaxStitch is cross-platform and works in VS Code on Windows, macOS, and Linux. It requires VS Code 1.127.0 or later.

## Support SyntaxStitch

If SyntaxStitch saves you time, you can support its development:

[![Support with Venmo](https://img.shields.io/badge/Venmo-@neonash7777-008CFF?style=for-the-badge&logo=venmo&logoColor=white)](https://venmo.com/u/neonash7777)
[![Support with Cash App](https://img.shields.io/badge/Cash_App-$neonash7777-00D64F?style=for-the-badge&logo=cashapp&logoColor=white)](https://cash.app/$neonash7777)

## Commands

- **SyntaxStitch: Enter Nested Select** starts [Nested Select](#nested-select) from the highlighted region. Use `Ctrl+Alt+S`; on macOS use `Cmd+Option+S`, `Cmd+Option+Enter`, or `Cmd+Option+Right`. **SyntaxStitch: Exit Nested Select** leaves the mode; while typing, it first returns to navigation.
- **SyntaxStitch: Open Settings** opens the VS Code Settings view filtered to SyntaxStitch.
- **SyntaxStitch: Select Matching Structure** selects the complete pair at the cursor, including both boundaries and its content. Run it again to expand outward. Use the Command Palette or configure a shortcut in **Preferences: Open Keyboard Shortcuts**.
- **SyntaxStitch: Select Inner Structure** retraces selections made with **Select Matching Structure**, restoring the exact previous selection. Without selection history, it contracts to the nearest nested pair and follows the active edge when siblings exist. Run it from the Command Palette or assign a shortcut.
- **SyntaxStitch: Structural Tab** moves from one closing tag to the next or crosses a correctly indented line-leading `}`. Tab invokes it only when editor contexts such as snippets and suggestions do not own Tab.
- **SyntaxStitch: Toggle On/Off** changes the workspace setting, or the global setting when no workspace is open.
- **SyntaxStitch: Show Repair Statistics** displays total and per-structure repair counts.
- **SyntaxStitch: Reset Repair Count** clears the persisted count.
- **SyntaxStitch: Configure Pair Labels** chooses `off`, `active`, or `all`; `all` omits inline pairs and labels multiline line-leading closers only. Labels use VS Code inlay hints and follow the editor's inlay-hint visibility and maximum-length settings. Hover the owner for ordinary-click folding and selection actions. **Fold / unfold contents** folds every collapsible child, then unfolds only direct children when everything is folded. Direct inline controls require modifier-click because VS Code reserves a plain click for caret placement.
- **SyntaxStitch: Rebuild Shadow Index** reindexes the active document.
- **SyntaxStitch: Show Reconciliation Output** opens the structured repair log.

## Settings

- `syntaxstitch.enabled` enables automatic reconciliation.
- `syntaxstitch.pairLabels` displays virtual opening-declaration labels at matching closing braces and tags. It defaults to `all` for multiline boundaries.
- `syntaxstitch.fixClosingIndentation` aligns changed line-leading `}` tokens with their matched `{`. It defaults to `true`.
- `syntaxstitch.structures` selects repair families: `parenthesis` for `()`, `square` for `[]`, `curly` for `{}`, plus `quote`, `tag`, and `indent`. All are enabled by default. The legacy `brace` value remains supported as an umbrella for all three bracket families.
- `syntaxstitch.languages` is the main scope control for all language-sensitive helpers, including regex scanning, template and JSX/TSX ownership, tag synchronization, and Python indentation. Remove a language identifier to opt that language out, add one to include another VS Code language, or set it to `[]` to monitor every language.
- `syntaxstitch.maxFileSizeKB` skips large documents. The default is 2048 KB.
- `syntaxstitch.logLevel` controls structured output with `off`, `repairs`, or `verbose`.
- `syntaxstitch.flashStatus` controls the 500 ms status-bar flash after a counted repair. It defaults to `true`; set it to `false` to keep the status item quiet.
- `syntaxstitch.repairCountCooldownMs` prevents immediate retries on the same boundary from inflating statistics. It defaults to 5000 ms; use `0` to count every application.

## Development

```sh
npm run compile
npm run test:unit
npm run test:publish
```

Use the VS Code task labeled **test SyntaxStitch before publish** for the full pre-publish validation. It compiles the extension, runs the unit matrix, and executes the extension-host suite against the minimum supported VS Code version. During development, run only new unit scenarios by name, for example `TEST_PATTERN=quote npm run test:unit:focused`.

Open **Run and Debug** and use the green Run button with either persistent launch action:

- **Run SyntaxStitch Extension** opens this project in an Extension Development Host.
- **Run SyntaxStitch Automated Tests** runs the full pre-publish validation via `npm run test:publish`.

The development host remains open until you stop debugging. Automated tests run in a disposable host and close it when they finish.

For an AI-driven fault-injection walkthrough covering HTML, JavaScript, Python, and C#, see [manual-tests/AI_TEST_PROMPT.md](manual-tests/AI_TEST_PROMPT.md).

Release maintainers should follow [PUBLISHING.md](PUBLISHING.md).

## Versioning

SyntaxStitch follows [Semantic Versioning](https://semver.org/):

- Patch releases fix behavior without intentionally changing configuration or compatibility.
- Minor releases add backward-compatible capabilities or settings.
- Major releases may change existing behavior, settings, or compatibility requirements.

While the version is below `1.0.0`, minor releases may still refine behavior based on real-world editing workflows. See [CHANGELOG.md](CHANGELOG.md) for release details.

## Privacy

SyntaxStitch runs entirely inside the VS Code Extension Host. It does not transmit source code, telemetry, repair statistics, or configuration to an external service. Repair statistics stay in VS Code workspace storage, and structured reconciliation records stay in the local **SyntaxStitch** output channel.

## Limitations

The stable VS Code extension API does not expose a hook that can block or mutate edits before language services observe them, nor can an extension inject an actual system message into an upstream AI agent. SyntaxStitch therefore performs the earliest supported guarded repair from `workspace.onDidChangeTextDocument` and emits a machine-readable synchronization record to its output channel.

The same change event does not identify whether an edit came from AI, another extension, paste, or another programmatic source. SyntaxStitch recognizes edits routed through its own keyboard commands, but it does not label other edits as AI without a reliable source signal.

SyntaxStitch protects indexed structural pairs with a lightweight context-aware scanner; it is not a full language parser, formatter, linter, or substitute for source control. Embedded language detection currently covers script/style blocks, JavaScript template markup, and JSX/TSX. Review repaired edits just as you would review edits from any other coding tool.
