# Changelog

## 0.1.0 (unreleased)

First release: the Showcase mode of DataLab Web, moved out of DataLab Web into a static host page served next to it (<https://datalab-platform.com/web-showcase/>).

### Added

- Host page embedding DataLab Web in a full-window, same-origin iframe (`app` parameter, default `../web/`; another origin is refused with an explanation), with the overlays drawn above it: captions, title, boot and end cards, fake pointer with click ripples, spotlight, persistent label.
- Demos `w1` (interactive imaging), `w2` (notebooks and macros typed live), `w3` (DataLab desktop capsule inspected, opened, replayed and reviewed) and `w4` (AI assistant, replayed session played by the simulated AI provider of DataLab Web), plus one generated demo per application plugin listed by the Applications window of DataLab Web.
- Kiosk parameters `demos`, `loop`, `speed`, `lang`, `reload`, `close` and `app`; operator hotkeys F9 (pause) and Shift+F12 (stop/resume), on the host page and in DataLab Web.
- The visitor's state is restored after the demos: theme, AI Assistant settings (byte for byte), recent notebooks and macros, capsule revisions and AI conversations.
- Check harness (`npm run showcase:check`) serving the showcase and a DataLab Web build under the same origin, continuous integration (including a weekly run against DataLab Web `develop`) and deployment to GitHub Pages.
- `scripts/gen_showcase_capsule.py`, generating the capsule of `w3` with an installed DataLab desktop.
