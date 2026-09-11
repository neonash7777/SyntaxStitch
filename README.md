# SyntaxStitch

<p align="center"><img src="media/icon.png" width="128" height="128" alt="SyntaxStitch logo: a neon stitched S between colorful code braces"></p>

**Tired of AI breaking your code and wasting more tokens trying to fix mismatched closing glyphs? SyntaxStitch is for you.**

SyntaxStitch watches structural edits and repairs orphaned brackets, quotes, tags, and Python indentation before one missing boundary turns the rest of the file into syntax-error confetti. It works with AI edits, paste replacements, multi-cursor changes, and ordinary typing.

Behind the scenes, SyntaxStitch maintains a UUID-backed shadow index of paired boundaries. If an edit destroys one side, SyntaxStitch checks whether the surviving side now matches another boundary. It repairs only genuinely orphaned structures.

No cloud service. No source upload. No setup required.

## Supported Structures

| Structure | Examples | Behavior |
| --- | --- | --- |
| Brackets | `()`, `[]`, `{}` | Restores one deleted side when its indexed partner would otherwise be orphaned. Deletes the whole pair when its interior is only whitespace. |
| Quotes | `'...'`, `"..."`, `` `...` ``, `'''...'''`, `"""..."""` | Restores one deleted quote without treating quoted braces or tags as structure. Includes HTML attribute quotes and JavaScript template literals. |
| Markup tags | `<section>...</section>` | Synchronizes tag-name edits, restores a damaged boundary, removes the counterpart when one complete tag is deleted exactly, or deletes both tags and whitespace when the element is empty. |
| Python indentation | Indent and dedent boundaries | Tracks block boundaries and repairs an orphaned side. |
| Closing-brace indentation | Line-leading `}` | Realigns a changed closer with its matched opening brace. |

SyntaxStitch is enabled by default for JavaScript, TypeScript, JSON, HTML, XML, Vue, Svelte, Astro, CSS, SCSS, Less, Python, C#, Java, Go, and Rust. Language coverage can be changed with `syntaxstitch.languages`.

## Features

- UUID-backed, language-scoped structural pairs for braces, quotes, tags, and Python indentation boundaries.
- Embedded-language transitions for JavaScript in `<script>`, CSS in `<style>`, and HTML inside JavaScript template literals and JSX/TSX.
- Descending batch analysis so lower-file changes do not invalidate earlier offsets.
- Exact token restoration for one-sided brace and tag deletion.
- Guarded repair edits that cannot recursively trigger more repairs.
- JSON Lines records in the **SyntaxStitch** output channel for agent/tool synchronization.
- Persistent workspace repair statistics split across `()`, `[]`, `{}`, `<>`, `""`, and `\t` structures.
- Compact, accessible `{S} total` status-bar control; hover for the per-structure breakdown or click for actions.
- An inline `owner L12↔L28 17 Lines` label after each closing boundary, where `owner` is the declaration or opening tag. Modifier-click the owner to select its defining statement and block, `↔` to select the content between delimiters, either line number to select that line, or the line count to select the complete range. Hover the owner for folding and structural selection actions. **Fold / unfold contents** folds every collapsible child; when all children are folded, it unfolds only the direct children.
- Localized closing-brace indentation repair based on the matched opening brace.
- Context-aware Structural Tab navigation through closing tags and across correctly indented line-leading `}` boundaries.

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
| Remove a closer when an unused later closer can complete the pair | Reassign the later closer only when the number of pairs in scope stays the same. | This repairs malformed code without taking a closer from an enclosing pair. |
| Programmatically delete a protected multiline closer | Restore it while removing one trailing line break per attempt. | Programmatic edits provide no caret intent; gradual compaction preserves the structure while moving the closer toward its content. |

Direct selection and caret movement apply only to Backspace/Delete operations with one caret and no selection. Selections, multi-cursor edits, paste operations, and AI or workspace edits are handled as complete changes.

SyntaxStitch does not auto-close newly typed HTML tags. VS Code's HTML service, Emmet, or another language provider may create the closing tag. When a provider inserts an adjacent empty pair and leaves the cursor after the closing tag, SyntaxStitch moves the cursor inside. The pending correction applies only to the current document version and expires after 500 ms.

### Language Ownership

Every shadow pair records its active language. HTML tags use HTML rules, `<script>` bodies use JavaScript, `<style>` bodies use CSS, and markup in JavaScript templates or JSX/TSX switches back to HTML rules. Quotes and comments prevent brace-like text from being treated as structure. SyntaxStitch also checks language ownership when matching boundaries after an edit, so a JavaScript closer cannot adopt an HTML or CSS boundary.

### Structural Selection

**Select Matching Structure** selects the pair at either boundary and expands through enclosing pairs. On macOS, `Cmd+PageUp` expands and `Cmd+PageDown` retraces previous selections exactly. Without selection history, `Cmd+PageDown` contracts toward the active edge. The history resolves ambiguity in blocks with multiple siblings, where position alone cannot identify the previously selected child.

When a single empty cursor is immediately before a closing tag, Tab moves to the next closing tag in document order. Before a line-leading `}`, it jumps past the boundary only when the closing line's indentation exactly matches the indexed opening line. Otherwise, Tab retains its normal indentation behavior.

SyntaxStitch yields Tab to VS Code while a snippet, suggestion, inline suggestion, read-only editor, or Tab-moves-focus mode is active. Outside a recognized structural boundary, the command delegates directly to VS Code's normal Tab command.

## Installation

Install **SyntaxStitch** from the VS Code Marketplace, or download the `.vsix` attached to a [GitHub Release](https://github.com/neonash7777/SyntaxStitch/releases) and run **Extensions: Install from VSIX...**.

SyntaxStitch requires VS Code 1.127.0 or later.

## Support SyntaxStitch

If SyntaxStitch saves you time, you can support its development:

[![Support with Venmo](https://img.shields.io/badge/Venmo-@neonash7777-008CFF?style=for-the-badge&logo=venmo&logoColor=white)](https://venmo.com/u/neonash7777)
[![Support with Cash App](https://img.shields.io/badge/Cash_App-$neonash7777-00D64F?style=for-the-badge&logo=cashapp&logoColor=white)](https://cash.app/$neonash7777)

## Commands

- **SyntaxStitch: Select Matching Structure** selects the complete pair at the cursor, including both boundaries and its content. Run it again to expand outward. The default shortcuts are `Ctrl+Alt+Shift+S` and, on macOS, `Cmd+PageUp`. They can be changed in **Preferences: Open Keyboard Shortcuts**.
- **SyntaxStitch: Select Inner Structure** retraces selections made with **Select Matching Structure**, restoring the exact previous selection. Without selection history, it contracts to the nearest nested pair and follows the active edge when siblings exist. On macOS, use `Cmd+PageDown`.
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
- `syntaxstitch.structures` selects `brace`, `quote`, `tag`, and/or `indent` repairs. All are enabled by default.
- `syntaxstitch.languages` limits monitoring to selected VS Code language identifiers. Set it to `[]` to monitor every language.
- `syntaxstitch.maxFileSizeKB` skips large documents. The default is 2048 KB.
- `syntaxstitch.logLevel` controls structured output with `off`, `repairs`, or `verbose`.
- `syntaxstitch.flashStatus` controls the 500 ms status-bar flash after a counted repair. It defaults to `true`; set it to `false` to keep the status item quiet.
- `syntaxstitch.repairCountCooldownMs` prevents immediate retries on the same boundary from inflating statistics. It defaults to 5000 ms; use `0` to count every application.

## Development

```sh
npm run compile
npm run test:unit
npm test
```

Use **Tasks: Run Test Task** for the one-click pre-publish check. It packages the extension, runs the fast decision matrix, and runs the extension-host suite against the minimum supported VS Code version. During development, run only new unit scenarios by name, for example `TEST_PATTERN=quote npm run test:unit:focused`.

Open **Run and Debug** and use the green Run button with either persistent launch action:

- **Run SyntaxStitch Extension** opens this project in an Extension Development Host.
- **Run SyntaxStitch Automated Tests** packages the extension, runs the fast unit matrix, and runs the extension-host suite against the minimum supported VS Code version.

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
