"""Where a load test keeps its run files: simulator state, logs, results.

Outside the repository by default, so a run can never be committed by mistake.
Set SCALE_RUN_DIR to keep a run's files somewhere particular.
"""

from __future__ import annotations

import os
from pathlib import Path


def run_dir() -> Path:
    path = Path(os.environ.get("SCALE_RUN_DIR",
                               Path.home() / ".cache" / "solarcms-scale"))
    path.mkdir(parents=True, exist_ok=True)
    return path
