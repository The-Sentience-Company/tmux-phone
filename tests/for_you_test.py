#!/usr/bin/env python3
"""Checks the "for you" folder: newest first, seen once opened and new again when the file changes, and that the
Web Push token's signature verifies with the server's public key.

Usage: python3 tests/for_you_test.py
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

tmp = Path(tempfile.mkdtemp())
server.FOR_YOU, server.FOR_YOU_SEEN, server.VAPID_KEY = tmp / "for-ahmet", tmp / "seen.json", tmp / "vapid.pem"
assert server.for_you() == [], "a missing folder is an empty list"

server.FOR_YOU.mkdir()
old, new = server.FOR_YOU / "old.png", server.FOR_YOU / "new.pdf"
old.write_bytes(b"1"); os.utime(old, (1000, 1000))
new.write_bytes(b"2"); os.utime(new, (2000, 2000))
(server.FOR_YOU / ".DS_Store").write_bytes(b"")
items = server.for_you()
assert [i["name"] for i in items] == ["new.pdf", "old.png"], items
assert not any(i["seen"] for i in items)

server.mark_seen(str(old))
assert [i["seen"] for i in server.for_you()] == [False, True]
os.utime(old, (3000, 3000))
assert [(i["name"], i["seen"]) for i in server.for_you()] == [("old.png", False), ("new.pdf", False)], "a changed file is new again"
server.mark_seen(str(tmp / "elsewhere.txt"))
assert not any(i["seen"] for i in server.for_you()), "a file outside the folder is ignored"

server.delete_for_you(str(new))
assert [i["name"] for i in server.for_you()] == ["old.png"]
try:
    server.delete_for_you(str(tmp / "seen.json"))
    raise AssertionError("deleted a file outside the folder")
except ValueError:
    pass

# The JWT's r||s signature, put back into DER, must verify with the public key the browser subscribes with.
b64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
key = b64(server.vapid_public_key())
token = server.vapid_token("https://web.push.apple.com/abc")
head, claims, sig = token.split(".")
assert json.loads(b64(claims))["aud"] == "https://web.push.apple.com"
der_int = lambda b: (lambda b: b"\x02" + bytes([len(b)]) + b)(b"\x00" + b.lstrip(b"\x00") if b.lstrip(b"\x00")[0] & 0x80 else b.lstrip(b"\x00"))
body = der_int(b64(sig)[:32]) + der_int(b64(sig)[32:])
(tmp / "sig").write_bytes(b"\x30" + bytes([len(body)]) + body)
# A P-256 public key in SubjectPublicKeyInfo DER is a fixed 26-byte prefix and the 65-byte point.
spki = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200") + key
subprocess.run(["openssl", "pkey", "-pubin", "-inform", "DER", "-out", str(tmp / "pub.pem")], input=spki, check=True)
ok = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(tmp / "pub.pem"), "-signature", str(tmp / "sig")],
                    input=f"{head}.{claims}".encode(), capture_output=True)
assert ok.returncode == 0, ok.stdout + ok.stderr
print("ok")
