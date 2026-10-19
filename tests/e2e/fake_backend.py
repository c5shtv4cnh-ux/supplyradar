"""Local stand-in for the AWS stack, for UI work and browser tests without an AWS account.

Serves src/frontend and runs the real api/validate handler code against an
in-memory table. Cognito, S3, SQS and SNS are faked; Gemini is replaced by the
ground-truth JSON of the sample invoice with the same file name
(samples/**/<name>.json), so uploads of the sample PNGs behave like the real flow.

    python3 tests/e2e/fake_backend.py           # http://localhost:8765
"""
import base64
import json
import re
import sys
import threading
import time
import urllib.parse
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src" / "backend"))
sys.path.insert(0, str(ROOT / "tests" / "unit"))

import os  # noqa: E402

os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-1")

import api  # noqa: E402
import validate  # noqa: E402
from conftest import MemoryStore  # noqa: E402
from supplyradar import aws, config, db  # noqa: E402

PORT = int(os.environ.get("PORT", "8765"))
BASE = f"http://localhost:{PORT}"
FILES = {}
SENT_EMAILS = []
USERS = {}
LOCK = threading.Lock()


def find_truth(file_name):
    stem = Path(file_name or "").stem
    for path in (ROOT / "samples").rglob(f"{stem}.json"):
        return json.loads(path.read_text())
    return None


class FakeS3:
    def generate_presigned_post(self, Bucket, Key, Fields, Conditions, ExpiresIn):
        return {"url": f"{BASE}/s3-upload", "fields": {"key": Key, **Fields}}

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"{BASE}/s3-file/{urllib.parse.quote(Params['Key'])}"


class FakeSQS:
    def send_message(self, QueueUrl, MessageBody):
        msg = json.loads(MessageBody)
        threading.Timer(0.5, lambda: run_validate(msg)).start()
        return {}


class FakeSNS:
    def subscribe(self, **kw):
        return {"SubscriptionArn": f"{config.ALERTS_TOPIC_ARN}:local"}

    def unsubscribe(self, **kw):
        return {}

    def get_subscription_attributes(self, **kw):
        return {"Attributes": {"PendingConfirmation": "false"}}

    def publish(self, **kw):
        SENT_EMAILS.append(kw)
        return {}


def run_validate(msg):
    with LOCK:
        validate.process(msg)
        for alert in db.store().query_prefix(db.user_pk(msg["user_id"]), "ALERT#"):
            if alert["SK"] not in {e.get("sk") for e in SENT_EMAILS}:
                import notify
                subject, body = notify.format_alert(alert)
                SENT_EMAILS.append({"sk": alert["SK"], "Subject": subject, "Message": body})
                print(f"[email] {subject}\n{body}\n", flush=True)


def fake_extract(key):
    """What the extract Lambda + Gemini would do: here the sample's ground truth."""
    user_id, invoice_id, _ = key.split("/")[1], *key.split("/")[2].rsplit(".", 1)
    pk = db.user_pk(user_id)
    with LOCK:
        item = db.store().get(pk, f"INV#{invoice_id}")
        item["status"] = "extracting"
        db.store().put(item)
    time.sleep(1.5)
    truth = find_truth(item.get("file_name"))
    with LOCK:
        item = db.store().get(pk, f"INV#{invoice_id}")
        if truth is None:
            item.update(status="failed", error="Нет эталона для этого файла (используйте samples/)")
            db.store().put(item)
            return
        item["status"] = "validating"
        db.store().put(item)
    time.sleep(0.5)
    run_validate({"user_id": user_id, "invoice_id": invoice_id, "extraction": truth})


def make_token(email):
    sub = USERS.setdefault(email, {"sub": f"local-{len(USERS) + 1}"})["sub"]
    payload = base64.urlsafe_b64encode(json.dumps(
        {"sub": sub, "email": email, "exp": int(time.time()) + 3600}).encode()).decode().rstrip("=")
    return f"e30.{payload}.sig"


def claims_from(header):
    token = (header or "").replace("Bearer ", "")
    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        return None


ROUTE_PATTERNS = [(re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", r.split(" ")[1]) + "$"), r)
                  for r in api.ROUTES]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "src" / "frontend"), **kw)

    def log_message(self, fmt, *args):
        pass

    def send_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/config.js":
            cfg = {"apiUrl": f"{BASE}/api", "region": "local", "userPoolId": "local",
                   "clientId": "local", "cognitoEndpoint": f"{BASE}/cognito", "environment": "local"}
            data = f"window.SUPPLYRADAR_CONFIG = {json.dumps(cfg)};".encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.end_headers()
            self.wfile.write(data)
        elif path.startswith("/s3-file/"):
            key = urllib.parse.unquote(path[len("/s3-file/"):])
            data, ctype = FILES.get(key, (b"", "text/plain"))
            self.send_response(200 if data else 404)
            self.send_header("Content-Type", ctype)
            self.end_headers()
            self.wfile.write(data)
        elif path.startswith("/api/"):
            self.api("GET", path)
        else:
            super().do_GET()

    def do_PUT(self):
        self.api("PUT", urllib.parse.urlparse(self.path).path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/cognito":
            self.cognito(self.headers.get("X-Amz-Target", "").split(".")[-1], json.loads(self.body()))
        elif path == "/s3-upload":
            raw = b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + self.body()
            msg = BytesParser(policy=email_policy).parsebytes(raw)
            fields = {p.get_param("name", header="content-disposition"): p for p in msg.iter_parts()}
            key = fields["key"].get_content().strip()
            FILES[key] = (fields["file"].get_payload(decode=True), fields["Content-Type"].get_content().strip())
            threading.Thread(target=fake_extract, args=(key,), daemon=True).start()
            self.send_response(204)
            self.end_headers()
        else:
            self.api("POST", path)

    def cognito(self, action, body):
        email = body.get("Username") or body.get("AuthParameters", {}).get("USERNAME")
        if action == "SignUp":
            if email in USERS:
                return self.send_json(400, {"__type": "UsernameExistsException"})
            USERS[email] = {"sub": f"local-{len(USERS) + 1}", "password": body["Password"], "confirmed": False}
            return self.send_json(200, {"UserConfirmed": False})
        if action == "ConfirmSignUp":
            USERS[email]["confirmed"] = True
            return self.send_json(200, {})
        if action == "ResendConfirmationCode":
            return self.send_json(200, {})
        if action == "InitiateAuth":
            if body["AuthFlow"] == "REFRESH_TOKEN_AUTH":
                return self.send_json(200, {"AuthenticationResult": {"IdToken": make_token("refresh@local"), "ExpiresIn": 3600}})
            user = USERS.get(email)
            if not user or user.get("password") != body["AuthParameters"]["PASSWORD"]:
                return self.send_json(400, {"__type": "NotAuthorizedException"})
            if not user.get("confirmed"):
                return self.send_json(400, {"__type": "UserNotConfirmedException"})
            return self.send_json(200, {"AuthenticationResult": {
                "IdToken": make_token(email), "RefreshToken": "r", "ExpiresIn": 3600}})
        self.send_json(400, {"__type": "InvalidParameterException", "message": action})

    def api(self, method, path):
        claims = claims_from(self.headers.get("Authorization"))
        if not claims:
            return self.send_json(401, {"message": "Unauthorized"})
        sub_path = path[len("/api"):]
        for pattern, route in ROUTE_PATTERNS:
            m = pattern.match(sub_path)
            if m and route.startswith(method + " "):
                event = {
                    "routeKey": route,
                    "pathParameters": m.groupdict() or None,
                    "body": self.body().decode() or None,
                    "requestContext": {"authorizer": {"jwt": {"claims": claims}}},
                }
                with LOCK:
                    resp = api.handler(event, None)
                return self.send_json(resp["statusCode"], json.loads(resp["body"]))
        self.send_json(404, {"message": "Not Found"})


def main():
    db._store = MemoryStore()
    aws._clients.update(s3=FakeS3(), sqs=FakeSQS(), sns=FakeSNS())
    config.ALERTS_TOPIC_ARN = "arn:aws:sns:local:000000000000:alerts"
    config.UPLOAD_BUCKET = "local"
    print(f"SupplyRadar local backend on {BASE}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
