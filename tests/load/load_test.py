#!/usr/bin/env python3
"""Load test for the SupplyRadar API: stepped concurrency, read-only requests.

It answers three questions for the defence:
  1. How many requests per second does the API serve, and how fast (p50/p95/p99)?
  2. Where does throttling start (HTTP 429 from API Gateway)?
  3. Does anything break (5xx) under load?

Each stage runs N "virtual users" for a fixed time; every user sends one
request after another over a kept-alive HTTPS connection. Only GET routes
are called, so the test writes nothing and never calls Gemini.

Local self-check (no AWS, starts tests/e2e/fake_backend.py on a free port):

    python3 tests/load/load_test.py --local

Against a deployed environment (reads only; uses your own account's data):

    export SR_PASSWORD='your password'
    python3 tests/load/load_test.py \
        --api-url   "$(terraform -chdir=terraform output -raw api_url)" \
        --client-id "$(terraform -chdir=terraform output -raw user_pool_client_id)" \
        --email you@example.com

Output (default folder load-results/): results.csv, summary.md, chart.png.
Standard library only; the chart needs matplotlib (pip install -r requirements-dev.txt).
"""
import argparse
import csv
import http.client
import json
import os
import socket
import ssl
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Read-only routes with weights close to what the web app does on its own.
SCENARIO = [
    ("/invoices", 4),
    ("/products", 2),
    ("/alerts", 2),
    ("/settings", 1),
    ("/savings", 1),
]


def percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(values)
    k = (len(ordered) - 1) * pct / 100
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def post_json(url, body, headers=None, timeout=20):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def cognito(endpoint, action, body):
    return post_json(endpoint, body, {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": f"AWSCognitoIdentityProviderService.{action}",
    })


def sign_in(endpoint, client_id, email, password):
    status, data = cognito(endpoint, "InitiateAuth", {
        "ClientId": client_id, "AuthFlow": "USER_PASSWORD_AUTH",
        "AuthParameters": {"USERNAME": email, "PASSWORD": password},
    })
    if status != 200 or "AuthenticationResult" not in data:
        sys.exit(f"Sign-in failed ({status}): {data.get('__type') or data.get('message') or data}")
    return data["AuthenticationResult"]["IdToken"]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_local_backend():
    """Start the fake backend and return (process, api_url, token)."""
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(ROOT / "tests" / "e2e" / "fake_backend.py")],
                            env={**os.environ, "PORT": str(port)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://localhost:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{base}/config.js", timeout=1).read()
            break
        except OSError:
            if proc.poll() is not None:
                sys.exit("The local fake backend did not start (pip install -r requirements-dev.txt).")
            time.sleep(0.1)
    else:
        proc.kill()
        sys.exit("The local fake backend did not answer in 10 s.")
    email, password = "load-test@example.com", "load-test-1"
    cognito(f"{base}/cognito", "SignUp", {"ClientId": "local", "Username": email, "Password": password})
    cognito(f"{base}/cognito", "ConfirmSignUp", {"ClientId": "local", "Username": email, "ConfirmationCode": "000000"})
    return proc, f"{base}/api", sign_in(f"{base}/cognito", "local", email, password)


class Worker(threading.Thread):
    """One virtual user: requests in a loop until the stage deadline."""

    def __init__(self, api_url, token, deadline, offset, timeout):
        super().__init__(daemon=True)
        self.url = urllib.parse.urlparse(api_url)
        self.token, self.deadline, self.offset, self.timeout = token, deadline, offset, timeout
        self.samples = []  # (seconds, status); status 0 = no HTTP answer
        self.paths = [p for p, weight in SCENARIO for _ in range(weight)]

    def connect(self):
        if self.url.scheme == "https":
            return http.client.HTTPSConnection(self.url.netloc, timeout=self.timeout,
                                               context=ssl.create_default_context())
        return http.client.HTTPConnection(self.url.netloc, timeout=self.timeout)

    def run(self):
        conn, i = None, self.offset
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        while time.monotonic() < self.deadline:
            path = self.url.path.rstrip("/") + self.paths[i % len(self.paths)]
            i += 1
            started = time.monotonic()
            try:
                conn = conn or self.connect()
                conn.request("GET", path, headers=headers)
                resp = conn.getresponse()
                resp.read()
                status = resp.status
                if resp.will_close:
                    conn.close()
                    conn = None
            except (OSError, http.client.HTTPException):
                status = 0
                if conn:
                    conn.close()
                conn = None
            self.samples.append((time.monotonic() - started, status))
        if conn:
            conn.close()


def run_stage(api_url, token, users, seconds, timeout):
    started = time.monotonic()
    workers = [Worker(api_url, token, started + seconds, n, timeout) for n in range(users)]
    for w in workers:
        w.start()
    for w in workers:
        w.join(seconds + timeout + 5)
    elapsed = time.monotonic() - started
    samples = [s for w in workers for s in w.samples]
    ok = [t * 1000 for t, status in samples if 200 <= status < 300]
    count = lambda test: sum(1 for _, status in samples if test(status))  # noqa: E731
    total = len(samples) or 1
    return {
        "users": users,
        "seconds": round(elapsed, 1),
        "requests": len(samples),
        "rps_total": round(len(samples) / elapsed, 1),
        "rps_ok": round(len(ok) / elapsed, 1),
        "rps_throttled": round(count(lambda s: s == 429) / elapsed, 1),
        "p50_ms": round(percentile(ok, 50), 1),
        "p95_ms": round(percentile(ok, 95), 1),
        "p99_ms": round(percentile(ok, 99), 1),
        "mean_ms": round(statistics.fmean(ok), 1) if ok else 0.0,
        "ok": len(ok),
        "throttled_429": count(lambda s: s == 429),
        "client_4xx": count(lambda s: 400 <= s < 500 and s != 429),
        "server_5xx": count(lambda s: s >= 500),
        "no_answer": count(lambda s: s == 0),
        "throttled_pct": round(100 * count(lambda s: s == 429) / total, 2),
        "failed_pct": round(100 * count(lambda s: s >= 500 or s == 0) / total, 2),
    }


def write_chart(rows, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # Palette and anatomy: one measure per panel (no dual axes), fixed hue order,
    # recessive grid, direct labels, text in ink colors.
    ink, muted, grid, surface = "#0b0b0b", "#898781", "#e1e0d9", "#fcfcfb"
    blue, orange, aqua, critical = "#2a78d6", "#eb6834", "#1baf7a", "#d03b3b"
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "text.color": ink,
                         "axes.labelcolor": "#52514e", "xtick.color": muted, "ytick.color": muted})
    users = [r["users"] for r in rows]
    fig, axes = plt.subplots(3, 1, figsize=(8.5, 9.5), sharex=True, facecolor=surface)
    fig.suptitle(title, x=0.08, ha="left", fontsize=13, fontweight="bold")

    panels = [
        ("Throughput, requests per second", [
            ("served (2xx)", "rps_ok", blue), ("throttled (429)", "rps_throttled", orange)]),
        ("Response time of served requests, ms", [
            ("p50", "p50_ms", blue), ("p95", "p95_ms", orange), ("p99", "p99_ms", aqua)]),
        ("Failed requests (5xx or no answer), % of all", [
            ("failed", "failed_pct", critical)]),
    ]
    for ax, (heading, series) in zip(axes, panels):
        ax.set_facecolor(surface)
        ax.set_title(heading, loc="left", fontsize=10.5, color=ink, pad=8)
        top = max(max(r[key] for r in rows) for _, key, _ in series)
        top = top * 1.12 if top > 0 else 1
        ends = []
        for label, key, color in series:
            values = [r[key] for r in rows]
            ax.plot(users, values, color=color, linewidth=2, marker="o", markersize=5.5,
                    markeredgecolor=surface, markeredgewidth=1.5, label=label, clip_on=False)
            ends.append((values[-1], label))
        # Direct labels at the line ends, pushed apart so they never overlap.
        gap, placed = top * 0.075, []
        for value, label in sorted(ends):
            y = value if not placed else max(value, placed[-1] + gap)
            placed.append(y)
            ax.annotate(f"{label}  {value:g}", (users[-1], y), xytext=(9, 0), textcoords="offset points",
                        va="center", fontsize=9, color="#52514e", annotation_clip=False)
        ax.set_ylim(0, top)
        ax.grid(axis="y", color=grid, linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
        ax.spines["bottom"].set_color("#c3c2b7")
        ax.tick_params(length=0)
        if len(series) > 1:  # legend sits above the plot, clear of the lines
            ax.legend(loc="lower right", bbox_to_anchor=(1, 1.0), frameon=False, ncols=len(series),
                      fontsize=9, handlelength=1.4, borderaxespad=0.2, columnspacing=1.4)
    axes[-1].set_xlabel("Concurrent users (each sends requests back to back)")
    axes[-1].set_xticks(users)
    fig.subplots_adjust(left=0.08, right=0.82, top=0.91, bottom=0.07, hspace=0.34)
    fig.savefig(path, dpi=160, facecolor=surface)
    plt.close(fig)


def write_summary(rows, path, target, note):
    served = [r for r in rows if r["ok"]]
    best = max(served, key=lambda r: r["rps_ok"]) if served else None
    first_throttle = next((r for r in rows if r["throttled_429"]), None)
    failures = sum(r["server_5xx"] + r["no_answer"] for r in rows)
    lines = [
        "# Load test result", "",
        f"- Target: `{target}`",
        f"- When: {time.strftime('%Y-%m-%d %H:%M %Z')}",
        f"- Scenario: read-only GET mix ({', '.join(p for p, _ in SCENARIO)})",
    ]
    if note:
        lines.append(f"- Note: {note}")
    lines += ["", "| Users | Requests | Served req/s | p50 ms | p95 ms | p99 ms | 429 % | Failed % |",
              "|---:|---:|---:|---:|---:|---:|---:|---:|"]
    lines += [f"| {r['users']} | {r['requests']} | {r['rps_ok']} | {r['p50_ms']} | {r['p95_ms']} | "
              f"{r['p99_ms']} | {r['throttled_pct']} | {r['failed_pct']} |" for r in rows]
    lines.append("")
    if best:
        lines.append(f"- Highest served throughput: **{best['rps_ok']} req/s** at {best['users']} users "
                     f"(p95 {best['p95_ms']} ms).")
    lines.append(f"- Throttling (429) first seen at {first_throttle['users']} users."
                 if first_throttle else "- No request was throttled (429).")
    lines.append(f"- Server errors or dropped connections: **{failures}**.")
    path.write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", action="store_true", help="test the local fake backend (no AWS)")
    ap.add_argument("--api-url", help="API URL (terraform output api_url)")
    ap.add_argument("--token", help="Cognito ID token; otherwise --email and SR_PASSWORD are used")
    ap.add_argument("--email")
    ap.add_argument("--client-id", help="terraform output user_pool_client_id")
    ap.add_argument("--region", default="eu-central-1")
    ap.add_argument("--stages", default="1,2,5,10,20,40", help="concurrent users per stage")
    ap.add_argument("--stage-seconds", type=float, default=20)
    ap.add_argument("--pause", type=float, default=3, help="seconds between stages (lets the throttle bucket refill)")
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--out", default="load-results")
    ap.add_argument("--no-chart", action="store_true")
    ap.add_argument("--max-users", type=int, default=100, help="safety limit for one stage")
    args = ap.parse_args()

    stages = [int(s) for s in args.stages.split(",") if s.strip()]
    if max(stages) > args.max_users:
        sys.exit(f"A stage has more than {args.max_users} users; raise --max-users if you mean it.")

    proc, note = None, ""
    if args.local:
        proc, api_url, token = start_local_backend()
        target = "local fake backend"
        note = ("local stand-in on this computer: it checks the tool and the API code, "
                "its numbers say nothing about AWS")
    else:
        if not args.api_url:
            sys.exit("Give --api-url (or --local).")
        api_url, target = args.api_url.rstrip("/"), args.api_url
        token = args.token
        if not token:
            password = os.environ.get("SR_PASSWORD")
            if not (args.email and args.client_id and password):
                sys.exit("Give --token, or --email and --client-id with the password in SR_PASSWORD.")
            token = sign_in(f"https://cognito-idp.{args.region}.amazonaws.com/", args.client_id, args.email, password)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    try:
        print(f"Target: {target}")
        print(f"{'users':>5} {'req':>7} {'ok/s':>7} {'p50':>7} {'p95':>7} {'p99':>7} {'429%':>6} {'fail%':>6}")
        for n, users in enumerate(stages):
            if n:
                time.sleep(args.pause)
            row = run_stage(api_url, token, users, args.stage_seconds, args.timeout)
            rows.append(row)
            print(f"{row['users']:>5} {row['requests']:>7} {row['rps_ok']:>7} {row['p50_ms']:>7} "
                  f"{row['p95_ms']:>7} {row['p99_ms']:>7} {row['throttled_pct']:>6} {row['failed_pct']:>6}", flush=True)
    finally:
        if proc:
            proc.terminate()

    with open(out / "results.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    write_summary(rows, out / "summary.md", target, note)
    if not args.no_chart:
        try:
            write_chart(rows, out / "chart.png", f"SupplyRadar API under load: {target}")
        except ImportError:
            print("matplotlib is not installed: no chart (pip install -r requirements-dev.txt).")
    print(f"Saved to {out}/")

    if not any(r["ok"] for r in rows):
        sys.exit("No request succeeded.")
    if args.local and any(r["server_5xx"] or r["no_answer"] for r in rows):
        sys.exit("The local backend returned errors under load.")


if __name__ == "__main__":
    main()
