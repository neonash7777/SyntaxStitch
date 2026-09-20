import * as vscode from 'vscode';

export const TUTORIAL_EXAMPLE = `<div>
  <span class="outer-one" data-group="alpha">
    <span class="inner-one" title="First" data-tone="warm">First nested span</span>
  </span>
</div>
<div>
  <span class="outer-two" data-group="beta">
    <span class="inner-two" title="Second" data-tone="cool">Second nested span</span>
  </span>
</div>
<div>
  <span class="outer-three" data-group="gamma">
    <span class="inner-three" title="Third" data-tone="neutral">Third nested span</span>
  </span>
</div>`;

export const tutorialContent = (platform: string = process.platform): string => `<!-- SyntaxStitch: Nested Select Tutorial
The three examples below are already selected for you.

1. ${platform === 'darwin' ? 'PRESS OPT+CMD+RETURN (Option+Command+Return)' : 'PRESS CTRL+ALT+S'} over a selection to enter Nested Select.
2. Press DOWN / UP to cycle between the three selected divs.
3. Press RIGHT to enter an outer span, then RIGHT again for an inner span.
4. Press DOWN / UP to cycle matching spans at that nesting level.
5. Press TAB to explore contents and attribute names/values.
6. Focus a class value and type highlight. Pause briefly: matching spans update automatically.
   Check the dashed target outlines before typing; outer and inner spans may both match.
7. Undo once (CMD+Z on Mac, CTRL+Z elsewhere): your typing and mirrors return together.
   Redo, then undo again. Nothing should reapply by itself.
8. Press RETURN to finish typing. Press LEFT to return to a parent, or ESC to exit navigation.

While typing, ESC returns to navigation; press ESC again to exit.
The status bar shows the matching edit scope and targets. Click it to change scope.
Challenge: reopen this tutorial to reset, then try changing a title value.
Only inner spans have title, so the outer spans should keep their properties.
This is an unsaved practice document. Close it without saving when finished.
-->
${TUTORIAL_EXAMPLE}
`;

export async function openPractice(): Promise<void> {
	const content = tutorialContent();
	const document = await vscode.workspace.openTextDocument({ language: 'html', content });
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	const start = content.indexOf(TUTORIAL_EXAMPLE);
	editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(start + TUTORIAL_EXAMPLE.length));
	editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
}
