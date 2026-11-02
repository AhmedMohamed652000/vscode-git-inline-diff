# Git Inline Diff (Accept / Reject)

Cursor-style review of what changed in the file you have open, compared to **what is on GitHub** (the upstream branch, e.g. `origin/development`), or to `HEAD` / the index.

- The lines you removed or replaced are drawn as **red rows right above** the lines you wrote, which are highlighted **green** — exactly like Cursor. Right **below** the hunk sits an action bar with a chip that says where the change comes from (*yours · not on origin/development*, *incoming from origin/development*, *conflict*) and the buttons: **Reject** · **Accept** (conflicts: **Accept current** · **Accept incoming** · **Accept both**) · **diff**. The bar is packed to the left so nothing is cut off in a narrow editor.
- Rows need the `editorInsets` proposed API switched on once per editor (see *Rows inside the editor* below). Until then the same information is shown as red chips at the end of the changed lines plus a CodeLens with the buttons, and the hover always shows the full `-`/`+` diff.
- **Accept** = keep my version and hide the highlight (remembered per workspace until the hunk changes).
- **Reject** = put the base (GitHub) version of those lines back into the file. It is a normal edit: `Ctrl+Z` undoes it.
- After Accept or Reject the cursor jumps to the next pending hunk, so a file can be reviewed from the keyboard alone.
- Status bar: `origin/development: 3 mine · 2 incoming · 1 conflict` — click it for the menu.

## Mine, incoming, conflict

Comparing the working file straight against the remote mixes two things: what *you* changed, and what *teammates* pushed that you have not pulled yet. The extension uses the merge base of `HEAD` and the base ref to tell them apart:

| Kind | Colour | Meaning | `Ctrl+Shift+Y` | `Ctrl+N` |
|------|--------|---------|----------------|----------|
| **mine** | green | only you changed this region since the merge base | Accept (keep mine, hide) | Reject (restore the base lines) |
| **incoming** | blue | the remote changed it, your file still has the old lines | Dismiss (hide) | Accept incoming (apply the remote lines) |
| **conflict** | orange | both sides changed the same region; a pull will conflict here | Accept current (hide) | Accept incoming (replace my lines) |

A conflict has a third button, **Accept both**: it inserts the GitHub lines above yours and marks the region as reviewed, so you can merge the two by hand (it is a normal edit, `Ctrl+Z` undoes it).

So `Ctrl+Shift+Y` always means *keep what is in my file* and `Ctrl+N` always means *take the GitHub version of this region*. Incoming hunks are best handled with a real `git pull`; the extension shows them so you know you are behind, and lets you take single regions when you want to. When the remote is already merged into `HEAD` (or the base is `head` / `index`) everything is simply "mine". Turn the classification off with `gitInlineDiff.threeWay: false`.

## Jumping between changes

- Every action bar ends with a counter (`2 / 5`) and **↑ ↓** buttons that jump to the previous / next change (wrapping around) and give the focus back to the editor.
- The status bar shows the same **↑ ↓** next to the summary while the file has changes.
- After **Accept** / **Reject** the cursor jumps to the next pending change by itself; when the last one is handled the status bar says *reviewed*.
- Keyboard: `F7` / `Shift+F7` (like the diff editor) or `Ctrl+Alt+]` / `Ctrl+Alt+[`.

## Keyboard

| Key | When | Action |
|-----|------|--------|
| `Ctrl+Shift+Y` | cursor inside a hunk | Accept / Dismiss / Accept current, then jump to the next hunk |
| `Ctrl+N` | cursor inside a hunk | Reject / Accept incoming, then jump to the next hunk (outside a hunk `Ctrl+N` is still "New File") |
| `F7` / `Shift+F7` | file has hunks | Next / previous hunk |
| `Ctrl+Alt+]` / `Ctrl+Alt+[` | file has hunks | Next / previous hunk |
| `Ctrl+Alt+D` | file has hunks | Open the diff editor against the base |

Change them in *File → Preferences → Keyboard Shortcuts* (search for "Git Inline Diff").

## Rows inside the editor (the Cursor look)

The red rows are drawn with VS Code's `editorInsets` proposed API, which an editor only grants to an extension that is listed in its `argv.json`. Enable it once per editor:

1. Run **Git Inline Diff: Enable Inline Rows** from the Command Palette (or click *Enable rows* in the prompt the extension shows). It adds `"enable-proposed-api": ["Ghammes.git-inline-diff"]` to the editor's `argv.json` and keeps a `.bak` copy.
2. Quit the editor completely (all windows) and start it again. *Reload Window* is not enough.

Without it the extension keeps working with chips + CodeLens; set `gitInlineDiff.removedLinesView` to `inline` to stay with that style on purpose.

Whatever the style, `Ctrl+Alt+D` (or the compare icon in the editor title / the status bar) opens VS Code's own diff editor against the base, with the real file on the modified side, so the same Accept/Reject keys and the built-in per-hunk revert arrows work there too.

To make that diff editor render inline (unified) instead of side by side, set:

```json
"diffEditor.renderSideBySide": false
```

## Commands (Command Palette → "Git Inline Diff")

- Accept / Reject Hunk, Accept Both (conflicts), Accept All, Reject All
- Go to Next / Previous Hunk
- Enable Inline Rows (writes `argv.json`, restart required)
- Open Diff Against Base, Open Base Version (read-only)
- Review All Changed Files Against Base (multi-file diff editor)
- Fetch Remote and Refresh (`git fetch`, then compare again)
- Choose What to Compare Against (`upstream` / `head` / `index` / any ref)
- Show Accepted Hunks Again, Refresh, Enable / Disable

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `gitInlineDiff.base` | `upstream` | `upstream` (origin/<branch>), `head`, `index`, or any git ref such as `origin/main` |
| `gitInlineDiff.threeWay` | `true` | classify hunks as mine / incoming / conflict using the merge base |
| `gitInlineDiff.advanceAfterAction` | `true` | jump to the next pending hunk after Accept / Reject |
| `gitInlineDiff.removedLinesView` | `rows` | `rows` = red rows with the buttons above each hunk (needs *Enable Inline Rows* + restart once, falls back to chips until then), `inline` = chips at the end of changed lines + CodeLens, `off` |
| `gitInlineDiff.showCodeLens` | `true` | Accept / Reject / Diff lenses above each hunk |
| `gitInlineDiff.removedTextMaxLength` | `200` | cut the inline text after this many characters |
| `gitInlineDiff.showGutterIcons` | `true` | green / blue / orange bars in the glyph margin |
| `gitInlineDiff.showKeybindingHint` | `true` | "Reject Ctrl+N · Accept Ctrl+Shift+Y" on the hunk under the cursor |
| `gitInlineDiff.ignoreWhitespace` | `false` | ignore leading/trailing whitespace when comparing |
| `gitInlineDiff.maxLines` | `20000` | bigger files are skipped |
| `gitInlineDiff.exclude` | node_modules, lock files, `*.min.js`, `*.map` | files that are never compared |

Colors can be overridden in `workbench.colorCustomizations`: `gitInlineDiff.addedLineBackground`, `gitInlineDiff.removedTextBackground`, `gitInlineDiff.removedTextForeground`, `gitInlineDiff.removedMarker`, `gitInlineDiff.incomingLineBackground`, `gitInlineDiff.incomingTextBackground`, `gitInlineDiff.incomingTextForeground`, `gitInlineDiff.incomingMarker`, `gitInlineDiff.conflictLineBackground`, `gitInlineDiff.conflictTextBackground`, `gitInlineDiff.conflictTextForeground`, `gitInlineDiff.conflictMarker`, `gitInlineDiff.hintForeground`.

## Notes

- "What is on GitHub" means the last fetched state of `origin/<branch>`. Run **Fetch Remote and Refresh** (or enable `git.autofetch`) to pick up new remote commits; incoming hunks appear after a fetch and disappear after a pull.
- Files inside a git submodule are compared against the submodule's own upstream.
- A file that does not exist on the base is reported as *new file* in the status bar and is not painted.

## Development

```bash
npm install
npm test                    # node test/smoke.js  (fake vscode + throw-away git repo, incl. the three-way scenario)
# F5 in VS Code runs the extension in an Extension Development Host
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension git-inline-diff-<version>.vsix --force
```

---

## بالعربي

الـ extension بيقارن أي ملف بتفتحه بالنسخة اللي على GitHub (`origin/<branch>`) ويعرض الفرق جوّه الملف نفسه:

- زي Cursor بالظبط: السطر القديم **أحمر** فوق، والسطر الجديد **أخضر** تحته. جوّه الصف الأحمر فيه chip بيقول التغيير ده جاي منين، والأزرار جنبه.
- **تغييرك** أخضر وعليه "yours · not on origin/…" وأزرار **Reject / Accept**. **تغيير جاي من GitHub ولسه ما عملتش pull** أزرق وعليه "incoming from origin/…" وأزرار **Accept incoming / Dismiss**. **تعارض** (انت وهما غيرتوا نفس السطور) برتقالي وعليه "conflict" وأزرار **Accept both / Accept incoming / Accept current**. بيتحسبوا من الـ merge base بين HEAD والفرع.
- حل التعارض: **Accept current** سيب نسختك، **Accept incoming** خد نسخة GitHub، **Accept both** يحط سطورهم فوق سطورك عشان تدمجهم بإيدك. كله تعديل عادي ينفع فيه `Ctrl+Z`.
- `Ctrl+Shift+Y` دايماً = سيب اللي في ملفي، و `Ctrl+N` دايماً = خد نسخة GitHub للمنطقة دي. بعد أي واحدة المؤشر بينط للـ hunk اللي بعده. الـ status bar بيقول مثلاً `origin/development: 3 mine · 2 incoming · 1 conflict`.
- الصفوف دي محتاجة تفعيل مرة واحدة لكل محرر: أمر **Git Inline Diff: Enable Inline Rows** (بيضيف سطر في `argv.json` وبيسيب نسخة `.bak`) وبعدين اقفل المحرر كله وافتحه تاني. قبل التفعيل بيشتغل بنفس المعلومات على شكل chips حمرا في آخر السطر + CodeLens.
- `Ctrl+Alt+D` يفتح الـ diff editor بتاع VS Code على نفس الملف لو عايز تشوف الملف كله.
- المقارنة بآخر fetch من الريموت، فلو فيه commits جديدة على GitHub اعمل **Fetch Remote and Refresh** من المنيو في الـ status bar. الـ incoming بيظهر بعد fetch ويختفي بعد pull.
