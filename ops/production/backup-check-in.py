#!/usr/bin/env python3
"""Bounded, redacted check-in; monitor credentials never enter curl/process argv."""
import json
import os
import sys
import time
import urllib.request


def main():
    endpoint = os.environ.get("BACKUP_MONITOR_ENDPOINT", "")
    if not endpoint:
        return 0
    token = os.environ.get("BACKUP_MONITOR_TOKEN", "")
    if not endpoint.startswith("https://") or not token:
        print("Backup monitoring configuration missing or invalid", file=sys.stderr)
        return 1
    payload = {
        "runId": os.environ["BACKUP_RUN_ID"],
        "startedAt": int(os.environ["BACKUP_STARTED_AT"]),
        "status": sys.argv[1],
    }
    if payload["status"] == "failed":
        payload["stage"] = sys.argv[2]
    for attempt in range(2):
        try:
            request = urllib.request.Request(
                endpoint, data=json.dumps(payload).encode(), method="POST",
                headers={
                    "Authorization": "Bearer " + token,
                    "Content-Type": "application/json",
                    # Cloudflare rejects the default Python-urllib signature (1010).
                    "User-Agent": "BAM-Backup-Monitor/1.0",
                },
            )
            # Disable redirects so the monitor token cannot be forwarded elsewhere.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            with urllib.request.build_opener(NoRedirect).open(request, timeout=5) as response:
                if response.status == 204:
                    return 0
        except Exception:
            pass  # Exceptions may contain credential-bearing URLs: never print them.
        if attempt == 0:
            time.sleep(1)
    print("Backup check-in failed; external freshness alert remains active", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
