"""Run on Linux: python3 ops/production/test-restore-rehearsal.py. No network or database access.

The three refusals were first exercised by hand in the 2026-10-17 drill
(docs/staging-db-restore-test-plan.md, T9); these keep them tested.
"""

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
if name == 'restic':
    if os.environ.get('MOCK_RESTIC_FAIL'):
        print('Fatal: wrong password or no key found', file=sys.stderr)
        sys.exit(1)
    print('mock dump')
elif name == 'docker':
    sys.stdin.read()
    sys.exit(int(os.environ.get('MOCK_RESTORE_EXIT', '0')))
'''

VALID = {
    "RESTIC_REPOSITORY": "unused",
    "RESTIC_PASSWORD_FILE": "unused",
    "RESTORE_CONTAINER": "drill-postgres",
    "RESTORE_DATABASE": "bam_rehearsal_test",
    "RESTORE_USER": "postgres",
    "SNAPSHOT_ID": "4a6b43a9",
}


class RestoreRehearsalTests(unittest.TestCase):
    def run_restore(self, **overrides):
        with tempfile.TemporaryDirectory(prefix="bam-restore-test-") as directory:
            root = Path(directory)
            for name in ("docker", "restic"):
                executable = root / name
                executable.write_text(MOCK)
                executable.chmod(0o700)
            (root / "calls").write_text("")
            env = {
                **{k: v for k, v in os.environ.items() if k not in VALID},
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "MOCK_LOG": str(root / "calls"),
                **VALID,
                **overrides,
            }
            env = {k: v for k, v in env.items() if v is not None}
            script = Path(__file__).with_name("restore-rehearsal.sh")
            result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)
            return result.returncode, (root / "calls").read_text(), result.stdout + result.stderr

    def test_success_streams_the_selected_snapshot_into_the_named_database(self):
        code, calls, output = self.run_restore()
        self.assertEqual(code, 0, output)
        self.assertIn("restic dump 4a6b43a9 database.dump", calls)
        self.assertIn("pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d bam_rehearsal_test", calls)
        self.assertIn("Restore completed", output)

    def test_refuses_a_database_outside_the_rehearsal_namespace_before_reading_backups(self):
        for name in ("staging_copy", "booking_and_more", "rehearsal_bam_x"):
            with self.subTest(name=name):
                code, calls, output = self.run_restore(RESTORE_DATABASE=name)
                self.assertNotEqual(code, 0)
                self.assertIn("must start with bam_rehearsal_", output)
                self.assertEqual(calls, "")

    def test_refuses_to_guess_missing_configuration(self):
        for missing in VALID:
            with self.subTest(missing=missing):
                code, calls, _ = self.run_restore(**{missing: None})
                self.assertNotEqual(code, 0)
                self.assertEqual(calls, "")

    def test_wrong_repository_password_fails_the_restore(self):
        code, _, output = self.run_restore(MOCK_RESTIC_FAIL="1")
        self.assertNotEqual(code, 0)
        self.assertNotIn("Restore completed", output)

    def test_occupied_target_fails_and_is_never_cleaned(self):
        # pg_restore --exit-on-error stops at the first existing object; the
        # script must surface that, and must never ask for --clean or a drop.
        code, calls, output = self.run_restore(MOCK_RESTORE_EXIT="1")
        self.assertNotEqual(code, 0)
        self.assertNotIn("Restore completed", output)
        for destructive in ("--clean", "--if-exists", "dropdb", "DROP DATABASE", "--create"):
            self.assertNotIn(destructive, calls)


if __name__ == "__main__":
    unittest.main()
