# SyntaxStitch AI Edit Test

## Setup

1. Open **Run and Debug**, select **Run SyntaxStitch: Manual Test Lab (No Debugger)**, and press the green Run button. The Extension Development Host remains open until you stop it.
2. In that host, double-click all four fixture files so their tabs remain open and SyntaxStitch indexes them.
3. Confirm the bottom-right status item starts with **{S}** and shows the total repair count.
4. With `fixture.html` active, run **SyntaxStitch: Inspect Active Document**. Confirm it reports `html`, `active`, at least one tag pair, and `tag` among the enabled structures.
5. Run **SyntaxStitch: Show Reconciliation Output**.

## Copy-Ready Prompt

Paste this into an AI coding agent running in the Extension Development Host:

```text
This is an intentional fault-injection test for the SyntaxStitch extension. Edit the four files under manual-tests using normal VS Code text edits. Make exactly one edit per file, in the order below, and do not fix, compensate for, format, or clean up the resulting syntax errors.

1. fixture.html: Delete only the complete opening article tag containing data-syntaxstitch-target="html". Leave its contents and closing article tag untouched.
2. fixture.js: On the line immediately after the SyntaxStitch JavaScript target comment, delete only the opening parenthesis immediately after values.reduce. Leave every other character untouched.
3. fixture.py: On the line immediately after the SyntaxStitch Python target comment, delete only its four leading spaces. Leave the line text and the indentation of every other line untouched.
4. Fixture.cs: On the line immediately before the SyntaxStitch C# target comment, delete only the opening brace. Leave the matching closing brace untouched.

Apply each file edit separately. After each edit, wait for the editor buffer to settle, then report the exact target line currently visible. Do not make any second edit to a file even if the deleted token reappears. The reappearance is the expected behavior under test.
```

## Expected Result

SyntaxStitch should:

- Remove the corresponding closing `</article>` tag in HTML while preserving the heading and paragraph.
- Restore the opening `(` after `values.reduce` in JavaScript.
- Restore the four leading spaces before `total = sum(values)` in Python.
- Restore the opening `{` before the C# method body.

The output channel should contain one `syntaxstitch/reconciled` JSON record per file. If an expected result does not appear and no record is written, confirm the file was already open before the edit and that the AI agent used an incremental VS Code edit rather than replacing the file directly on disk.
