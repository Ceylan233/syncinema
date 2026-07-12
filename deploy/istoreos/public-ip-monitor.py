#!/usr/bin/env python3
import ipaddress
import os
import smtplib
import socket
import ssl
import sys
import tempfile
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path


STATE_FILE = Path(os.environ.get(
    "IP_STATE_FILE",
    "/var/lib/syncinema-ip-monitor/public-ip.txt",
))
CHECK_URLS = tuple(filter(None, (
    item.strip()
    for item in os.environ.get(
        "IP_CHECK_URLS",
        "https://api.ipify.org,https://ifconfig.me/ip,https://icanhazip.com",
    ).split(",")
)))


def fetch_public_ipv4():
    errors = []
    for url in CHECK_URLS:
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "Syncinema-N1-IP-Monitor/1.0"},
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                value = response.read(128).decode("ascii", "strict").strip()
            address = ipaddress.ip_address(value)
            if address.version != 4 or not address.is_global:
                raise ValueError(f"not a public IPv4 address: {value}")
            return str(address)
        except Exception as error:
            errors.append(f"{url}: {error}")
    raise RuntimeError("; ".join(errors))


def save_address(address):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=str(STATE_FILE.parent),
        prefix="public-ip-",
        text=True,
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="ascii") as stream:
            stream.write(f"{address}\n")
        os.replace(temporary_name, STATE_FILE)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def send_notification(old_address, new_address):
    host = os.environ.get("SMTP_HOST", "").strip()
    username = os.environ.get("MAIL_USER", "").strip()
    password = os.environ.get("MAIL_PASS", "")
    recipient = os.environ.get("MAIL_TO", username).strip()
    port = int(os.environ.get("SMTP_PORT", "465"))
    subject_prefix = os.environ.get("MAIL_SUBJECT_PREFIX", "Syncinema N1")
    if not host or not username or not password or not recipient:
        raise RuntimeError("MAIL_USER, MAIL_PASS, MAIL_TO and SMTP_HOST must be configured")

    body = (
        "Syncinema N1 public IPv4 changed.\n\n"
        f"Device: {socket.gethostname()}\n"
        f"Previous: {old_address or '(first detection)'}\n"
        f"Current: {new_address}\n"
        "Update the DNS record or verify your DDNS service and router port forwarding.\n"
    )
    message = MIMEMultipart()
    message["Subject"] = f"[{subject_prefix}] Public IP changed"
    message["From"] = username
    message["To"] = recipient
    message.attach(MIMEText(body, "plain", "utf-8"))

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(host, port, timeout=30, context=context) as smtp:
        smtp.login(username, password)
        smtp.sendmail(username, [recipient], message.as_string())


def main():
    current = fetch_public_ipv4()
    previous = STATE_FILE.read_text(encoding="ascii").strip() if STATE_FILE.exists() else ""
    if current == previous:
        print(f"Public IPv4 unchanged: {current}")
        return 0

    notify_initial = os.environ.get("NOTIFY_INITIAL", "false").lower() in {"1", "true", "yes"}
    if previous or notify_initial:
        send_notification(previous, current)
        print(f"Public IPv4 notification sent: {previous or '(none)'} -> {current}")
    else:
        print(f"Initial public IPv4 recorded: {current}")
    save_address(current)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Public IP check failed: {error}", file=sys.stderr)
        raise SystemExit(1)
