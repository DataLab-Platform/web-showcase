# DataLab Web Showcase

Unattended live demos of [DataLab Web](https://datalab-platform.com/web/), for conference booths, kiosks and the "web interlude" of the DataLab desktop showcase.

The showcase is a static page that shows DataLab Web full screen and plays scripted demos on top of it: a pointer glides to each button, menus open, code is typed live, captions explain what happens. Everything really runs in the browser (Python, NumPy, SciPy and Sigima compiled to WebAssembly): the demos use the real DataLab Web, as a visitor would.

**Open it:** <https://datalab-platform.com/web-showcase/>

## Kiosk mode

On a booth screen, open the showcase full screen and let it loop:

```text
chrome --kiosk "https://datalab-platform.com/web-showcase/?loop=1&lang=fr"
```

With Microsoft Edge:

```text
msedge --kiosk "https://datalab-platform.com/web-showcase/?loop=1&lang=fr" --edge-kiosk-type=fullscreen
```

The first start downloads the Python runtime of DataLab Web (about a minute on a fresh browser, a boot card is shown meanwhile); the next ones use the browser cache. In a loop, the page reloads itself every 5 loops to start afresh. If DataLab Web fails to start (e.g. a download failing on a busy network), the showcase tries again; if it still fails, a loop restarts the page by itself a minute later.

## Demos

The playlist is `w1`, the first application plugin, `w2`, the second application plugin, `w3`, `w4` (then the other application plugins, if any), followed by an end card showing where to try DataLab Web and DataLab desktop.

| Demo              | Content                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `w1`              | **Interactive imaging, zero install**: a synthetic radiograph (non-destructive testing) opened from the File menu, live cross profiles, a defect measured on its profile (FWHM), a region of interest and its statistics, Canny edges with a live preview, the dark theme. |
| `w2`              | **Python in the browser**: a notebook (Markdown and code cells typed live, a chirp and its FFT sent to DataLab), then a macro averaging noisy signals with DataLab's own processing.                                                                                       |
| `w3`              | **Verifiable provenance**: a capsule exported by DataLab desktop, inspected ("Intact"), opened (images and provenance restored, Provenance tab), replayed locally (every step "Exact"), then reviewed: the review cites the replay report.                                 |
| `w4`              | **AI assistant (replayed session)**: a request in plain language, a macro proposed and approved, run on real data, and the assistant summing up the real result. Only the assistant's answers are scripted, as a permanent label states on screen.                         |
| `app:<plugin id>` | **Application plugins** (e.g. `app:org.datalab.camera-characterization`): generated from the Applications window of DataLab Web — the application, up to two of its examples run with their method, and the objects and result tables they produce.                        |

## URL parameters

| Parameter | Values                                    | Default   | Effect                                                                                                    |
| --------- | ----------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `demos`   | `all`, or a list such as `w1,w3,app:<id>` | `all`     | Demos to play, in playlist order.                                                                         |
| `loop`    | `1`                                       | one pass  | Play the demos again and again.                                                                           |
| `speed`   | number, e.g. `0.7` (faster) or `1.4`      | `1`       | Pace of every pause and pointer motion. `0` selects the check mode (no pauses, no overlays, single pass). |
| `lang`    | `en`, `fr`                                | see below | Language of the captions, also passed to DataLab Web.                                                     |
| `reload`  | number of loops, `0` for never            | `5`       | Reload the page (and DataLab Web) every N loops, with `loop=1`.                                           |
| `close`   | `1`                                       | off       | One pass, the end card, then close the window (DataLab desktop interlude).                                |
| `app`     | URL of DataLab Web, **same origin**       | `../web/` | DataLab Web to drive, e.g. a preview deployment.                                                          |

Without `lang`, the showcase uses the language chosen in DataLab Web, else the browser language.

## Operator hotkeys

While the demos play, the real mouse is held off (a click shows a "live demo" badge) and the keyboard keeps a few hotkeys, whether the focus is on the showcase or in DataLab Web:

| Key       | Effect                                                                                       |
| --------- | -------------------------------------------------------------------------------------------- |
| F9        | Pause or resume.                                                                             |
| Shift+F12 | Stop after the current demo and leave DataLab Web to the visitors; press it again to resume. |
| Esc       | Quit the showcase, once stopped.                                                             |

## The visitor's DataLab Web is left as it was

The showcase and DataLab Web share the same origin, hence the same browser storage. Whatever a demo changes is restored when it ends:

- the theme (light/dark) and the AI Assistant settings, input history and panel state, byte for byte (`w4` selects the simulated AI provider of DataLab Web only while it plays, then DataLab Web is reloaded so that the visitor's settings apply again);
- the notebooks and macros created by `w2` are closed and removed from the "Recent…" lists;
- the capsule revision recorded by `w3` and the conversation of `w4` are removed from the history of the browser.

Between two demos, the workspace starts afresh, as for a visitor. File > New workspace clears it and restarts the macro and notebook workers without restarting the main Python runtime; the next demo waits until the new workspace is ready. Older DataLab Web versions are reloaded behind the next title card instead (the browser cache makes this a matter of seconds to a few tens of seconds, with the boot status shown on the card).

## Requirements

- **Same origin.** The showcase drives DataLab Web through its document, which browsers only allow for a page of the same origin (scheme, host and port). On datalab-platform.com, `/web-showcase/` and `/web/` share it. The `app` parameter is refused for another origin.
- **DataLab Web 0.11.1 or later**: the first release with the automation hooks the showcase relies on (`data-action-id` on the menu entries, `data-plugin-id` in the Applications window), besides its regular selectors and ARIA roles. An older DataLab Web shows an explicit message.
- A Chromium-based browser (Chrome, Edge) is recommended: it is the one the demos are tested with.

## DataLab desktop interlude

The DataLab desktop showcase (the `datalab-showcase` plugin) can play the web demos between its own ones: it opens

```text
https://datalab-platform.com/web-showcase/?demos=all&close=1
```

in a dedicated application window (`msedge --app=<url>` or `chrome --app=<url>`), which closes itself after one pass, its end card shown — or after a few seconds of error message if DataLab Web cannot start, so that DataLab desktop never waits for it. A browser closes by script only such windows (or windows opened by a script): in a regular tab, a "You can close this window" badge is shown instead.

## Local use (without datalab-platform.com)

Serve a build of the showcase and a build of DataLab Web from one server, in folders named like on the website:

```text
some-folder/
├── web/            (DataLab Web build: its "dist" folder)
└── web-showcase/   (showcase build: this repository's "dist" folder)
```

```text
cd some-folder
python -m http.server 8000
```

then open <http://localhost:8000/web-showcase/?loop=1>. The server of this repository does the same without copying anything:

```text
npm run build
node scripts/serve.mjs --port 4190 --web-dist ../DataLab-Web/dist
```

DataLab Web downloads its Python runtime (Pyodide and packages) from public CDNs: run the showcase once with an Internet connection, the browser cache serves it afterwards.

## Development

```text
npm install
npm run lint
npm run format:check
npm run i18n:check     # French translations of the captions
npm test               # unit tests (Vitest)
npm run build          # static files in dist/
```

**Check harness.** `npm run showcase:check` serves `dist/` under `/web-showcase/` and a DataLab Web build under `/web/` (the folder given by `DATALAB_WEB_DIST`, default `.datalab-web/dist`), then plays every demo in check mode and checks that they all pass and that the visitor's AI settings are unchanged. `npm run showcase:headed` plays them on screen (`SHOWCASE_SPEED`, `SHOWCASE_LANG`, `SHOWCASE_DEMOS`).

```text
git clone https://github.com/DataLab-Platform/web .datalab-web
npm --prefix .datalab-web ci
npm --prefix .datalab-web run build
npm run build
npx playwright install chromium
npm run showcase:check
```

**Continuous integration.** Every push and pull request runs the checks above against DataLab Web `develop` (or the ref of the `DATALAB_WEB_REF` repository variable); a weekly run reports regressions of DataLab Web `develop` without blocking anything; pushes to `main` deploy `dist/` to GitHub Pages.

**Writing demos.** A demo (`src/scenarios/`) is a `ShowcaseScenario` driving DataLab Web through the `ShowcaseContext` of `src/engine.ts`: `click`, `clickMenuPath("File", "file.capsule")`, `type`, `press`, `drag`, `say`, `spotlight`, `checkpoint`… Captions are English keys of `t()`, translated in `src/locales/fr.json`. The demos act through the user interface of DataLab Web only (menus by `data-action-id`, regular selectors and ARIA roles); its remote-control bridge (`allowedOrigins`, the showcase origin) only serves read-only checks of the workspace content.

**Capsule of `w3`.** `public/showcase-capsule.dlcapsule` is a genuine capsule exported by DataLab desktop. To generate it again, with a Python environment where DataLab desktop is installed (`pip install datalab-platform`):

```text
python scripts/gen_showcase_capsule.py
```

## License

BSD 3-Clause, see [LICENSE](LICENSE).
