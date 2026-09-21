#!/usr/bin/env python3
"""Load systemd credentials in memory and start the environment's backup."""

import os
from pathlib import Path

credentials = Path(os.environ["CREDENTIALS_DIRECTORY"])
environment = dict(os.environ)
for setting, filename in (
    ("AWS_ACCESS_KEY_ID", "r2-access-key"),
    ("AWS_SECRET_ACCESS_KEY", "r2-secret-key"),
    ("BACKUP_MONITOR_URL", "backup-monitor-url"),
):
    value = (credentials / filename).read_text().strip()
    if not value:
        raise RuntimeError(f"Missing credential: {filename}")
    environment[setting] = value
environment["RESTIC_PASSWORD_FILE"] = str(credentials / "restic-password")
script = str(Path(__file__).with_name("backup.sh"))
os.execve("/usr/bin/bash", ["bash", script], environment)
