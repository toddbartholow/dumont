# Changelog

All notable changes to Dumont are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dumont is a fork of [Paperling](https://github.com/Razee4315/Paperling) and its
version numbering starts fresh at 0.1.0. Everything below the "Paperling history"
divider is the upstream project's changelog, retained for provenance.

## [Unreleased]

## [1.0.0] - 2026-07-18

### Changed

- **Version 1.0.0.** The feature set that accumulated through the 0.x series is
  declared stable: the reader-first views, settings.json configuration, themes,
  exports, AI editing, and the security hardening around all of them. No
  functional changes since 0.5.0. The project history was consolidated to a
  single root commit and the 0.x releases were retired.

## [0.5.0] - 2026-07-16

### Fixed

- **Opening several Markdown files at once now opens all of them.** Selecting multiple `.md`
  files in Finder or Explorer and opening them while Dumont was not yet running opened only one
  and silently dropped the rest, because the launch path that hands the files to the app held a
  single slot. It is a queue now: every file opens as a tab, with the first as the active one.
  (Opening several while the app was already running always worked, and still does.)

- **The version-history store no longer grows without bound.** History is keyed by the file's
  path, so renaming or deleting a note stranded its snapshots under the old key forever, with
  nothing to ever reclaim them. A one-time sweep at startup now retires the history of a note
  that has been deleted, adopts a snapshot that a crash left written-but-unrecorded, and clears
  the temporary file an interrupted save leaves behind. It is deliberately careful with notes
  that live on external or network drives: a file that is missing only because its volume is
  unplugged keeps its history, which returns intact when the drive does.

## [0.4.2] - 2026-07-15

### Added

- **The reading column has a width setting, and code blocks and tables use the space they
  need.** The reader view capped every document at an 800px column. On a large screen that
  wasted most of the width, and worse, it squeezed wide code blocks and tables into the same
  narrow measure and clipped their long lines behind a scrollbar while the rest of the window
  sat empty. Reader width is now a setting (Appearance > Reader width) with four tiers, narrow
  through full width; the default is wider than the old fixed column and tuned for a maximized
  1920px window. At the narrow, medium and wide tiers the prose stays at a comfortable measure
  while code blocks and tables break out wider, so their long lines and extra columns are no
  longer clipped; the full tier fills the window with both. A table
  that is still too wide for the broken-out column (an unbreakable token, many columns, a large
  body font) now scrolls sideways inside its own box, the way code blocks already do, instead of
  being cut off or pushing the whole page sideways. A narrower window shrinks each tier to fit.

## [0.4.1] - 2026-07-15

### Security

- **The AI API key no longer enters the webview.** It was read out of the OS keychain into
  the preview and passed back on every request, so a single cross-site-scripting bug in
  rendered content could have read it with one call. Now Rust reads the key from the keychain
  itself when it makes the request and attaches the header there; the command that returned
  the key is gone, replaced by one that only reports whether a key is saved. The Settings
  field is write-only to match: it shows that a key exists without ever showing the value.
  The key lives in the keychain and nowhere else, with no plaintext fallback.

- **Exported HTML from a shared note can no longer run script or phone home.** A Mermaid
  diagram is the one piece of rendered content that skips the Markdown sanitizer, and a
  standalone exported file has no content-security-policy to fall back on. Exports now
  re-sanitize every diagram: any script, event handler, or javascript: link is removed, and a
  remote stylesheet import or image URL hidden in a diagram's styles, which would quietly fetch
  from a stranger's server when the file is opened, is neutralized. The diagram itself is
  unchanged.

- **The document view can no longer reach arbitrary HTTPS hosts.** The content-security-policy
  allowed connections to any https host, which nothing in the app needs (AI requests and
  update checks go through the Rust backend, not the web view), so the allowance only stood as
  a ready outbound path if a script ever ran in the preview. It is gone; the view can reach the
  app itself and a local AI endpoint, and nothing else.

### Fixed

- **Most of the app's small print was unreadable, on every theme.** Setting descriptions,
  backlink line numbers, command-palette shortcut hints, recent-file paths and timestamps,
  empty-state copy, placeholders: sixty places where you are meant to read something, all
  painted in a gray that clears the contrast floor on none of the ten themes. It is 2.11:1 on
  Nord, and even Paper, the best case, only reaches 4.24:1 against a 4.5:1 requirement. They
  are all in a readable color now, between 5.34:1 and 8.11:1, and still visibly quieter than
  the labels they sit under.

## [0.4.0] - 2026-07-14

### Fixed

- **Two saves of the same document at once could corrupt it. Update from 0.3.0.**
  `save_file` built its temporary file's name from the document's path and the process
  id alone, so two saves of one document computed the same temp path. Creating a file
  truncates it, so the second writer truncated the first mid-write, the two interleaved
  at their own offsets, and whichever finished first renamed a splice of both over the
  document. The other then reported "Failed to save file" for a save that had just
  helped destroy it. A test that runs forty concurrent pairs corrupted the file on the
  first round; the temp name now carries a per-call counter, and that test pins it.

  This was not exotic. Autosave arms its timer on your last keystroke, and Ctrl+S does
  not change the text, so the timer is never cleared and both saves end up in flight.
  Two quick presses of Ctrl+S did it just as well.

- **A closed find bar could yank the caret out of the sentence you were typing.** The
  bar is mounted even when hidden and did not clear its query on Escape, so it went on
  searching. Once an edit shifted a match's offset it would jump the selection back to
  a match you had already dismissed, at a position decided by wherever the cursor
  happened to be when you first pressed Ctrl+F.

- **Exporting to HTML while using a theme of your own painted the document in the
  built-in dark theme instead.** The export resolved the theme without being told about
  user themes, so a custom id was not found and quietly fell back to the base palette.

- **An edit to `settings.json` made outside Dumont could be swallowed for good.** The
  app remembers what it last wrote so it can ignore the echo of its own save, but it
  never forgot it, so "the echo of our last write" had really come to mean "any text
  this app has ever written, forever". Edit the file by hand, then undo that edit back
  to something Dumont had written before, and the app never noticed the undo and later
  wrote its stale copy back over it.

- **A file named `NOTES.MD` was invisible to the app that had just opened it.** Every
  place that decides what counts as a markdown file spelled the test out for itself,
  and all of them compared the extension case-sensitively. macOS and Windows match file
  associations without regard to case, so the system really does hand an uppercase file
  to Dumont: double-clicking it raised the window and did nothing, and the file was
  missing from the explorer, from search and from backlinks, while File > Open opened it
  quite happily. There is one definition of "markdown file" now, and it ignores case.

- **`Ctrl+Shift+E` and `Ctrl+Shift+O` did nothing with CapsLock on.** CapsLock inverts
  Shift, so the key arrives lowercase and the two shortcuts were testing for the
  uppercase letter only. The file explorer and the outline are reachable again.

- **The placeholder shown while an image loads was invisible on every theme.** It was
  painted with a color token that no theme defines.

- **Exported code blocks lost their monospace fallback on Linux.** The export carried
  its own copy of the font stack and the copy had drifted, dropping the one entry that
  Linux actually resolves. It now uses the same stack as the app.

### Changed

- **The app is a third smaller and no longer freezes while it starts.** There was no
  release profile at all, so it shipped with link-time optimization off, sixteen
  codegen units and every debug symbol still in the binary: 17.1 MB of executable, now
  10.7 MB, with no change in behavior. (Optimizing for size rather than speed would
  save another 2 MB, and aborting on panic another 4, but the first slows down the
  cross-file search and the backlink scan, and the second turns any panic into an
  instant kill with your unsaved work in memory. Neither is a good trade in an editor.)

  Separately, six commands that read and write files were being dispatched onto the
  main thread, so the window could not paint or respond while they ran. Saving a
  setting fsynced there, which on a busy or network-mounted disk is tens to hundreds of
  milliseconds of frozen window in response to clicking a checkbox. Worse, reading the
  AI key from the OS keychain ran there too, and on an unsigned build macOS answers that
  with a permission prompt and blocks until you dismiss it, which it does while the app
  is starting. All six now run off the main thread.

- **Version history is off by default** (`files.history`). It would otherwise be the
  only default that writes to your disk unasked, keeping a second copy of every
  document you save in a directory you have never heard of, and that is a decision to
  hand to you rather than make for you. The History panel says so plainly instead of
  showing an empty list, warns that nothing before now is recorded, and turns it on in
  a click.

- **The AI assistant is off by default** (`ai.enabled`). Dumont is a prose editor
  first, and the writer opening a Markdown file has not asked for an assistant. The
  setting gates the titlebar button, the panel, the command palette entries and Alt+J,
  so off means the app has no AI surface in it at all rather than a dormant one. Turn
  it on in Settings > AI, which is where its endpoint and model have to be configured
  in any case. Word wrap is now the only thing switched on out of the box.

## [0.3.0] - 2026-07-14

### Added

- **Backlinks (linked mentions).** A left-hand panel listing every `[[wikilink]]`
  that points at the open note: which file it is in, which line, the line itself,
  and the alias when the link carries one. Clicking a mention opens that file at
  that line. Ctrl+Shift+B, the status bar's link button, View > Backlinks, or the
  command palette.

  It scans the open note's OWN FOLDER, one level, and does not recurse. That is
  the wikilink resolver's rule rather than a shortcut: `[[Foo]]` resolves against
  the folder of the file it is written in, so a `[[Foo]]` in `sub/Baz.md` opens
  `sub/Foo.md` and not the `Foo.md` one level up. Listing it under the wrong
  note's backlinks would be a lie about where the link goes.

  Matching is case-insensitive, also for a reason: macOS and Windows both resolve
  `[[foo]]` to `Foo.md`, and Dumont's resolver probes the filesystem, so on those
  platforms the link really does open the note. A `[[Foobar]]` is still a
  different note, and a target the resolver would refuse (anything with a path
  separator or a `..`) is not counted at all.

- **Local version history: every save takes a snapshot, and any snapshot can be
  brought back.** `Ctrl+Shift+H`, the clock icon in the status bar, View > Version
  History, or the command palette. On by default (`files.history`), because a
  safety net you have to know about and go and switch on is not one: the moment it
  becomes useful is the moment it is too late to have enabled it. Snapshots live in
  the app's data directory, not next to the document, so nothing appears in the
  user's folders and nothing lands in their git repo.

  Restoring is a PROPOSAL, not an act. Picking a snapshot loads it into the same
  diff view the AI review uses: the old text arrives as a proposed change against
  what is on screen now, with per-chunk accept and reject, and nothing reaches the
  disk until Ctrl+S. The banner names the version on offer ("Snapshot from 3 minutes
  ago") rather than the AI review's wording, because the text is the writer's own
  earlier draft and crediting it to an AI would misdescribe what accepting it does.
  There is deliberately no command that overwrites the file with a snapshot. That
  would be the one irreversible operation in a feature whose whole purpose is
  reversibility, and it would be the one that quietly destroys whatever the user
  wrote since the snapshot was taken.

  The number that makes it work is `files.historyInterval` (60 seconds by default).
  Autosave writes 1.5 seconds after you stop typing, so a snapshot per save is a
  snapshot every couple of seconds, and ten minutes of writing would push the
  user's actual history out through the retention cap: a version history that
  destroys history, silently, and worst for the people who write the most. So a
  save that lands inside the interval is not recorded at all.

  Skipping such a save is not the same as folding its content into the newest
  snapshot, and the difference is the difference between a safety net and a trap.
  Take the case the feature exists for: you delete three paragraphs and save. Fold
  that content in and the newest snapshot becomes the DAMAGED one, thirty seconds
  after the good copy was taken, and the good copy is gone. Skip it and the newest
  snapshot still predates the deletion, which is the version you are reaching for.
  A snapshot's content is always the document as it stood at that snapshot's
  timestamp, never later. What you wrote in the last minute is not in the history,
  but it is not lost either: autosave has already written it to the file itself.

  `files.historyLimit` (50) caps how many are kept per file; the oldest are pruned,
  content and all.

  Writes are atomic (sibling temp file, fsync, rename), the same as settings.json
  and the document itself. Without the fsync a crash can leave a snapshot that
  exists, is named correctly, and is empty, which is precisely the failure this
  feature exists to prevent. Snapshotting is fire-and-forget: it is never awaited,
  it swallows its own errors, and it never raises a toast, so a full disk in the
  history store cannot slow down or fail a save that in fact succeeded.

- **Five more built-in themes: Solarized Dark, Solarized Light, Nord, Catppuccin
  Mocha and Catppuccin Latte.** Ten in total now, and a real light/dark balance:
  the five that shipped before were three darks (two of them high-chroma IDE
  themes built to make code tokens pop) against two lights, which is a strange
  lineup for an app whose default view is prose. All five new palettes carry
  their own code-block colors rather than deriving them, for the reason the VS
  2017 theme already did: Solarized sets strings in cyan and keywords in green,
  and a Solarized code block that does neither is not Solarized.

  The hues are the published ones; some of the lightness is not. Every theme
  Dumont ships has to clear the same contrast floors, and several of these
  palettes do not come close: Nord sets code comments at 1.4:1 against the
  surface a code block is drawn on, Catppuccin Latte its yellow at 2.15:1, and
  Solarized Light's own body tone is 4.13:1 on Solarized Light's own background,
  under the 4.5:1 that text needs. Every theme Dumont shipped before this one
  puts its code comments at 5:1 or better. So where a color could not carry a
  word, it was moved along one axis only: hue and saturation are the palette's,
  lightness is whatever clears the floor. Latte moves furthest, because a light
  pastel palette cannot hold 4.5:1 and stay pastel, so its peach reads as a burnt
  orange and its yellow as an ocher. Catppuccin Mocha needed nothing at all.

  Each adjustment carries its measured ratio in `src/themes/builtin.ts`, and the
  floor is enforced by a test rather than by good intentions.

### Changed

- **The theme picker scrolls, and its swatches show each theme's accent.** With
  ten themes plus however many the user has written, the grid pushed Font and
  Font size off the bottom of the Appearance pane; it now has a fixed height and
  scrolls, and it opens scrolled to whichever theme is active. The swatch used to
  be the page color beside the panel color, which told the five original themes
  apart only because they happened to have a visible step between the two.
  Solarized Dark is `#002b36` on `#00212b`: a flat square. The second tone is now
  the accent, which is the color anyone choosing Dracula over Nord is actually
  choosing.

### Fixed

- **The left sidebar panels covered the editor instead of sitting beside it.** Each
  one is a `fixed left-0` aside 288px wide, and the editor still began at the window
  edge underneath it, so the leftmost 288px of the text was hidden. It never showed,
  because reader mode centers its column inside margins wide enough to swallow the
  overlap, and the File Explorer and outline are usually read against reader mode.
  Restoring a snapshot is what exposed it: that drops the editor into split mode, and
  the diff's line numbers and the opening words of every changed line disappeared
  under the History panel. The editor area now reserves room on the left exactly as
  it already did on the right for the AI panel.

- **The split divider fought the cursor whenever a side panel was open.** It measured
  the pointer against the container's border box, which includes padding, while the
  panes size themselves with a percentage `flex-basis`, which resolves against the
  content box. The two are the same rectangle only while there is no padding. With
  the AI panel open the ratio was merely scaled wrong; with a left panel open the
  origin shifts too, so grabbing the divider where it was drawn made it leap about
  100px out from under the pointer on the first pixel of movement, and the arrow keys
  inverted: with a left panel open, ArrowRight made the editor narrower, and both
  arrows walked it down to the 20% floor. It measures the content box now.

- **Mermaid diagrams rendered light on a dark theme.** The mapping from an app
  theme to a mermaid one was a switch over theme ids whose default arm was the
  light diagram, so every dark theme added after it was written fell through to a
  white diagram on a black page. It asks the theme registry for the theme's type
  instead, which also means a user's own dark theme gets dark diagrams, something
  a hardcoded list of ids could never have covered.

### Security

- **A user theme's colors are now validated as colors, not scrubbed of unsafe
  characters.** A theme file is untrusted input (people share them), and every
  color in it is interpolated straight into a `<style>` block when a document is
  exported, so a token value is one string concatenation away from the exported
  HTML. The old guard removed dangerous characters and kept the remainder, which
  was safe but let inert non-colors through whole (`expression(...)`, `url(...)`)
  and could turn a typo into a truncated value. A value must now BE a color, a
  hex literal, a named color, or a call to a known color function
  (`rgb()`/`hsl()`/`color-mix()`/`var()` and the like), or it is dropped entirely.
  The live app was never exposed: it applies colors through `style.setProperty`,
  which cannot be made to escape a declaration. This hardens the export path and
  turns the check from a scrub into a lint, with the injection cases pinned by
  tests in `src/themes/themes.test.ts`.

## [0.1.2] - 2026-07-13

### Changed

- **The AI button no longer shimmers.** Its sparkle swept a gradient across
  itself on a loop, forever, while nothing was happening. The icon now takes the
  button's own colour, so it follows the hover and active states the label beside
  it always did.

### Fixed

- **Dropdown options and command palette rows did not respond to a click on
  Windows.** Both lists scrolled the row under the pointer "into view" on hover,
  which moved it out from under the press. A click only fires where pointerdown
  and pointerup land on the same element, so the browser synthesised it on the
  enclosing list instead and the choice was silently dropped. Hovering no longer
  scrolls (only the keyboard cursor does, which is all that ever needed it), and
  a choice commits on pointerup. Scrolling either list with the wheel no longer
  snaps it back, either.

- **The outline could scroll a heading out from under your click.** Jumping to a
  heading scrolls the document smoothly, and the outline follows the document, so
  a second click made during that animation landed on a moving row and was
  dropped. The outline now holds still while you are pressing it.

- **Screen readers announced nothing while you arrowed through the command
  palette.** Focus stays in the search box, so the results need
  `aria-activedescendant` to report which row the cursor is on, and there was
  none: Enter ran a command the user had never been told about. The palette is now
  a proper combobox, its sections are named groups, and an empty result set is
  announced rather than passing in silence.

## [0.1.1] - 2026-07-13

The first release of Dumont. It went out as 0.1.1 rather than 0.1.0 because a
v0.1.0 tag already existed on the fork commit, and the release workflow bumps the
patch whenever the current version is already tagged.

### Added

- **Settings live in a file you can edit.** Preferences are kept in a real
  `settings.json`, not in the webview's internal storage (on macOS, a SQLite blob
  inside the app's WebKit container: not editable, not diffable, not portable):

  - macOS: `~/Library/Application Support/com.irqstudio.dumont/settings.json`
  - Windows: `%APPDATA%\com.irqstudio.dumont\settings.json`
  - Linux: `~/.config/com.irqstudio.dumont/settings.json`

  The file is written the first time you change a setting. A setting you have
  never touched is absent from it rather than written out with its default, which
  is how the app knows it may still follow your OS light/dark preference.

- **Edit settings.json in the app, or in any editor.** The `{ }` button in the
  Settings header opens the raw file, with syntax highlighting, completion for
  every setting key and value, and warnings for unknown keys and out-of-range
  values. The grouped panes and the file are two views of the same thing: a
  toggle flipped in the UI shows up in the JSON, and a key typed in the JSON
  takes effect on save. Comments and trailing commas are allowed, and changing a
  setting from the UI leaves your comments and key order exactly as they were.

  Edits made outside the app apply live, without a restart. New commands in the
  palette: `Preferences: Open Settings`, `Preferences: Open Settings (JSON)`, and
  `Preferences: Show settings.json in the file manager`.

- **VS 2017 Dark theme.** A new theme modeled on Visual Studio 2017's dark
  IDE with its C/C++ editor palette: keyword-blue headings, type-teal
  subheadings, string-salmon code, comment-green quotes, and the classic
  VS-blue accent and selection.
- **Hack Nerd Font Mono.** A sixth body-font option, bundled with the app
  (regular/bold/italic/bold-italic, full Nerd-icon glyph set) so it works
  offline like every other font and needs no system install.

- **Minimap.** An opt-in VS Code-style document overview down the editor's
  right margin, with a draggable viewport indicator and click-to-jump. Toggle
  it in Settings → Editor, or from the command palette.
- **Any font size you like.** The size setting is no longer three fixed steps:
  pick a preset (12–24 px) or type any size from 11 to 32. Headings, line
  height, the editor and every export scale with it. Existing Small / Medium /
  Large choices carry over to 14 / 16 / 18 px.
- **The app version** is now shown in Settings → About.

### Changed

- **The quick settings menu is a menu again.** The gear dropdown had grown to
  a wall of swatches and buttons that broke its own layout as themes and fonts
  were added. Theme, font and size are now three compact dropdowns — arrow
  through themes or fonts to preview them live, Escape to back out. Everything
  else lives in the full Settings window, one click away.

### Fixed

- **The welcome screen's keyboard hints no longer break mid-phrase.** Under a
  monospace body font the line ran past the column it sits in and wrapped
  wherever it ran out of room, stranding "for shortcuts" on a line of its own,
  away from the key it names.
- **The window remembers its size and position.** Every launch reset it to a
  fixed 1000x700 and re-centered it, so a resized window had to be resized again
  every time. Size, position, maximized and fullscreen now persist between
  launches.
- **Double-clicking a `.md` file in Finder now opens it (macOS).** If Dumont
  was already running, the window came to the front but the document never
  loaded — only drag-and-drop and File → Open worked. macOS hands a
  double-clicked document to the running app as an Apple Event rather than as a
  command-line argument, and that path was never handled.
- **The font and size now apply to the editor, not just the preview.** The
  editor's typeface was hard-coded to JetBrains Mono and its size to a fixed
  value, so both Settings controls silently did nothing to the markdown source.
  The editor now follows your choices, and JetBrains Mono joins the font list
  (it was already bundled) for anyone who wants the old look back. Code spans
  and fenced blocks stay monospace whatever the body font is, so indentation
  and tables still line up.
- **The theme grid no longer wraps awkwardly** in the Settings window when the
  theme count isn't a multiple of four.

---

## Paperling history

Everything below was released by the upstream project, before the fork.

## [1.0.49] - 2026-07-12

### Added

- **More markdown syntax.** `==highlight==`, superscript (`x^2^`), subscript
  (`H~2~O`), definition lists (`Term` / `: definition`) and custom heading ids
  (`# Title {#my-id}`) now render in the preview and in every export. Note: a
  single `~tilde~` now means subscript; `~~double~~` is still strikethrough.
- **One-click AI setup.** The AI settings page now has provider presets
  (Google Gemini, OpenAI, Ollama): pick one and the endpoint and model fill
  themselves, so you only paste your API key.
- **"Open files in reader mode" setting.** When on, every file you open starts
  in the comfortable reading view; editing stays one click away. New files
  still open in the editor.
- **Subfolders in the file explorer.** Nested folders now show up and can be
  browsed without leaving Paperling.
- **Windows on ARM.** Releases now include a native arm64 installer.

### Fixed

- **Find could edit your document.** Typing in the find bar moved focus into
  the document a moment later, so your next keystroke overwrote the matched
  text. Focus now stays in the find bar, and Enter / Shift+Enter cycle through
  matches from the keyboard.
- **Selected text was unreadable.** The editor painted every selection in a
  fixed pale lavender regardless of theme. Selections now use each theme's own
  colors in all four themes.
- **Custom AI endpoints.** OpenAI-compatible endpoints failed with "Failed to
  fetch" even though they worked in curl. AI requests now go through the app
  itself instead of the browser layer, so any endpoint curl can reach works,
  including plain-http servers on your local network. Wrong keys, timeouts and
  unreachable servers now show clear messages.
- **Word export.** Exporting to .docx failed with an internal error; it now
  produces a proper Word document.
- **Footnote links.** Clicking a footnote reference now scrolls to the note
  and the return arrow scrolls back, in the app and in exported HTML.
- **Local links in exported HTML.** Links to other .md files used to export as
  dead "#" anchors; they now keep their real target.
- **Small Mermaid diagrams.** Diagrams now scale to the reading column so
  their text is legible, in the app and in exports.
- **Phantom unsaved changes on Windows files.** Opening a file with Windows
  (CRLF) line endings immediately marked it as modified. Files open clean, and
  saving preserves the file's original line-ending style.
- **White flash at startup.** The window now appears only after your theme has
  painted, so dark-theme users no longer get a white flare on launch.
- **A friendlier welcome tour.** The first card asks before starting, skipping
  is impossible to miss, the tour covers just the three least discoverable
  features, and its buttons no longer wrap onto two lines.
- **macOS: PDF export.** Exporting to PDF used to spin forever and produce
  nothing; it now saves directly through the system's native PDF path.
- **Linux: launch crash on GNOME/Wayland** (WebKitGTK DMABUF "Error 71
  Protocol error") is fixed.

### Thanks

This release was shaped by the community, and it shows:

- [Andreu Rodríguez Donaire](https://github.com/anrodon) contributed the
  subfolder support in the file explorer.
- [Eli Pinkerton](https://github.com/wallstop) contributed Windows on ARM
  support.
- [techie-monk0](https://github.com/techie-monk0) added supply chain security
  scanning to every build.
- The detailed reviews and bug reports from Reddit users CodenameFlux,
  Individual-Diet-5051, Fantastic_Back3191 and Cast_Iron_Skillet drove most of
  the fixes above. Thank you for taking the time to write them up.

## [1.0.48] - 2026-07-04

### Fixed

- **Tab "unsaved" indicator.** The mark showing a tab has unsaved edits rendered
  as a hollow ring next to the close button, which looked broken and unclear. It
  is now a small filled dot in the same amber as the status bar's "Unsaved"
  indicator, and it cleanly becomes the close (×) button on hover.

## [1.0.47] - 2026-07-04

### Added

- **Interactive feature guide.** The welcome tour now ends with "Open the
  guide", which opens a real, editable document that shows off live math,
  Mermaid diagrams, tables, task lists, code blocks and frontmatter, so you can
  try every feature hands-on. Open it anytime from the command palette with
  "Open the interactive guide".
- **The tour covers more of the app.** Added steps that point out the file
  explorer and the document outline so new users find them right away.

### Fixed

- **Export button icon.** The Export button used a download arrow that read like
  an import action; it now uses a clearer export icon.

## [1.0.46] - 2026-07-02

## [1.0.45] - 2026-06-28

### Added

- **Tabs remember your place.** Switching back to a tab returns you to the line
  you were on instead of jumping to the top.

## [1.0.44] - 2026-06-28

## [1.0.43] - 2026-06-28

### Added

- **Multiple tabs.** Open several files at once. Opening a file (or following a
  link) opens it in a new tab instead of replacing what you're reading. The tab
  bar is always shown once a file is open and has a **+** button to open more.
  `Ctrl+N` opens a new tab, `Ctrl+W` closes one, middle-click closes too, and
  `Alt+←` / `Alt+→` move to the previous/next tab. Unsaved tabs prompt before
  closing.

### Changed

- The title bar's back/forward arrows are gone — tabs (and `Alt+←` / `Alt+→`)
  cover moving between files now.

## [1.0.42] - 2026-06-28

## [1.0.41] - 2026-06-28

### Added

- **Search across files** (`Ctrl+Shift+F`). Search the text of every markdown
  file in the current folder, grouped by file with line numbers; pick a result
  to jump straight to that line. Also in the command palette.
- **`[[` autocomplete.** Typing `[[` in the editor now suggests the other
  markdown files in the folder, so linking is a couple of keystrokes.
- **Create missing notes.** Clicking a `[[link]]` or relative link to a file
  that doesn't exist yet offers to create it and opens the new note.

## [1.0.40] - 2026-06-28

### Added

- **Link navigation with history.** Clicking a `[[wikilink]]` or a standard
  relative `[text](note.md)` link now opens that file in-app. Back and forward
  buttons (and `Alt+←` / `Alt+→`) move through the files you've visited, and
  opening a file now starts you at the top instead of the previous scroll spot.

## [1.0.39] - 2026-06-28

## [1.0.38] - 2026-06-28

### Added

- **Word (.docx) export.** Export → Word writes a real Office Open XML document
  from the current file, with headings, lists, tables, bold/italic, links, and
  images carried over. Like PDF, it's a clean light document for sharing.

## [1.0.37] - 2026-06-28

## [1.0.36] - 2026-06-28

## [1.0.35] - 2026-06-22

### Added

- The Export and Settings dropdown menus are now fully keyboard-operable: focus
  moves into the menu on open, Arrow/Home/End move between items, and Escape
  closes and returns focus to the button.
- The file explorer refreshes when the window regains focus and gained a manual
  refresh button, so its list no longer goes stale after files change on disk.

### Changed

- **PDF export now saves directly.** On Windows, "Export → PDF" asks where to
  save and writes the file straight away, instead of opening the system print
  dialog. The PDF keeps selectable text and working links.
- The theme now matches your operating system's light/dark setting on first
  launch, and follows it until you pick a theme yourself.
- Notifications stack instead of replacing one another, and error messages stay
  on screen longer than confirmations.
- The Light theme has a softer, warmer tone for a bit more character.

### Removed

- The GitHub theme. (Light covers the same clean, bright look.)

### Fixed

- Find & Replace now shows "Invalid pattern" for an unparseable regex instead of
  a misleading "No results".
- Cancelling the export save dialog no longer shows a false "Exported" message.
- A persistent autosave failure keeps reminding you (throttled) instead of
  going quiet after the first warning.

## [1.0.34] - 2026-06-22

## [1.0.33] - 2026-06-18

## [1.0.32] - 2026-06-18

## [1.0.31] - 2026-06-18

## [1.0.30] - 2026-06-18

### Changed

- The "What's new" update popup now shows a concise summary of just the latest
  release's changes, instead of the full changelog history.

## [1.0.29] - 2026-06-18

### Added

- **Fullscreen mode (F11)** for distraction-free writing on Windows, Linux, and
  macOS. The title bar stays visible so there is always an obvious way out, with
  a one-time hint. Also available from the command palette.
- **Automatic updates.** Paperling checks for new versions on launch and offers
  a one-click update when a newer version is available. Update packages are
  signed and verified before installing.
- **Enable AI toggle** (Settings → AI). Turning AI off hides every AI surface:
  the title-bar button, the side panel, the toolbar sparkle, Alt+J, and the
  command palette entry.
- **Visual table editor.** A floating toolbar appears inside a Markdown table to
  insert or delete rows and columns, set per-column alignment, and re-align the
  layout.
- **Chemistry notation in math.** KaTeX now renders `\ce{...}` and `\pu{...}`
  (mhchem), with a `/chem` slash command to insert a starter snippet.
- **Document statistics** dialog — words, characters, sentences, paragraphs,
  headings, links, images, code blocks, and reading time.
- **Word wrap** and **spell check** toggles in Settings → Editor.
- **Selected word count** in the status bar, plus command-palette actions to
  reveal the current file in its folder and copy its path.

### Changed

- **Relicensed to Apache 2.0** — free for personal and commercial use, with an
  explicit patent grant.
- **Works fully offline.** All fonts and the icon set are now bundled, so the
  editor looks identical online and offline, and HTML export no longer depends
  on Google Fonts.
- **Book-style math typography** — display equations are centered with proper
  spacing and scroll horizontally on narrow screens instead of overflowing.

### Fixed

- List bullets and numbers render in the preview again.
- Ctrl+S / Ctrl+O / Ctrl+N / Ctrl+E now work with CapsLock on.
- Clicking a heading's anchor link copies a section link and confirms with a
  checkmark.
- Alt+J reliably opens the AI panel on Windows, where WebView2 had reserved
  Ctrl+J for its Downloads UI.
- The caret no longer drifts off the text after scrolling large documents.
- Clearer file-operation error messages (for example "File too large") instead
  of generic failures.
- Security hardening across file, image, AI, and wikilink handling: size limits,
  filename and path-traversal sanitizing, an AI request timeout and response
  cap, and a tightened Content Security Policy.

### Removed

- Retired dead auto-save / focus-mode storage helpers left over from 0.6.1.

### Performance

- Faster cold start and a much smaller initial bundle — the welcome screen no
  longer loads the markdown, export, or dialog code until it is needed — plus
  smoother typing and scrolling on large documents.

## [0.6.1] - 2026-04-30

### Fixed

- "This file was deleted or moved" banner appearing on every opened file (false positive in mtime polling) — feature removed
- Outline panel: scrolling broken and last item bleeding into status bar (missing `flex flex-col` + `min-h-0` chain on the panel)
- TOC links inside markdown body (e.g. `[Q1](#q1)`) not navigating to their headings — explicit click handler added with fuzzy heading-text fallback for non-matching slugs
- New File button doing nothing visible — `hasFile` now considers a blank `Untitled.md` buffer as "open"
- Command palette on the welcome screen exposing Save / Save As / view toggles that wouldn't work without a buffer

### Removed

- Auto-save toggle (UI removed from Settings dropdown, Settings modal, command palette, status bar)
- Focus-mode dimming of non-active editor lines — all lines now render at full opacity (typewriter mode kept)
- External-change polling that was watching the open file's mtime

### Changed

- Wikilink resolution and recent-file existence checks use the existing `get_file_info` Rust command instead of the fs plugin's `stat`

## [0.6.0] - 2026-04-29

### Added — Editor

- Tab / Shift+Tab indent (multi-line aware)
- Auto-pair for `()`, `[]`, `{}`, `` ` ``, `""`, `''` — wraps selection or inserts pair, type-past closer, atomic backspace
- Enter continues lists, blockquotes, and task items
- Markdown formatting shortcuts: Ctrl+B / Ctrl+I / Ctrl+K / Ctrl+/
- Find & Replace (Ctrl+F / Ctrl+H) with regex, case-sensitive, match counter
- Slash commands `/` with 13 block transformations
- Smart paste: URL → link, plain URL → autolink, rich HTML → markdown (Turndown), TSV → GFM table
- Tab navigation inside markdown tables (skips separator, creates rows)
- Formatting toolbar above editor (toggleable)
- Focus mode (dim non-active lines)
- Typewriter mode (caret stays vertically centered)
- Active-line highlight in editor and gutter

### Added — Preview

- Code blocks have a hover-revealed Copy button
- Headings get GitHub-style stable slug IDs and clickable anchor links
- Click-to-zoom image lightbox
- Lazy image loading
- Interactive task checkboxes — toggling writes back to source
- KaTeX math rendering (`$inline$`, `$$block$$`) — lazy-loaded
- Mermaid diagrams (` ```mermaid `) — lazy-loaded
- YAML frontmatter parsed and rendered as a collapsible, editable Properties card
- Wikilinks `[[Foo]]` and `[[Foo|alias]]` clickable in preview

### Added — App

- Split view (Ctrl+\\) with draggable, keyboard-resizable divider
- Bidirectional scroll sync between editor and preview in split mode
- Restore last opened file on launch
- View mode and split ratio persist across sessions
- Recent files list on welcome screen with parent folder, time-ago, remove button; missing files struck through
- New File (Ctrl+N) and Save As (Ctrl+Shift+S)
- External-change detection — banner offers Reload/Keep mine when the file is modified outside MarkLite
- Auto-save toggle (1.5s debounce) with status chip in StatusBar
- Command palette (Ctrl+P) with fuzzy ranking — searches commands, files, headings, toggles
- Settings modal (Ctrl+,) with sidebar navigation and search
- Keyboard cheatsheet modal (`?`)
- Outline pane highlights the heading the cursor is in; filter input for large docs
- AI assist scaffold (Ctrl+J) — Rewrite / Shorten / Expand / Continue / Translate via configurable OpenAI-compatible endpoint (Ollama, llama.cpp, OpenAI, etc.)
- Reading time and character count in StatusBar

### Fixed

- Caret no longer drifts vertically between the textarea and syntax-highlight overlay (font metric alignment, empty-line rendering, rAF-driven scroll sync)
- Paper theme `--text-muted` darkened to pass WCAG AA contrast
- Sidebar panels (FileExplorer, TableOfContents) now trap focus
- Toast errors announce as `role="alert"` / `aria-live="assertive"`
- `prefers-reduced-motion` is respected globally

### Changed

- Visible focus rings on all interactive elements (keyboard focus only)
- Design tokens for radius and spacing in `:root`
- StatusBar replaces inert "UTF-8" with icons next to word count and reading time
- TitleBar shows a hint when no file is open
- Welcome screen lists New File alongside Open File and surfaces Ctrl+P / `?` hints

### Removed

- The hidden off-screen markdown renderer used for export — capture happens directly from the visible preview now

## [0.5.1] - 2026-01-XX

### Added

- Error boundary
- Unsaved-changes protection on close
- Loading state during file open

## [0.1.0] - 2025-01-01

### Added

- Initial release of MarkLite
- Clean markdown preview with live rendering
- Code editor with syntax highlighting
- Three themes: Dark, Light, and Paper
- Five font options: Inter, Merriweather, Lora, Source Serif, Fira Sans
- Three font sizes: Small, Medium, Large
- Keyboard shortcuts (Ctrl+O, Ctrl+S, Ctrl+E)
- Cross-platform support (Windows, macOS, Linux)
- Custom titlebar with window controls
- Settings menu for theme and font customization
- Drag and drop support for markdown files
- Auto-save indicator in status bar
