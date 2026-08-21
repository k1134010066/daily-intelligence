"""Run MediaCrawler with local media downloads enabled.

This wrapper keeps the upstream crawler untouched while enabling cover/image
downloads for the Daily Intelligence app.
"""

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MEDIA_CRAWLER_ROOT = Path(os.environ.get("MEDIACRAWLER_ROOT", PROJECT_ROOT / "vendor" / "MediaCrawler")).expanduser().resolve()
sys.path.insert(0, str(MEDIA_CRAWLER_ROOT))

import config  # noqa: E402

config.ENABLE_GET_MEIDAS = True

from main import async_cleanup, main  # noqa: E402
from tools.app_runner import run  # noqa: E402


if __name__ == "__main__":
    run(main, async_cleanup, cleanup_timeout_seconds=15.0)
