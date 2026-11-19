"""Makes a VAPID keypair for Web Push, in the format browsers and pywebpush read.

    python3 scripts/gen_vapid.py DIR

writes two files into DIR, which must exist (a fresh `mktemp -d` is the right place):

    vapid_public.txt    the base64url of the 65-byte uncompressed P-256 public point (the page's applicationServerKey)
    vapid_private.txt   the base64url of the 32-byte private scalar, readable by its owner only

both without padding or a trailing newline, ready for your host's secret store (for example by piping the file in). The private key
is never printed, an existing file is never overwritten, and a directory inside the repository is refused. The key comes from the `openssl` command, the only
thing this needs. A new keypair un-subscribes every device, so do not replace a live site's keys lightly.
"""

import base64
import os
import subprocess
import sys
from pathlib import Path

PRIVATE_LEN = 32  # a P-256 private scalar
PUBLIC_LEN = 65  # 0x04, then x and y, 32 bytes each


def _tlv(data: bytes, at: int) -> tuple[int, bytes, int]:
    """The DER element at `at`: its tag, its value and the offset just past it."""
    tag, length, at = data[at], data[at + 1], at + 2
    if length & 0x80:
        count = length & 0x7F
        length, at = int.from_bytes(data[at : at + count], "big"), at + count
    return tag, data[at : at + length], at + length


def _sec1_keys(der: bytes) -> tuple[bytes, bytes]:
    """The private scalar and the uncompressed public point of a SEC1 ECPrivateKey (RFC 5915)."""
    tag, body, _ = _tlv(der, 0)
    if tag != 0x30:
        raise ValueError("not a DER sequence")
    private = public = None
    at = 0
    while at < len(body):
        tag, value, at = _tlv(body, at)
        if tag == 0x04:  # privateKey OCTET STRING
            private = value.rjust(PRIVATE_LEN, b"\0")
        elif tag == 0xA1:  # [1] publicKey: a BIT STRING with no unused bits
            inner_tag, bits, _ = _tlv(value, 0)
            if inner_tag == 0x03 and bits[:1] == b"\0":
                public = bits[1:]
    if private is None or len(private) != PRIVATE_LEN:
        raise ValueError("no 32-byte private key in the openssl output")
    if public is None or len(public) != PUBLIC_LEN or public[0] != 0x04:
        raise ValueError("no uncompressed public key in the openssl output")
    return private, public


def _openssl(args: list[str], stdin: bytes | None = None) -> bytes:
    return subprocess.run(["openssl", *args], input=stdin, capture_output=True, check=True).stdout


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _write_new(path: Path, text: str, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w", encoding="ascii") as file:
        file.write(text)


def main(argv: list[str]) -> int:
    if len(argv) != 1 or not Path(argv[0]).is_dir():
        print("usage: python3 scripts/gen_vapid.py DIR   (DIR must exist, for example \"$(mktemp -d)\")", file=sys.stderr)
        return 2
    out = Path(argv[0])
    repository = Path(__file__).resolve().parent.parent
    where = out.resolve()
    if where == repository or repository in where.parents:
        print(f"gen_vapid: {out} is inside the repository; keys never belong there. Use a fresh directory "
              "outside it, for example \"$(mktemp -d)\"", file=sys.stderr)
        return 2
    taken = [name for name in ("vapid_private.txt", "vapid_public.txt") if (out / name).exists()]
    if taken:
        print(f"gen_vapid: {', '.join(taken)} already in {out}; use a fresh directory", file=sys.stderr)
        return 1
    der = _openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-outform", "DER"])
    private, public = _sec1_keys(der)
    # Cross-check: openssl derives the public key from the private one again; it must be the same point.
    spki = _openssl(["ec", "-inform", "DER", "-pubout", "-outform", "DER", "-conv_form", "uncompressed"], der)
    if not spki.endswith(public):
        raise SystemExit("gen_vapid: the public key does not match the private key; nothing written")
    _write_new(out / "vapid_private.txt", _b64url(private), 0o600)
    _write_new(out / "vapid_public.txt", _b64url(public), 0o644)
    print(f"Wrote {out / 'vapid_public.txt'} and {out / 'vapid_private.txt'} (private, mode 600).")
    print(f"Public key: {_b64url(public)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
