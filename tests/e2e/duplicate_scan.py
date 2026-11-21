"""
Python Playwright equivalent of duplicate-scan.spec.js.

Provided as a runnable fallback when Node Playwright / @playwright/test is not
available (Python Playwright is installed system-wide in this environment).
It implements exactly the same test, including the test-only emulator overrides
(no production source file is modified).

Run from the repo root:

    python tests/e2e/duplicate_scan.py

Set GP_E2E_FIRESTORE_PORT to use a different emulator port (default 8081, so it
does not clash with the Task 10 rules tests on 8080). Set GP_E2E_EMULATOR=0 to
reuse an emulator that is already running on that port.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

E2E_DIR = Path(__file__).resolve().parent
ROOT = E2E_DIR.parent.parent
RULES = ROOT / "firestore.rules"
# tests/e2e/firebase.json is the default-8081 reference. The emulator config
# actually used below is generated at runtime with the active PORT.
TEMP_DIR = None

PORT = int(os.environ.get("GP_E2E_FIRESTORE_PORT", "8081"))
HOST = "127.0.0.1"
PROJECT = "demo-gatepass-e2e"
CODE = "E2E4PASS"
EVENT = "e2e-event"
TOKEN = "A" * 32
PASS = "e2e-pass"
TOKEN2 = "B" * 32  # distinct fresh pass used by the concurrent-scan test
PASS2 = "e2e-pass-2"
OWNER = "e2e-owner"


# ── emulator helpers (rules-unit-testing's "owner" token bypasses rules) ──

def _request(url, method="GET", body=None, owner=True):
    headers = {"Content-Type": "application/json"}
    if owner:
        headers["Authorization"] = "Bearer owner"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def firestore_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, datetime):
        return {"timestampValue": v.isoformat().replace("+00:00", "Z")}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [firestore_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: firestore_value(x) for k, x in v.items()}}}
    raise TypeError(f"Unsupported Firestore value: {type(v)}")


def doc_url(path):
    return (f"http://{HOST}:{PORT}/v1/projects/{PROJECT}"
            f"/databases/(default)/documents/{path}")


def set_doc(path, data):
    # The Firestore REST API creates/overwrites a document with PATCH, not PUT.
    _request(doc_url(path), "PATCH", {"fields": {k: firestore_value(v) for k, v in data.items()}})


def get_doc(path):
    return (_request(doc_url(path)) or {}).get("fields", {})


def clear_firestore():
    _request(f"http://{HOST}:{PORT}/emulator/v1/projects/{PROJECT}"
             "/databases/(default)/documents", "DELETE", owner=False)


def load_rules():
    _request(f"http://{HOST}:{PORT}/emulator/v1/projects/{PROJECT}:securityRules",
             "PUT", {"rules": {"files": [{"content": RULES.read_text(encoding="utf-8")}]}},
             owner=False)


def wait_for_emulator(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://{HOST}:{PORT}/", timeout=2) as resp:
                if resp.status in (200, 404):
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"Firestore emulator did not start on {HOST}:{PORT}")


def start_emulator():
    global TEMP_DIR
    if os.environ.get("GP_E2E_EMULATOR") == "0":
        # Reuse mode: no config is needed, but every connection still uses PORT.
        wait_for_emulator()
        return None
    TEMP_DIR = tempfile.mkdtemp(prefix="gatepass-e2e-")
    config = Path(TEMP_DIR) / "firebase.json"
    config.write_text(json.dumps({
        "emulators": {"firestore": {"host": HOST, "port": PORT}},
    }, indent=2), encoding="utf-8")
    args = ["firebase", "emulators:start", "--only", "firestore",
            "--project", PROJECT, "--config", str(config)]
    proc = subprocess.Popen(
        subprocess.list2cmdline(args), cwd=TEMP_DIR, shell=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        wait_for_emulator()
    except Exception as e:
        if proc.poll() is None:
            stop_emulator(proc)
        raise RuntimeError(f"{e}\n--- emulator log ---\n{proc.stdout.read()[-4000:]}") from e
    return proc


def stop_emulator(proc):
    if proc is None or proc.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_):
        pass


def start_static_server():
    server = ThreadingHTTPServer((HOST, 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://{HOST}:{server.server_address[1]}"


def set_gate(total):
    now = datetime.now(timezone.utc)
    set_doc(f"gp_gates/{CODE}", {
        "eventId": EVENT, "name": "E2E Night", "club": "Test Club", "venue": "Test Hall",
        "art": 0, "startsAt": now, "total": total, "checked": 0, "bounced": 0, "recent": [],
    })


def seed():
    now = datetime.now(timezone.utc)
    starts_at = now.isoformat().replace("+00:00", "Z")
    set_doc(f"gp_users/{OWNER}/events/{EVENT}", {"name": "E2E Night", "startsAt": now})
    set_doc(f"gp_events/{EVENT}", {
        "ownerId": OWNER, "gateCode": CODE, "name": "E2E Night", "club": "Test Club",
        "venue": "Test Hall", "art": 0, "startsAt": now, "total": 1, "createdAt": now,
    })
    set_gate(1)
    set_doc(f"gp_passes/{TOKEN}", {
        "id": PASS, "eventId": EVENT, "name": "Ada Lovelace",
        "event": {"name": "E2E Night", "club": "Test Club",
                  "startsAt": starts_at, "venue": "Test Hall", "art": 0},
        "checkedInAt": None, "gate": "",
    })
    set_doc(f"gp_events/{EVENT}/passes/{PASS}", {
        "name": "Ada Lovelace", "contact": "ada@example.com", "token": TOKEN,
        "createdAt": now, "checkedInAt": None, "gate": "",
    })
    set_doc(f"gp_gates/{CODE}/roster/{PASS}", {
        "name": "Ada Lovelace", "nameLower": "ada lovelace",
        "hint": "ad•••@example.com", "token": TOKEN, "checkedInAt": None, "gate": "",
    })


def seed_second_pass():
    """Add a second, fresh pass on the same gate for the concurrent-scan test."""
    now = datetime.now(timezone.utc)
    starts_at = now.isoformat().replace("+00:00", "Z")
    set_doc(f"gp_passes/{TOKEN2}", {
        "id": PASS2, "eventId": EVENT, "name": "Grace Hopper",
        "event": {"name": "E2E Night", "club": "Test Club",
                  "startsAt": starts_at, "venue": "Test Hall", "art": 0},
        "checkedInAt": None, "gate": "",
    })
    set_doc(f"gp_events/{EVENT}/passes/{PASS2}", {
        "name": "Grace Hopper", "contact": "grace@example.com", "token": TOKEN2,
        "createdAt": now, "checkedInAt": None, "gate": "",
    })
    set_doc(f"gp_gates/{CODE}/roster/{PASS2}", {
        "name": "Grace Hopper", "nameLower": "grace hopper",
        "hint": "gr•••@example.com", "token": TOKEN2, "checkedInAt": None, "gate": "",
    })
    set_gate(2)


def make_context(browser, base_url):
    cfg = {
        "apiKey": "fake-api-key-for-emulator",
        "authDomain": f"{PROJECT}.firebaseapp.com",
        "projectId": PROJECT,
        "appId": "1:1234567890:web:emulator",
    }
    context = browser.new_context()
    context.add_init_script(script=f"window.FIREBASE = {json.dumps(cfg)};")

    context.route("**/firebase-config.js",
                  lambda route: route.fulfill(
                      status=200, content_type="text/javascript; charset=utf-8",
                      body=f"window.FIREBASE = {json.dumps(cfg)};"))

    def patch_data_layer(route):
        response = route.fetch()
        body = response.text()
        body, n1 = re.subn(
            r'serverTimestamp,\s*increment,\s*onSnapshot,\s*\} from "firebase/firestore";',
            'serverTimestamp, increment, onSnapshot, connectFirestoreEmulator,\n} from "firebase/firestore";',
            body, count=1)
        body, n2 = re.subn(
            r'export const db = app \? getFirestore\(app\) : null;',
            f'export const db = app ? (() => {{ const d = getFirestore(app); '
            f'connectFirestoreEmulator(d, "{HOST}", {PORT}); return d; }})() : null;',
            body, count=1)
        if not n1 or not n2:
            raise RuntimeError("Could not inject the Firestore emulator hook into assets/js/firebase.js")
        route.fulfill(response=response, body=body,
                      headers={**response.headers, "content-type": "text/javascript; charset=utf-8"})

    context.route("**/assets/js/firebase.js", patch_data_layer)
    return context


def join_gate(page, base_url, gate_name, expected="0 / 1"):
    page.goto(base_url + "/gate/")
    expect(page.locator("#joinForm")).to_be_visible()
    page.locator("#code").fill(CODE)
    page.locator(f'input[name="gate"][value="{gate_name}"]').check(force=True)
    page.locator("#joinBtn").click()
    expect(page.locator("#scan")).to_be_visible()
    page.wait_for_function("() => !!window.GatePassGate", timeout=20000)
    expect(page.locator("#cNum")).to_have_text(expected)


def test_sequential(browser, base_url):
    """First scan green, every repeat red and counted."""
    pass_url = f"{base_url}/p/#{TOKEN}"
    phone1 = make_context(browser, base_url).new_page()
    phone2 = make_context(browser, base_url).new_page()

    join_gate(phone1, base_url, "Gate 1")
    join_gate(phone2, base_url, "Gate 2")

    # First phone: accepted.
    phone1.evaluate("(u) => window.GatePassGate.handleText(u)", pass_url)
    first = phone1.locator("#verdict")
    expect(first).to_have_class(re.compile(r"\bok\b"))
    expect(first).to_contain_text("First scan")
    expect(phone1.locator("#cNum")).to_have_text("1 / 1")

    # Second phone: rejected, citing the gate of the first scan.
    phone2.evaluate("(u) => window.GatePassGate.handleText(u)", pass_url)
    second = phone2.locator("#verdict")
    expect(second).to_have_class(re.compile(r"\bdup\b"))
    expect(second).to_contain_text("Already scanned")
    expect(second).to_contain_text("first scan at Gate 1")
    expect(second).to_contain_text("1 repeat")
    expect(phone2.locator("#cNum")).to_have_text("1 / 1")

    # Another repeat on the same phone bumps bounced again.
    time.sleep(3.7)  # clear handleText's 3.5 s same-token de-dupe window
    phone2.evaluate("(u) => window.GatePassGate.handleText(u)", pass_url)
    expect(second).to_contain_text("2 repeats")

    gate = get_doc(f"gp_gates/{CODE}")
    assert int(gate["checked"]["integerValue"]) == 1, gate
    assert int(gate["bounced"]["integerValue"]) == 2, gate
    assert int(gate["total"]["integerValue"]) == 1, gate


def test_concurrent(browser, base_url):
    """Two phones scanning the same fresh pass at once: one ok, one dup."""
    pass_url2 = f"{base_url}/p/#{TOKEN2}"
    phone1 = make_context(browser, base_url).new_page()
    phone2 = make_context(browser, base_url).new_page()

    join_gate(phone1, base_url, "Gate 1", "0 / 2")
    join_gate(phone2, base_url, "Gate 2", "0 / 2")

    # The sync API cannot await two pages at once (no Promise.all). Schedule
    # both scans for the same absolute instant so the two transactions really
    # race, the way Promise.all does in the JS spec.
    fire_at = (time.time() + 0.5) * 1000
    fire = """([u, t]) => new Promise((resolve) => {
        setTimeout(() => { window.GatePassGate.handleText(u); resolve(); },
                   Math.max(0, t - Date.now()));
    })"""
    phone1.evaluate(fire, [pass_url2, fire_at])
    phone2.evaluate(fire, [pass_url2, fire_at])

    v1 = phone1.locator("#verdict")
    v2 = phone2.locator("#verdict")
    expect(v1).not_to_have_class("verdict idle")
    expect(v2).not_to_have_class("verdict idle")

    class1 = v1.get_attribute("class")
    class2 = v2.get_attribute("class")
    text1 = v1.text_content()
    text2 = v2.text_content()

    def kind(c):
        if re.search(r"\bok\b", c):
            return "ok"
        if re.search(r"\bdup\b", c):
            return "dup"
        return "other"

    kinds = [kind(class1), kind(class2)]
    assert kinds.count("ok") == 1, (class1, class2, text1, text2)
    assert kinds.count("dup") == 1, (class1, class2, text1, text2)
    assert "First scan" in (text1 if kinds[0] == "ok" else text2)
    assert "Already scanned" in (text1 if kinds[0] == "dup" else text2)

    gate = get_doc(f"gp_gates/{CODE}")
    assert int(gate["checked"]["integerValue"]) == 1, gate
    assert int(gate["bounced"]["integerValue"]) == 1, gate
    assert int(gate["total"]["integerValue"]) == 2, gate


def main():
    emulator = start_emulator()
    server, base_url = start_static_server()
    try:
        load_rules()
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            ])
            try:
                # Reset per test so an earlier claim/counter cannot skew results.
                clear_firestore()
                seed()
                test_sequential(browser, base_url)

                clear_firestore()
                seed()
                seed_second_pass()
                test_concurrent(browser, base_url)
            finally:
                browser.close()

        print("PASS: sequential repeats red and concurrent scan yields one ok, one dup")
    finally:
        try:
            clear_firestore()
        except Exception:
            pass
        server.shutdown()
        server.server_close()
        stop_emulator(emulator)
        if TEMP_DIR:
            shutil.rmtree(TEMP_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
