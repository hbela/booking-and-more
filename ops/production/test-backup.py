"""Run on Linux: python3 ops/production/test-backup.py. No network or database access."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


MOCK = r'''#!/usr/bin/env python3
import os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['MOCK_LOG'], 'a') as log:
    log.write(name + ' ' + ' '.join(args) + '\n')
if name == 'docker':
    if args[0] == 'ps':
        print(os.environ.get('MOCK_CONTAINERS', 'database-id'), end='')
    else:
        print('mock dump')
        sys.exit(int(os.environ.get('MOCK_DUMP_EXIT', '0')))
elif name == 'restic':
    if args[0] == 'backup':
        sys.stdin.read()
    if args[0] == os.environ.get('MOCK_RESTIC_FAIL'):
        sys.exit(1)
elif name == 'curl':
    sys.exit(int(os.environ.get('MOCK_CHECKIN_EXIT', '0')))
'''


class BackupTests(unittest.TestCase):
    def run_backup(self, **overrides):
        with tempfile.TemporaryDirectory(prefix="bam-backup-test-") as directory:
            root = Path(directory)
            for name in ("docker", "restic", "curl", "flock"):
                executable = root / name
                executable.write_text(MOCK)
                executable.chmod(0o700)
            # Isolate the lock path too: these tests never touch the operator's lock.
            script = Path(__file__).with_name("backup.sh").read_text()
            script = script.replace("/run/lock/${BACKUP_TAG}.lock", str(root / "backup.lock"))
            target = root / "backup.sh"
            target.write_text(script)
            (root / "backup-check-in.py").write_text(
                "import os, pathlib, sys\n"
                "with open(os.environ['MOCK_LOG'], 'a') as log:\n"
                "    log.write('check-in ' + ' '.join(sys.argv[1:]) + '\\n')\n"
                "sys.exit(int(os.environ.get('MOCK_CHECKIN_EXIT', '0')))\n"
            )
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "POSTGRES_COMPOSE_PROJECT": "isolated-test",
                "RESTIC_REPOSITORY": "unused",
                "RESTIC_PASSWORD_FILE": "unused",
                "BACKUP_MONITOR_URL": "https://monitor.invalid",
                "MOCK_LOG": str(root / "calls"),
                **overrides,
            }
            result = subprocess.run(["bash", str(target)], env=env, capture_output=True)
            return result.returncode, (root / "calls").read_text()

    def test_success_promotes_snapshot_before_retention_and_heartbeat(self):
        code, calls = self.run_backup()
        self.assertEqual(code, 0)
        self.assertIn("--tag bam-production-pending-", calls)
        self.assertIn("--set bam-production", calls)
        self.assertLess(calls.index("restic tag"), calls.index("restic forget"))
        self.assertLess(calls.index("restic forget"), calls.index("curl"))

    def test_missing_or_ambiguous_database_refuses_dump(self):
        for containers in ("", "one\ntwo\n"):
            with self.subTest(containers=containers):
                code, calls = self.run_backup(MOCK_CONTAINERS=containers)
                self.assertNotEqual(code, 0)
                self.assertNotIn("docker exec", calls)
                self.assertNotIn("curl", calls)

    def test_staging_uses_its_own_snapshot_tag(self):
        code, calls = self.run_backup(BACKUP_TAG="bam-staging")
        self.assertEqual(code, 0)
        self.assertIn("--set bam-staging", calls)
        self.assertIn("restic forget --tag bam-staging", calls)
        self.assertNotIn("bam-production", calls)

    def test_failed_dump_never_promotes_snapshot(self):
        code, calls = self.run_backup(MOCK_DUMP_EXIT="1")
        self.assertNotEqual(code, 0)
        self.assertNotIn("restic tag", calls)
        self.assertNotIn("curl", calls)

    def test_storage_failure_never_sends_success(self):
        for operation in ("backup", "tag", "forget"):
            with self.subTest(operation=operation):
                code, calls = self.run_backup(MOCK_RESTIC_FAIL=operation)
                self.assertNotEqual(code, 0)
                self.assertNotIn("curl", calls)

    def test_custom_checkins_surround_successful_pipeline(self):
        code, calls = self.run_backup(BACKUP_MONITOR_ENDPOINT="https://monitor.invalid/v1/check-ins/bam-staging")
        self.assertEqual(code, 0)
        self.assertLess(calls.index("check-in started"), calls.index("docker exec"))
        self.assertLess(calls.index("restic forget"), calls.index("check-in succeeded"))
        self.assertNotIn("check-in failed", calls)

    def test_custom_checkins_classify_failed_pipeline_stages(self):
        for operation, stage in (("backup", "dump_upload"), ("tag", "promotion"), ("forget", "retention")):
            with self.subTest(operation=operation):
                code, calls = self.run_backup(BACKUP_MONITOR_ENDPOINT="https://monitor.invalid", MOCK_RESTIC_FAIL=operation)
                self.assertNotEqual(code, 0)
                self.assertIn("check-in failed " + stage, calls)
                self.assertNotIn("check-in succeeded", calls)

    def test_custom_checkin_dump_and_database_failures(self):
        for overrides, stage in (({"MOCK_DUMP_EXIT": "1"}, "dump_upload"), ({"MOCK_CONTAINERS": ""}, "database")):
            code, calls = self.run_backup(BACKUP_MONITOR_ENDPOINT="https://monitor.invalid", **overrides)
            self.assertNotEqual(code, 0)
            self.assertIn("check-in failed " + stage, calls)
            self.assertNotIn("check-in succeeded", calls)

    def test_checkin_failure_never_blocks_or_disguises_backup(self):
        code, calls = self.run_backup(BACKUP_MONITOR_ENDPOINT="https://monitor.invalid", MOCK_CHECKIN_EXIT="1")
        self.assertEqual(code, 0)
        self.assertIn("restic forget", calls)
        self.assertIn("check-in succeeded", calls)
        code, calls = self.run_backup(BACKUP_MONITOR_ENDPOINT="https://monitor.invalid", MOCK_CHECKIN_EXIT="1", MOCK_DUMP_EXIT="1")
        self.assertNotEqual(code, 0)
        self.assertNotIn("check-in succeeded", calls)

    def test_backup_runs_without_monitoring_configuration(self):
        code, calls = self.run_backup(BACKUP_MONITOR_URL="")
        self.assertEqual(code, 0)
        self.assertIn("restic forget", calls)
        self.assertNotIn("curl", calls)


if __name__ == "__main__":
    unittest.main()
