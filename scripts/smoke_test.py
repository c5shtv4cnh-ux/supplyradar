#!/usr/bin/env python3
"""Post-deploy smoke test: is the site up, protected and wired to the API?

    python3 scripts/smoke_test.py --app-url https://dxxxx.cloudfront.net \
                                  --api-url https://xxxx.execute-api.eu-central-1.amazonaws.com

Read-only, no sign-in needed, standard library only. Exit code 1 on any failure.
"""
import argparse
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, follow=True):
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": "supplyradar-smoke-test"})
    try:
        with opener.open(req, timeout=20) as resp:
            return resp.status, resp.headers, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read().decode("utf-8", "replace")
    except OSError as err:  # DNS, TLS, timeout: report as a failed check, not a crash
        return 0, {}, str(err)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--app-url", required=True)
    ap.add_argument("--api-url", required=True)
    args = ap.parse_args()
    app, api = args.app_url.rstrip("/"), args.api_url.rstrip("/")
    results = []

    def check(name, ok, detail=""):
        results.append(ok)
        print(f"- {'PASS' if ok else 'FAIL'}: {name}{' (' + detail + ')' if detail else ''}")

    print("### Smoke test")
    status, headers, body = fetch(app + "/")
    check("web app answers 200", status == 200, f"HTTP {status}")
    check("page is SupplyRadar", "SupplyRadar" in body)
    check("HSTS header", "max-age" in (headers.get("Strict-Transport-Security") or ""))
    check("no MIME sniffing", (headers.get("X-Content-Type-Options") or "").lower() == "nosniff")
    check("framing forbidden", (headers.get("X-Frame-Options") or "").upper() in ("DENY", "SAMEORIGIN"))
    csp = headers.get("Content-Security-Policy")
    print(f"- INFO: Content-Security-Policy {'present' if csp else 'absent (enable_csp = false)'}")

    status, _, body = fetch(app + "/config.js")
    check("config.js points to the API", status == 200 and api in body, f"HTTP {status}")

    status, headers, _ = fetch(app.replace("https://", "http://") + "/", follow=False)
    check("plain HTTP redirects to HTTPS", status in (301, 302, 307, 308)
          and (headers.get("Location") or "").startswith("https://"), f"HTTP {status}")

    status, _, _ = fetch(api + "/invoices")
    check("API refuses requests without a token", status == 401, f"HTTP {status}")

    status, _, _ = fetch(api + "/no-such-route")
    check("unknown API route is not served", status in (401, 403, 404), f"HTTP {status}")

    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
