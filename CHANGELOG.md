# Changelog

## 0.1.0 (2026-11-17)

First release: the Showcase mode of DataLab Web, moved out of DataLab Web into a static host page served next to it (<https://datalab-platform.com/web-showcase/>).

### Added

- Host page embedding DataLab Web in a full-window, same-origin iframe (`app` parameter, default `../web/`; another origin is refused with an explanation), with the overlays drawn above it: captions, title, boot and end cards, fake pointer with click ripples, spotlight, persistent label.
- Demos `w1` (interactive imaging), `w2` (notebooks and macros typed live), `w3` (DataLab desktop capsule inspected, opened, replayed and reviewed) and `w4` (AI assistant, replayed session played by the simulated AI provider of DataLab Web), plus one generated demo per application plugin listed by the Applications window of DataLab Web.
- Kiosk parameters `demos`, `skip`, `loop`, `speed`, `lang`, `reload`, `close`, `controls` and `app`; operator hotkeys, on the host page and in DataLab Web.
- Welcome menu, opened by the showcase without any playing parameter, like the Showcase mode dialog of DataLab desktop: demos to play (those of the application plugins added once DataLab Web lists them, while it starts behind the menu), loop and page reload period, pace, full screen and language, remembered in the browser. The kiosk link of these choices can be copied, and becomes the page URL once the demos start (closes [Issue #7](https://github.com/DataLab-Platform/web-showcase/issues/7)).
- Finer operator controls while the demos play: F9 pauses at the next pause of the demo, or at once when pressed again; Shift+F12 stops after the current demo, or at once when pressed again; Right arrow (or Page Down) plays fast up to the next step, End skips to the next demo, Home restarts the demo, + and − change the pace live. A discreet control bar, shown when the operator moves the mouse, offers the same actions with the progress of the playlist (demo, step, elapsed time); `controls=0` or the welcome menu hides it on a booth (closes [Issue #10](https://github.com/DataLab-Platform/web-showcase/issues/10)).
- DataLab Web is started again when it fails to start; a loop restarts by itself after an error, and a `close=1` window always closes.
- The visitor's state is restored after the demos: theme, AI Assistant settings (byte for byte), recent notebooks and macros, capsule revisions and AI conversations.
- Check harness (`npm run showcase:check`) serving the showcase and a DataLab Web build under the same origin, continuous integration (including a weekly run against DataLab Web `develop`) and deployment to GitHub Pages.
- `scripts/gen_showcase_capsule.py`, generating the capsule of `w3` with an installed DataLab desktop.

### Fixed

- **Transitions between demos:** the next demo now waits for DataLab Web's new workspace to be ready instead of starting while the previous workspace is still being cleared. Older versions without the completion signal are reloaded (fixes [Issue #4](https://github.com/DataLab-Platform/web-showcase/issues/4)).
