"""Generate the capsule of the W3 demo: ``public/showcase-capsule.dlcapsule``.

The W3 demo of the showcase (capsule and provenance) opens a genuine capsule
of DataLab desktop, exported by DataLab desktop itself with the image chain of
the DataLab desktop showcase::

    Cells (raw 256x256 8-bit image of 14 noisy cells)
      -> Total variation denoising (weight 0.1)  -> Sobel filter (edges)
      -> Blob detection (LoG) on the denoised image: 14 blobs

The History of the chain is recorded in the capsule. Each operation is
qualified for an exact replay, deterministic and available in Pyodide (no
OpenCV): DataLab Web replays each of them with the verdict "Exact". Before
writing the capsule, the script opens it again in DataLab desktop and replays
each activity (verdicts printed).

Requirements: a Python environment with an installed DataLab desktop
(``pip install datalab-platform``, with its Qt bindings), which provides
Sigima and DataLab-Capsule. Nothing is written to the DataLab user
configuration (History record mode and capsule revisions are temporary). From
the web-showcase folder::

    python scripts/gen_showcase_capsule.py [--output <file>]

then check the demo (``npm run build && npm run showcase:check``) and commit
the new capsule.
"""

from __future__ import annotations

import argparse
import os
import os.path as osp
import shutil
import sys
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "public" / "showcase-capsule.dlcapsule"
NAME = "Cells analysis"
DESCRIPTION = (
    "DataLab desktop showcase: raw image of cells, total variation denoising, "
    "Sobel edges and blob detection (LoG)"
)
#: Raw image of cells
CELLS_TITLE = "Cells"
CELLS_SIZE = 256
CELLS_COUNT = 14
DENOISE_WEIGHT = 0.1


def create_cells_image(seed: int = 7):
    """Create a raw image of cells: bright disks on a background, with noise

    Args:
        seed: Seed of the random generator (the image is reproducible)

    Returns:
        8-bit image of :data:`CELLS_COUNT` cells
    """
    # pylint: disable=import-outside-toplevel
    import numpy as np
    import sigima.objects

    size = CELLS_SIZE
    rng = np.random.default_rng(seed)
    yy, xx = np.indices((size, size), dtype=float)
    data = 20.0 + 25.0 * xx / size
    cells: list[tuple[float, float, float]] = []
    while len(cells) < CELLS_COUNT:
        radius = rng.uniform(6.0, 17.0)
        x0, y0 = rng.uniform(radius + 8.0, size - radius - 8.0, 2)
        if all(np.hypot(x0 - x, y0 - y) > radius + r + 6.0 for x, y, r in cells):
            cells.append((x0, y0, radius))
    for x0, y0, radius in cells:
        distance = np.hypot(xx - x0, yy - y0)
        data += 150.0 / (1.0 + np.exp((distance - radius) / 1.5))
    data += rng.normal(0.0, 22.0, data.shape)
    data = np.clip(data, 0.0, 255.0).astype(np.uint8)
    return sigima.objects.create_image(CELLS_TITLE, data)


def count_blobs(obj) -> int:
    """Return the number of blobs detected on an image (0 without blobs)"""
    # pylint: disable=import-outside-toplevel
    from datalab.adapters_metadata import GeometryAdapter

    for adapter in GeometryAdapter.iterate_from_obj(obj):
        if adapter.result.func_name == "blob_log":
            return len(adapter.result.coords)
    return 0


@contextmanager
def recording_history(win) -> Generator[None, None, None]:
    """Record the History within the context (record mode restored afterwards)"""
    action = win.historypanel.ui.actions["record"]
    previous = action.isChecked()
    action.setChecked(True)
    try:
        yield
    finally:
        action.setChecked(previous)


@contextmanager
def temporary_revisions(win, folder: str) -> Generator[None, None, None]:
    """Keep the capsule revisions seen within the context in a temporary store"""
    # pylint: disable=import-outside-toplevel
    from datalab.capsulestore import RevisionStore

    capsuleio = win.capsuleio
    previous = capsuleio.revisions
    capsuleio.revisions = RevisionStore(osp.join(folder, "revisions"))
    try:
        yield
    finally:
        capsuleio.revisions = previous


def build_chain(win):
    """Build the image chain: raw image, denoising, edges and blob detection

    Returns:
        Denoised image (with the detected blobs)
    """
    # pylint: disable=import-outside-toplevel
    import sigima.proc.image as sipi

    panel = win.imagepanel
    win.set_current_panel("image")
    raw = create_cells_image()
    win.add_object(raw)
    processor = panel.processor
    processor.run_feature(
        "denoise_tv", sipi.DenoiseTVParam.create(weight=DENOISE_WEIGHT)
    )
    denoised = panel.objview.get_current_object()
    if denoised is raw:
        raise AssertionError("Denoising created no image")
    processor.run_feature("sobel")
    if panel.objview.get_current_object() is denoised:
        raise AssertionError("Edge detection created no image")
    panel.objview.select_objects([denoised])
    processor.run_feature(
        "blob_log",
        sipi.BlobLOGParam.create(
            min_sigma=4.0, max_sigma=13.0, threshold_rel=0.2, overlap=0.5
        ),
    )
    blobs = count_blobs(denoised)
    if blobs != CELLS_COUNT:
        raise AssertionError(f"{blobs} blobs detected, {CELLS_COUNT} expected")
    return denoised


def generate(output: Path) -> None:
    """Build the image chain in DataLab desktop and export it as a capsule

    Args:
        output: Capsule file name

    Raises:
        AssertionError: If the capsule is not intact or does not replay exactly
         in DataLab desktop
    """
    # pylint: disable=import-outside-toplevel
    from datalab.config import Conf, ensure_initialized
    from datalab.env import execenv
    from datalab.gui.main import DLMainWindow
    from datalab.utils.qthelpers import datalab_app_context
    from datalab_capsule import exchange

    ensure_initialized(load_user_config=False)
    execenv.unattended = True
    output.parent.mkdir(parents=True, exist_ok=True)
    with (
        tempfile.TemporaryDirectory(prefix="web-showcase-capsule-") as folder,
        Conf.process_isolation_enabled.context(False),
        datalab_app_context(exec_loop=False, enable_logs=False),
    ):
        win = DLMainWindow(console=False)
        # Actions are enabled from the selection of a shown window (offscreen)
        win.show()
        try:
            with recording_history(win), temporary_revisions(win, folder):
                build_chain(win)
                capsule = osp.join(folder, output.name)
                fingerprint = win.export_capsule(
                    capsule, name=NAME, description=DESCRIPTION
                )
                with open(capsule, "rb") as file:
                    inspection = exchange.inspect_capsule(file.read())
                if not inspection["integrity"]["valid"]:
                    raise AssertionError(f"Capsule {capsule} is not intact")
                history = len(win.historypanel)
                win.reset_all()
                win.open_capsule(capsule)
                verdicts = {}
                for activity in win.provenance.ledger.activities:
                    operation = activity["call"]["operation"]["id"]
                    report = win.verify_provenance_activity(activity["activity_id"])
                    verdicts[operation] = report["verdict"]
            if set(verdicts.values()) != {"exact"}:
                raise AssertionError(f"Capsule not replayed exactly: {verdicts}")
            shutil.move(capsule, output)
        finally:
            win.set_modified(False)
            win.close()
    size = output.stat().st_size
    print(f"Capsule: {output} ({size / 1024:.0f} KiB)")
    print(f"Fingerprint: {fingerprint}")
    print(f"History actions: {history}")
    for operation, verdict in verdicts.items():
        print(f"  {operation}: {verdict}")


def main() -> int:
    """Generate the capsule of the W3 demo

    Returns:
        Exit code
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT,
        help=f"capsule file to write (default: {OUTPUT})",
    )
    args = parser.parse_args()
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    try:
        # pylint: disable=import-outside-toplevel,unused-import
        import datalab.gui.main  # noqa: F401
        import datalab_capsule  # noqa: F401
    except ImportError as error:
        print(
            f"DataLab desktop is required ({error}): run this script with a "
            "Python environment where DataLab is installed "
            "(pip install datalab-platform).",
            file=sys.stderr,
        )
        return 1
    generate(args.output.resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
