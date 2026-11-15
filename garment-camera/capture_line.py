"""ONVIF QR camera with a LAN tablet confirm page and CompanyBrain pending-photo queue.

Environment: CAMERA_USERNAME, CAMERA_PASSWORD, CAMERA_HOST, CAMERA_ONVIF_PORT,
PHOTO_DIR, COMPANYBRAIN_URL (https://...), CAMERA_API_KEY,
TABLET_BIND, TABLET_PORT.
"""
import base64
import csv
import json
import os
import threading
import time
import uuid
import urllib.error
import urllib.request
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, quote, unquote

import cv2
from onvif import ONVIFCamera

HOST = os.environ.get('CAMERA_HOST', '192.168.1.87')
PORT = int(os.environ.get('CAMERA_ONVIF_PORT', '8087'))
INTERVAL_SECONDS = 8
STABLE_SECONDS = 1.0
OUT = Path(os.environ.get('PHOTO_DIR', '/data/photos'))
OUT.mkdir(parents=True, exist_ok=True)
QUEUE = OUT / 'pending'
QUEUE.mkdir(exist_ok=True)
API_URL = os.environ.get('COMPANYBRAIN_URL', '').rstrip('/')
API_KEY = os.environ.get('CAMERA_API_KEY', '')
MAX_JPEG = 2_500_000
TABLET_BIND = os.environ.get('TABLET_BIND', '0.0.0.0')
TABLET_PORT = int(os.environ.get('TABLET_PORT', '8790'))
STAGE_PATH = Path(os.environ.get('STAGE_FILE', str(OUT / 'stage.json')))
RECENT_PATH = Path(os.environ.get('RECENT_FILE', str(OUT / 'recent.json')))
APP_DIR = Path(__file__).resolve().parent
STAGES = ('洗前', '洗後')

_lock = threading.Lock()
_stage = '洗前'
_recent = []
_sse = []
_capture_id = 0


def auth_uri(uri, user, pwd):
    p = urlsplit(uri)
    if p.scheme.lower() != 'rtsp' or not p.hostname:
        raise ValueError('Invalid RTSP URI')
    host = f'[{p.hostname}]' if ':' in p.hostname else p.hostname
    netloc = f'{quote(user, safe="")}:{quote(pwd, safe="")}@{host}'
    if p.port:
        netloc += f':{p.port}'
    return urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment))


def encode_photo(frame):
    """Keep the original photo locally; compress upload to server's 2.5MB limit."""
    for width in (1920, 1600, 1280, 960, 720):
        height, original_width = frame.shape[:2]
        scale = min(1, width / original_width)
        image = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1 else frame
        for quality in (85, 75, 65, 55):
            ok, data = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, quality])
            if ok and len(data) <= MAX_JPEG:
                return data.tobytes()
    raise ValueError('Photo could not fit 2.5MB upload limit')


DETECT_FALLBACK_WIDTH = 1280


def decode_qr(detector, frame):
    """Read a QR code from a camera frame.

    Try the native frame first so an 8 cm printed symbol stays large enough
    in a 2560-wide view. If that yields nothing, fall back to the previous
    path of shrinking the frame to width 1280. OpenCV's QRCodeDetector can
    succeed on one scale and fail on the other.
    """
    code, _, _ = detector.detectAndDecode(frame)
    code = (code or '').strip()
    if code:
        return code
    height, width = frame.shape[:2]
    scale = min(1, DETECT_FALLBACK_WIDTH / width)
    if scale >= 1:
        return ''
    small = cv2.resize(frame, None, fx=scale, fy=scale)
    code, _, _ = detector.detectAndDecode(small)
    return (code or '').strip()


def current_stage():
    with _lock:
        return _stage


def load_state():
    global _stage, _recent
    try:
        data = json.loads(STAGE_PATH.read_text(encoding='utf-8'))
        if data.get('stage') in STAGES:
            _stage = data['stage']
    except (OSError, ValueError):
        pass
    try:
        rows = json.loads(RECENT_PATH.read_text(encoding='utf-8'))
        if isinstance(rows, list):
            _recent = rows[-30:]
    except (OSError, ValueError):
        pass


def persist_stage(stage):
    temp = STAGE_PATH.with_suffix('.tmp')
    temp.write_text(json.dumps({'stage': stage}, ensure_ascii=False), encoding='utf-8')
    temp.replace(STAGE_PATH)


def persist_recent(rows):
    temp = RECENT_PATH.with_suffix('.tmp')
    temp.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
    temp.replace(RECENT_PATH)


def set_stage(stage):
    if stage not in STAGES:
        raise ValueError('invalid stage')
    with _lock:
        global _stage
        _stage = stage
        persist_stage(stage)
        snapshot = list(_recent)
    broadcast({'type': 'stage', 'stage': stage, 'recent': snapshot})
    return stage


def record_capture(entry):
    global _capture_id, _recent
    with _lock:
        _capture_id += 1
        entry = dict(entry)
        entry['id'] = _capture_id
        _recent = (_recent + [entry])[-30:]
        rows = list(_recent)
        persist_recent(rows)
    broadcast({'type': 'capture', **entry, 'recent': rows, 'stage': current_stage()})
    return entry


def mark_recent(photo, status):
    with _lock:
        changed = False
        for item in _recent:
            if item.get('photo') == photo:
                item['status'] = status
                changed = True
        rows = list(_recent)
        if changed:
            persist_recent(rows)
    if changed:
        broadcast({'type': 'status', 'photo': photo, 'status': status, 'recent': rows, 'stage': current_stage()})


def broadcast(event):
    payload = ('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode('utf-8')
    with _lock:
        clients = list(_sse)
    alive = []
    for wait, put in clients:
        try:
            put(payload)
            alive.append((wait, put))
        except Exception:
            pass
    with _lock:
        _sse[:] = [pair for pair in _sse if pair in alive]


def queue_photo(label, frame, filename, stage=None):
    if stage is None:
        stage = current_stage()
    encoded = encode_photo(frame)
    payload = {
        'photoId': str(uuid.uuid4()),
        'label': label,
        'stage': stage,
        'imageBase64': base64.b64encode(encoded).decode('ascii'),
    }
    target = QUEUE / (Path(filename).stem + '.json')
    temp = target.with_suffix('.tmp')
    with temp.open('w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(target)
    return target, stage


def delivery_worker(stop):
    if not API_URL or not API_KEY:
        print('Photo upload disabled: configure COMPANYBRAIN_URL and CAMERA_API_KEY.', flush=True)
        return
    if not API_URL.startswith('https://'):
        print('Photo upload disabled: COMPANYBRAIN_URL must use HTTPS.', flush=True)
        return
    while not stop.is_set():
        jobs = sorted(QUEUE.glob('*.json'))
        if not jobs:
            stop.wait(2)
            continue
        for job in jobs:
            if stop.is_set():
                return
            try:
                payload = json.loads(job.read_text(encoding='utf-8'))
                if 'photoId' not in payload:
                    payload['photoId'] = str(uuid.uuid5(uuid.NAMESPACE_URL, 'garment-camera:' + job.stem))
                    temp = job.with_suffix('.tmp')
                    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
                    temp.replace(job)
                if payload.get('stage') not in STAGES:
                    payload['stage'] = current_stage()
                    temp = job.with_suffix('.tmp')
                    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
                    temp.replace(job)
                body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
                request = urllib.request.Request(
                    API_URL + '/api/camera/photo', body,
                    headers={'Authorization': 'Bearer ' + API_KEY,
                             'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(request, timeout=25) as response:
                    result = json.load(response)
                    if not result.get('ok'):
                        raise ValueError('Server did not confirm successful storage')
                job.unlink()
                mark_recent(job.stem + '.jpg', 'stored')
                print('PHOTO STORED:', job.stem, result.get('hotel'), result.get('stage'), result.get('kind'), flush=True)
            except urllib.error.HTTPError as exc:
                body = exc.read(500).decode('utf-8', 'replace').replace('\n', ' ')
                print('PHOTO PENDING:', job.stem, 'HTTP', exc.code, body[:200], flush=True)
                monthly = exc.code == 429 or 'HTTP 429' in body or 'monthly limit' in body.lower()
                if monthly:
                    print('Upload paused: official account monthly message limit. Will retry in 6 hours.', flush=True)
                stop.wait(21600 if monthly else 30)
                break
            except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
                print('PHOTO PENDING:', job.stem, type(exc).__name__, flush=True)
                stop.wait(30)
                break


class TabletHandler(BaseHTTPRequestHandler):
    server_version = 'GarmentTablet/1.0'

    def log_message(self, fmt, *args):
        print('TABLET', self.address_string(), fmt % args, flush=True)

    def _send(self, status, body, content_type='application/json; charset=utf-8', cache='no-store'):
        data = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/', '/index.html'):
            self._send(200, (APP_DIR / 'tablet.html').read_bytes(), 'text/html; charset=utf-8')
            return
        if path == '/manifest.webmanifest':
            self._send(200, (APP_DIR / 'manifest.webmanifest').read_bytes(), 'application/manifest+json')
            return
        if path == '/api/status':
            with _lock:
                body = json.dumps({'stage': _stage, 'recent': list(_recent)}, ensure_ascii=False)
            self._send(200, body)
            return
        if path == '/api/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            queue = []
            ready = threading.Event()

            def put(item):
                queue.append(item)
                ready.set()

            with _lock:
                _sse.append((ready, put))
                snapshot = json.dumps({'type': 'hello', 'stage': _stage, 'recent': list(_recent)}, ensure_ascii=False)
            try:
                self.wfile.write(('data: ' + snapshot + '\n\n').encode('utf-8'))
                self.wfile.flush()
                while True:
                    if not ready.wait(15):
                        self.wfile.write(b': keepalive\n\n')
                        self.wfile.flush()
                        continue
                    ready.clear()
                    while queue:
                        self.wfile.write(queue.pop(0))
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            finally:
                with _lock:
                    _sse[:] = [pair for pair in _sse if pair[1] is not put]
            return
        if path.startswith('/photos/'):
            name = unquote(path[len('/photos/'):])
            if Path(name).name != name or not name.endswith('.jpg') or not all(c.isalnum() or c in '._-' for c in name):
                self._send(HTTPStatus.NOT_FOUND, '{"error":"not found"}')
                return
            target = OUT / name
            if not target.is_file():
                self._send(HTTPStatus.NOT_FOUND, '{"error":"not found"}')
                return
            self._send(200, target.read_bytes(), 'image/jpeg', 'private, max-age=60')
            return
        self._send(HTTPStatus.NOT_FOUND, '{"error":"not found"}')

    def do_POST(self):
        path = urlsplit(self.path).path
        if path != '/api/stage':
            self._send(HTTPStatus.NOT_FOUND, '{"error":"not found"}')
            return
        length = int(self.headers.get('Content-Length') or 0)
        if length < 2 or length > 4096:
            self._send(HTTPStatus.BAD_REQUEST, '{"error":"invalid body"}')
            return
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            stage = set_stage(str(data.get('stage') or '').strip())
        except (ValueError, OSError):
            self._send(HTTPStatus.BAD_REQUEST, '{"error":"請選擇洗前或洗後"}')
            return
        self._send(200, json.dumps({'ok': True, 'stage': stage}, ensure_ascii=False))


def start_tablet_server():
    server = ThreadingHTTPServer((TABLET_BIND, TABLET_PORT), TabletHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print('Tablet page listening on http://%s:%s/ (publish only on the LAN address).' % (TABLET_BIND, TABLET_PORT), flush=True)
    return server


def main():
    print('Laundry QR camera with tablet confirm page and CompanyBrain pending queue.', flush=True)
    user = os.environ['CAMERA_USERNAME']
    pwd = os.environ['CAMERA_PASSWORD']
    camera = ONVIFCamera(HOST, PORT, user, pwd)
    media = camera.create_media_service()
    profiles = media.GetProfiles()
    os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
    cap = None
    for profile in profiles:
        req = media.create_type('GetStreamUri')
        req.StreamSetup = {'Stream': 'RTP-Unicast', 'Transport': {'Protocol': 'RTSP'}}
        req.ProfileToken = profile.token
        uri = media.GetStreamUri(req).Uri
        candidate = cv2.VideoCapture(auth_uri(uri, user, pwd), cv2.CAP_FFMPEG)
        if candidate.isOpened():
            cap = candidate
            break
        candidate.release()
    if cap is None:
        raise RuntimeError('No usable RTSP profile')
    detector = cv2.QRCodeDetector()
    last_photo = 0.0
    last_seen_code = None
    seen_since = 0.0
    last_scan = 0.0
    scan_interval = 1.0 / 3.0
    log = OUT / 'capture_log.csv'
    print('Watching QR codes; capture interval 8 seconds. Current stage:', current_stage(), flush=True)
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print('Stream interrupted. Reconnecting.', flush=True)
                break
            scan_time = time.monotonic()
            if scan_time - last_scan < scan_interval:
                continue
            last_scan = scan_time
            code = decode_qr(detector, frame)
            now = time.monotonic()
            if not code:
                last_seen_code = None
                seen_since = 0.0
                continue
            if code != last_seen_code:
                last_seen_code = code
                seen_since = now
                print('QR detected; waiting for stable recognition...', flush=True)
            if now - seen_since < STABLE_SECONDS or now - last_photo < INTERVAL_SECONDS:
                continue
            timestamp = datetime.now().astimezone()
            filename = timestamp.strftime('%Y%m%d_%H%M%S_%f') + '.jpg'
            path = OUT / filename
            if not cv2.imwrite(str(path), frame):
                print('Failed to save image', flush=True)
                continue
            with log.open('a', encoding='utf-8-sig', newline='') as f:
                writer = csv.writer(f)
                if f.tell() == 0:
                    writer.writerow(['timestamp', 'hotel_qr', 'stage', 'photo'])
                writer.writerow([timestamp.isoformat(timespec='seconds'), code, current_stage(), filename])
            stage = current_stage()
            try:
                queue_photo(code, frame, filename, stage)
                record_capture({
                    'at': timestamp.isoformat(timespec='seconds'),
                    'label': code,
                    'stage': stage,
                    'photo': filename,
                    'status': 'queued',
                })
            except (OSError, ValueError) as exc:
                print('Photo saved but upload queue failed:', type(exc).__name__, flush=True)
            last_photo = now
            print('PHOTO SAVED: %s | QR: %s | STAGE: %s' % (path.name, code, stage), flush=True)
    except KeyboardInterrupt:
        print('\nStopped.', flush=True)
        raise
    finally:
        cap.release()


if __name__ == '__main__':
    load_state()
    tablet = start_tablet_server()
    stop = threading.Event()
    worker = threading.Thread(target=delivery_worker, args=(stop,), daemon=True)
    worker.start()
    try:
        while True:
            try:
                main()
            except KeyboardInterrupt:
                break
            except Exception as exc:
                print('Camera interrupted (%s). Retrying in 10 seconds.' % type(exc).__name__, flush=True)
                time.sleep(10)
    finally:
        stop.set()
        tablet.shutdown()
        worker.join(timeout=3)
