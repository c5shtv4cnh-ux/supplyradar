import copy
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "backend"))
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

from supplyradar import aws, config, db  # noqa: E402


class MemoryStore:
    """In-memory stand-in for db.Store with the same methods."""

    def __init__(self):
        self.items = {}

    def get(self, pk, sk):
        item = self.items.get((pk, sk))
        return copy.deepcopy(item) if item else None

    def put(self, item, if_absent=False):
        key = (item["PK"], item["SK"])
        if if_absent and key in self.items:
            raise db.AlreadyExists(item["SK"])
        self.items[key] = copy.deepcopy(item)

    def _sorted(self, pk):
        return sorted(((k[1], v) for k, v in self.items.items() if k[0] == pk), key=lambda kv: kv[0])

    def query_prefix(self, pk, prefix, newest_first=False, limit=None):
        rows = [copy.deepcopy(v) for sk, v in self._sorted(pk) if sk.startswith(prefix)]
        if newest_first:
            rows.reverse()
        return rows[:limit] if limit else rows

    def query_range(self, pk, start, end):
        return [copy.deepcopy(v) for sk, v in self._sorted(pk) if start <= sk <= end]

    def scan_sk(self, sk):
        return [copy.deepcopy(v) for k, v in self.items.items() if k[1] == sk]

    def by_prefix(self, prefix):
        return [v for k, v in self.items.items() if k[1].startswith(prefix)]


class Recorder:
    """Fake boto3 client that records calls and returns canned values."""

    def __init__(self, **returns):
        self.calls = []
        self.returns = returns

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            value = self.returns.get(name, {})
            return value(**kwargs) if callable(value) else value
        return call


@pytest.fixture
def store(monkeypatch):
    mem = MemoryStore()
    monkeypatch.setattr(db, "_store", mem)
    return mem


@pytest.fixture
def clients(monkeypatch):
    fakes = {
        "sqs": Recorder(),
        "sns": Recorder(subscribe={"SubscriptionArn": "arn:aws:sns:eu-central-1:1:t:abc"}),
    }
    monkeypatch.setattr(aws, "_clients", fakes)
    monkeypatch.setattr(config, "VALIDATE_QUEUE_URL", "https://sqs/validate")
    monkeypatch.setattr(config, "ALERTS_TOPIC_ARN", "arn:aws:sns:eu-central-1:1:alerts")
    monkeypatch.setattr(config, "UPLOAD_BUCKET", "uploads-bucket")
    return fakes
