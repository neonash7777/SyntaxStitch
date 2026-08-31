# Changelog

All notable changes to SyntaxStitch are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.0.3 - 2026-08-31

### Added

- Add Venmo and Cash App links for supporting continued development.
- Add inline pair actions after closing boundaries; modifier-click the owner to select the exact structural pair.
- Show start line, end line, and total line count; modifier-click the start line to jump to the opening symbol or the line count to select every complete line in the block.

## 0.0.2 - 2026-08-31

### Fixed

- Support installation and execution on VS Code 1.127.0 and newer.
- Validate extension behavior against both the minimum supported VS Code version and current stable.

### Added

- Add UUID-backed shadow indexing for braces, markup tags, and Python indentation.
- Track a language ID on every shadow pair and honor HTML, JavaScript, CSS, template-markup, and JSX/TSX context shifts during indexing and repair rebinding.
- Protect single, double, template, Python/C# triple, and HTML attribute quote pairs while ignoring structural decoys inside quoted content and comments.
- Enable CSS, SCSS, and Less documents by default and add quote repair configuration and statistics.
- Add guarded reconciliation edits and structured output records.
- Add language scoping and manual index/output commands.
- Add an accessible status-bar toggle with workspace-aware state.
- Add structure filters, a large-file cutoff, and configurable output verbosity.
- Preserve equivalent structural tokens supplied by pasted replacement text.
- Remove both boundaries and intervening whitespace when either side of an empty bracket, brace, parenthesis, or tag pair is deleted.
- Peel nested empty pairs one layer per repeated deletion and allow coordinated multi-cursor or AI edits to unwrap meaningful content.
- Compact one trailing line break per repeated deletion of a protected closer while preserving the structural boundary.
- Step inward through adjacent protected closers and select the next meaningful inner pair during direct single-cursor deletion.
- Preserve a directly deleted multiline closer in place and select its complete meaningful block instead of compacting its formatting.
- Route Backspace and Delete through intent-aware wrappers so keyboard navigation stays isolated from AI, paste, multi-cursor, and workspace edits.
- Replace partially damaged multi-character boundaries in place, preventing duplicate closing tags, and select the complete element after direct deletion.
- Correct a provider cursor left after a newly auto-inserted adjacent closing tag, placing it between the opening and closing tags.
- Add Structural Tab: jump from one indexed closing tag to the next, or past a correctly indented line-leading `}`, while preserving native indentation, snippet, suggestion, and focus behavior elsewhere.
- Add a keyboard-accessible matching-structure selection command with `Ctrl+Alt+Shift+S` and macOS `Cmd+PageUp` shortcuts that expands through enclosing pairs when invoked repeatedly.
- Add macOS `Cmd+PageDown` to retrace outward structural selections exactly, then contract into the nearest nested pair when no selection history exists.
- Add persistent repair statistics and status-bar actions for viewing or resetting counts.
- Preserve pair UUIDs across reindexing and repair only when the untouched counterpart remains orphaned after post-edit boundary rebinding.
- Prevent a nested pair from rebinding to an outer pair's closer when that would reduce the scoped pair count.
- Add opt-in virtual pair ownership labels for the active pair or all closing boundaries.
- Keep all-pairs labels focused on multiline line-leading boundaries to avoid inline-brace clutter.
- Use a language-neutral ownership arrow and hover description for virtual pair labels.
- Align touched line-leading closing braces with their matched opening brace indentation.
- Split repair statistics by bracket family and show compact `[n] (n) {n} <n> tN` status counters.
- Count immediate repeated repairs of the same boundary as one incident, with a configurable cooldown.
- Enable multiline pair ownership labels by default on new installations.
- Add VSIX packaging, Marketplace metadata, and automated GitHub Release publishing.
- Expand the README for Marketplace discovery and onboarding.
