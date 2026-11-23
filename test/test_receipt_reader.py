import json
import runpy
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

receipt = runpy.run_path(str(Path(__file__).resolve().parents[1] / "infra/receipt-reader.py"))["receipt"]


class ReceiptTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.key, self.attempt, self.run = "job-compose", "attempt", "run_" + "a" * 32
        self.session = "hub-" + self.key
        self.bookings = sqlite3.connect(self.root / "runs_idempotency.db")
        self.admissions = sqlite3.connect(self.root / "state.db")
        self.addCleanup(self.bookings.close)
        self.addCleanup(self.admissions.close)
        with self.bookings as b, self.admissions as a:
            b.execute("CREATE TABLE run_idempotency(scope,idempotency_key,run_id,status_json,acknowledged_at,retention_until,updated_at)")
            a.execute("CREATE TABLE session_admissions(principal_id,target_session_id,request_id,payload_json)")
            status = {"run_id": self.run, "session_id": self.session, "status": "completed"}
            b.execute("INSERT INTO run_idempotency VALUES('actor',?,?,?,NULL,0,?)",
                      (self.key, self.run, json.dumps(status), time.time()))
            payload = {"api_turn_v1": {"run_owner_scope": "actor"}, "text": "AI_HUB_ROUTE attempt\ninput"}
            a.execute("INSERT INTO session_admissions VALUES('api',?,?,?)",
                      (self.session, self.run, json.dumps(payload)))

    def lookup(self, scope="actor", attempt="attempt"):
        return receipt(self.root, scope, self.key, attempt)

    def test_exact_scope_phase_and_attempt(self):
        self.assertEqual(self.lookup(), {"result":"matched", "run_id":self.run, "session_id":self.session})
        self.assertEqual(self.lookup(scope="other"), {"result":"missing"})
        self.assertEqual(self.lookup(attempt="another"), {"result":"mismatch"})
        with self.admissions as a:
            a.execute("UPDATE session_admissions SET request_id='another-run'")
        self.assertEqual(self.lookup(), {"result":"mismatch"})

    def test_multiple_admissions_never_select_first(self):
        with self.admissions as a:
            a.execute("INSERT INTO session_admissions SELECT principal_id,target_session_id,'other',payload_json FROM session_admissions")
        self.assertEqual(self.lookup(), {"result":"ambiguous"})

    def test_expired_or_absent_receipt(self):
        with self.bookings as b:
            b.execute("UPDATE run_idempotency SET updated_at=?", (time.time()-2*86400,))
        self.assertEqual(self.lookup(), {"result":"expired"})
        with self.bookings as b:
            b.execute("DELETE FROM run_idempotency")
        self.assertEqual(self.lookup(), {"result":"missing"})


if __name__ == "__main__":
    unittest.main()
