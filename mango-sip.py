#!/usr/bin/env python3
"""
Mango SIP listener for OrderDesk.
Registers as SIP endpoint, fires HTTP notification on incoming calls.

Run: python3 mango-sip.py
Restart on crash: while true; do python3 mango-sip.py; sleep 5; done
"""

import os
import socket
import hashlib
import re
import time
import json
import sys
import random
import urllib.request
import urllib.error
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [SIP] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('mango-sip')

# ── Configuration ──────────────────────────────────────────────────────────────
SIP_SERVER_IP   = os.environ.get('SIP_SERVER_IP',   '81.88.86.37')
SIP_SERVER_PORT = int(os.environ.get('SIP_SERVER_PORT', '5060'))
SIP_USER        = os.environ.get('SIP_USER',        'user12')
SIP_DOMAIN      = os.environ.get('SIP_DOMAIN',      'vpbx400107647.mangosip.ru')
SIP_PASSWORD    = os.environ.get('SIP_PASSWORD',    'hL43Ir2X')
LOCAL_BIND_PORT = int(os.environ.get('LOCAL_BIND_PORT', '5060'))
BACKEND_URL     = os.environ.get('BACKEND_URL',     'http://127.0.0.1:3001/api/mango/call')
REGISTER_EVERY  = int(os.environ.get('REGISTER_EVERY', '90'))  # re-register interval (Expires=120s)

# ── State ──────────────────────────────────────────────────────────────────────
sock          = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
external_ip   = '127.0.0.1'
external_port = LOCAL_BIND_PORT
_cseq         = random.randint(100, 9999)          # unique per run
_reg_call_id  = f'od-reg-{random.randint(1,999999):06d}@od'  # unique per run
# call_id -> (original_headers, to_tag)
pending: dict[str, tuple[list[str], str]] = {}


# ── SIP helpers ────────────────────────────────────────────────────────────────
def md5hex(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


def digest_auth(user: str, realm: str, password: str,
                method: str, uri: str, nonce: str) -> str:
    ha1 = md5hex(f'{user}:{realm}:{password}')
    ha2 = md5hex(f'{method}:{uri}')
    res = md5hex(f'{ha1}:{nonce}:{ha2}')
    return (f'Authorization: Digest username="{user}",realm="{realm}",'
            f'nonce="{nonce}",uri="{uri}",response="{res}",algorithm=MD5')


def get_header(lines: list[str], name: str) -> str:
    prefix = name.lower() + ':'
    return next((l for l in lines if l.lower().startswith(prefix)), '')


def parse_message(data: str) -> tuple[str, list[str]]:
    header_block = data.split('\r\n\r\n')[0]
    lines = header_block.split('\r\n')
    return lines[0], lines[1:]


def make_response(req_hdrs: list[str], code: int, phrase: str,
                  to_tag: str | None = None) -> str:
    via     = get_header(req_hdrs, 'via')
    from_h  = get_header(req_hdrs, 'from')
    to_h    = get_header(req_hdrs, 'to')
    call_id = get_header(req_hdrs, 'call-id')
    cseq    = get_header(req_hdrs, 'cseq')

    if to_tag and ';tag=' not in to_h:
        to_h = to_h + f';tag={to_tag}'

    return (
        f'SIP/2.0 {code} {phrase}\r\n'
        f'{via}\r\n'
        f'{from_h}\r\n'
        f'{to_h}\r\n'
        f'{call_id}\r\n'
        f'{cseq}\r\n'
        f'Content-Length: 0\r\n\r\n'
    )


def extract_phone(header_line: str) -> str:
    m = re.search(r'sip:(\+?[\d]+)@', header_line)
    if m:
        return m.group(1)
    m2 = re.search(r'tel:(\+?[\d]+)', header_line)
    return m2.group(1) if m2 else header_line


def send_sip(msg: str) -> None:
    sock.sendto(msg.encode(), (SIP_SERVER_IP, SIP_SERVER_PORT))


def next_cseq() -> int:
    global _cseq
    n = _cseq
    _cseq += 1
    return n


# ── REGISTER ───────────────────────────────────────────────────────────────────
def build_register(cseq: int, auth_hdr: str = '') -> str:
    contact = f'sip:{SIP_USER}@{external_ip}:{external_port}'
    auth_line = (auth_hdr + '\r\n') if auth_hdr else ''
    return (
        f'REGISTER sip:{SIP_DOMAIN} SIP/2.0\r\n'
        f'Via: SIP/2.0/UDP {external_ip}:{external_port};'
        f'branch=z9hG4bKod{cseq:06x};rport\r\n'
        f'Max-Forwards: 70\r\n'
        f'To: <sip:{SIP_USER}@{SIP_DOMAIN}>\r\n'
        f'From: <sip:{SIP_USER}@{SIP_DOMAIN}>;tag=orderdesk\r\n'
        f'Call-ID: {_reg_call_id}\r\n'
        f'CSeq: {cseq} REGISTER\r\n'
        f'Contact: <{contact}>\r\n'
        f'Expires: 120\r\n'
        f'User-Agent: OrderDesk/1.0\r\n'
        f'{auth_line}'
        f'Content-Length: 0\r\n\r\n'
    )


def register() -> bool:
    global external_ip, external_port

    cseq = next_cseq()
    send_sip(build_register(cseq))

    deadline = time.time() + 6
    while time.time() < deadline:
        try:
            data, _ = sock.recvfrom(4096)
        except socket.timeout:
            continue

        text  = data.decode(errors='replace')
        first, hdrs = parse_message(text)

        # Update our external address from Via
        via_line = get_header(hdrs, 'via')
        m_ip   = re.search(r'received=(\d+\.\d+\.\d+\.\d+)', via_line)
        m_port = re.search(r'rport=(\d+)', via_line)
        if m_ip:   external_ip   = m_ip.group(1)
        if m_port: external_port = int(m_port.group(1))

        if first.startswith('SIP/2.0 200'):
            log.info('REGISTER: 200 OK')
            return True

        if 'SIP/2.0 401' in first or 'SIP/2.0 407' in first:
            www = re.search(
                r'(?:WWW|Proxy)-Authenticate:\s*Digest\s+(.+)',
                text, re.IGNORECASE)
            if not www:
                log.error('401 but no WWW-Authenticate')
                return False
            realm_m = re.search(r'realm="([^"]+)"', www.group(1))
            nonce_m = re.search(r'nonce="([^"]+)"', www.group(1))
            if not realm_m or not nonce_m:
                return False
            realm = realm_m.group(1)
            nonce = nonce_m.group(1)
            uri   = f'sip:{SIP_DOMAIN}'
            auth  = digest_auth(SIP_USER, realm, SIP_PASSWORD,
                                'REGISTER', uri, nonce)
            cseq2 = next_cseq()
            send_sip(build_register(cseq2, auth))

            deadline2 = time.time() + 6
            while time.time() < deadline2:
                try:
                    d2, _ = sock.recvfrom(4096)
                except socket.timeout:
                    continue
                f2 = d2.decode(errors='replace').split('\r\n')[0]
                log.info(f'REGISTER: {f2}')
                return f2.startswith('SIP/2.0 200')
            return False

    log.warning('REGISTER: timeout')
    return False


# ── INVITE / CANCEL ────────────────────────────────────────────────────────────
def notify_backend(from_num: str, to_num: str, call_id: str) -> None:
    payload = json.dumps({
        'from': from_num,
        'to': to_num,
        'callId': call_id,
        'sipUser': SIP_USER,
    }).encode()
    try:
        req = urllib.request.Request(
            BACKEND_URL, data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        urllib.request.urlopen(req, timeout=3)
        log.info(f'Backend notified: {from_num}')
    except Exception as e:
        log.warning(f'Backend notify failed: {e}')


def handle_invite(hdrs: list[str]) -> None:
    from_h   = get_header(hdrs, 'from')
    to_h     = get_header(hdrs, 'to')
    call_id  = get_header(hdrs, 'call-id').split(':', 1)[-1].strip()
    from_num = extract_phone(from_h)
    to_num   = extract_phone(to_h)
    tag      = f'od{int(time.time() * 1000) & 0xFFFFFF:06x}'

    pending[call_id] = (hdrs, tag)

    send_sip(make_response(hdrs, 100, 'Trying'))
    notify_backend(from_num, to_num, call_id)
    send_sip(make_response(hdrs, 180, 'Ringing', tag))

    log.info(f'INVITE from={from_num} to={to_num}')


def handle_cancel(hdrs: list[str]) -> None:
    call_id = get_header(hdrs, 'call-id').split(':', 1)[-1].strip()
    send_sip(make_response(hdrs, 200, 'OK'))

    if call_id in pending:
        inv_hdrs, inv_tag = pending.pop(call_id)
        send_sip(make_response(inv_hdrs, 487, 'Request Terminated', inv_tag))
        log.info(f'CANCEL handled for call-id: {call_id}')


# ── Main loop ──────────────────────────────────────────────────────────────────
def main() -> None:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(('0.0.0.0', LOCAL_BIND_PORT))
    except OSError as e:
        log.error(f'Cannot bind UDP:{LOCAL_BIND_PORT}: {e}')
        sys.exit(1)
    sock.settimeout(1.0)

    log.info(f'Listening on UDP:{LOCAL_BIND_PORT}')
    log.info(f'SIP account: {SIP_USER}@{SIP_DOMAIN}')

    if not register():
        log.warning('Initial REGISTER failed, will retry...')

    next_reg = time.time() + REGISTER_EVERY

    while True:
        if time.time() >= next_reg:
            register()
            next_reg = time.time() + REGISTER_EVERY

        try:
            data, _ = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except Exception as e:
            log.warning(f'Socket error: {e}')
            continue

        try:
            text  = data.decode(errors='replace')
            first, hdrs = parse_message(text)

            if first.startswith('INVITE '):
                handle_invite(hdrs)
            elif first.startswith('CANCEL '):
                handle_cancel(hdrs)
            elif first.startswith('BYE '):
                send_sip(make_response(hdrs, 200, 'OK'))
                call_id = get_header(hdrs, 'call-id').split(':', 1)[-1].strip()
                pending.pop(call_id, None)
            elif first.startswith('OPTIONS '):
                send_sip(make_response(hdrs, 200, 'OK'))
            # SIP responses (2xx/4xx) in main loop are ignored
        except Exception as e:
            log.warning(f'Packet processing error: {e}')


if __name__ == '__main__':
    main()
