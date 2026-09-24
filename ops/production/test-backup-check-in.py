"""Network-free tests for the actual HTTP helper; also runs on Windows."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location("checkin", Path(__file__).with_name("backup-check-in.py"))
checkin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkin)


class CheckInTests(unittest.TestCase):
    def invoke(self, opener, status="started", token="private-token"):
        with patch.dict(os.environ, {
            "BACKUP_MONITOR_ENDPOINT": "https://monitor.example/v1/check-ins/bam-staging",
            "BACKUP_MONITOR_TOKEN": token,
            "BACKUP_RUN_ID": "run-1", "BACKUP_STARTED_AT": "100",
        }), patch("sys.argv", ["checkin", status, "dump_upload"]), patch.object(checkin.urllib.request, "build_opener", return_value=opener), patch.object(checkin.time, "sleep"), contextlib.redirect_stderr(io.StringIO()) as output:
            return checkin.main(), output.getvalue()

    def test_authenticated_success_uses_header_and_bounded_timeout(self):
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.status = 204
        code, _ = self.invoke(opener)
        self.assertEqual(code, 0)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer private-token")
        self.assertEqual(request.get_header("User-agent"), "BAM-Backup-Monitor/1.0")
        self.assertNotIn("private-token", request.full_url)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 5)

    def test_failures_retry_twice_and_redact_exception(self):
        opener = MagicMock()
        opener.open.side_effect = RuntimeError("private-token https://credential-url")
        code, output = self.invoke(opener, "failed")
        self.assertEqual(code, 1)
        self.assertEqual(opener.open.call_count, 2)
        self.assertNotIn("private-token", output)
        self.assertNotIn("credential-url", output)

    def test_missing_token_does_not_send(self):
        opener = MagicMock()
        code, _ = self.invoke(opener, token="")
        self.assertEqual(code, 1)
        opener.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
