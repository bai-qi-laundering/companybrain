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
import traceback
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
import numpy as np
from onvif import ONVIFCamera

try:
    cv2.setNumThreads(int(os.environ.get('OPENCV_NUM_THREADS', '1')))
except (cv2.error, ValueError, TypeError):
    pass

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
# Optional public path prefix (e.g. /cam-xxxxxxxxxxxxxxxx). LAN / still works.
TABLET_PATH_PREFIX = os.environ.get('TABLET_PATH_PREFIX', '').rstrip('/')
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


DETECT_FAST_WIDTH = int(os.environ.get('DETECT_FAST_WIDTH', '1280'))
DETECT_MID_WIDTH = int(os.environ.get('DETECT_MID_WIDTH', '1600'))
FRAME_STALE_SECONDS = 0.75
DETECT_INTERVAL_SECONDS = float(os.environ.get('DETECT_INTERVAL_SECONDS', '1.5'))
THOROUGH_INTERVAL_SECONDS = float(os.environ.get('THOROUGH_INTERVAL_SECONDS', '1.0'))
FRAME_WATCHDOG_SECONDS = float(os.environ.get('FRAME_WATCHDOG_SECONDS', '8'))
RECONNECT_BACKOFF = (2, 4, 8, 15, 30)
FFMPEG_CAPTURE_OPTIONS = 'rtsp_transport;tcp|fflags;nobuffer|max_delay;500000'
# Ignore the camera OSD strips when doing the mid-width pass.
OSD_MARGIN = (40, 80, 40, 80)  # left, top, right, bottom
TEST_LABEL = '測試卡片'
TEST_PHOTO_PREFIX = 'TEST_'

_stream_lock = threading.Lock()
_stream = {'ok': False, 'last_frame_t': 0.0}


def mark_stream_frame(when=None):
    with _stream_lock:
        _stream['ok'] = True
        _stream['last_frame_t'] = float(when if when is not None else time.monotonic())


def mark_stream_down():
    with _stream_lock:
        _stream['ok'] = False


def stream_health(now=None, watchdog=None):
    now = time.monotonic() if now is None else now
    watchdog = FRAME_WATCHDOG_SECONDS if watchdog is None else watchdog
    with _stream_lock:
        ok = bool(_stream['ok'])
        last = float(_stream['last_frame_t'] or 0.0)
    age = (now - last) if last else None
    live = bool(ok and age is not None and age < watchdog)
    return {
        'stream': live,
        'lastFrameSeconds': None if age is None else round(age, 2),
    }


def should_reconnect(last_frame_t, now, started_at, watchdog=None):
    watchdog = FRAME_WATCHDOG_SECONDS if watchdog is None else watchdog
    if last_frame_t:
        return (now - last_frame_t) >= watchdog
    return (now - started_at) >= watchdog


def next_backoff(seconds):
    for step in RECONNECT_BACKOFF:
        if seconds < step:
            return step
    return RECONNECT_BACKOFF[-1]


def close_capture(cap, reader=None, stop_event=None, timeout=3):
    """Stop the reader thread before releasing the capture.

    Releasing while cap.read() is running in another thread can abort
    the process with FFmpeg/glibc malloc corruption.
    """
    if stop_event is not None:
        stop_event.set()
    if reader is not None and reader.is_alive():
        reader.join(timeout=timeout)
    if cap is not None:
        try:
            cap.release()
        except Exception:
            pass
    if reader is not None and reader.is_alive():
        reader.join(timeout=2)


def open_rtsp_capture(uri, user, pwd):
    os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = FFMPEG_CAPTURE_OPTIONS
    cap = cv2.VideoCapture()
    try:
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000)
    except (AttributeError, TypeError, cv2.error):
        pass
    if not cap.open(auth_uri(uri, user, pwd), cv2.CAP_FFMPEG):
        try:
            cap.release()
        except Exception:
            pass
        return None
    if not cap.isOpened():
        cap.release()
        return None
    return cap


def _resize_to_width(frame, width):
    height, current = frame.shape[:2]
    scale = min(1, float(width) / current)
    if scale >= 1:
        return frame, 1.0
    return cv2.resize(frame, None, fx=scale, fy=scale), scale


def _table_roi(frame):
    height, width = frame.shape[:2]
    left, top, right, bottom = OSD_MARGIN
    left = min(left, max(0, width // 16))
    right = min(right, max(0, width // 16))
    top = min(top, max(0, height // 8))
    bottom = min(bottom, max(0, height // 8))
    x0, x1 = left, width - right
    y0, y1 = top, height - bottom
    if y1 - y0 < 200 or x1 - x0 < 200:
        return frame, (0, 0)
    return frame[y0:y1, x0:x1], (x0, y0)


def _quad_to_native(pts, scale, offset=(0, 0)):
    if pts is None or len(pts) == 0:
        return None
    quad = pts[0] if getattr(pts, 'ndim', 0) == 3 else pts
    ox, oy = offset
    return np.asarray(quad, dtype=np.float32) / float(scale) + np.array([ox, oy], dtype=np.float32)


def _crop_around_quad(frame, quad, pad_ratio=0.45, min_size=320):
    height, width = frame.shape[:2]
    xs = quad[:, 0]
    ys = quad[:, 1]
    sides = [float(np.linalg.norm(quad[i] - quad[(i + 1) % 4])) for i in range(4)]
    pad = max((max(sides) if sides else 0) * pad_ratio, 24)
    x0 = max(0, int(xs.min() - pad))
    y0 = max(0, int(ys.min() - pad))
    x1 = min(width, int(xs.max() + pad))
    y1 = min(height, int(ys.max() + pad))
    if x1 - x0 < min_size or y1 - y0 < min_size:
        cx, cy = int(xs.mean()), int(ys.mean())
        half = max(min_size // 2, 1)
        x0, x1 = max(0, cx - half), min(width, cx + half)
        y0, y1 = max(0, cy - half), min(height, cy + half)
    return frame[y0:y1, x0:x1]


def _decode_one(detector, image):
    code, pts, _ = detector.detectAndDecode(image)
    return (code or '').strip(), pts


def decode_qr(detector, frame, thorough=True):
    """Read a QR code. Must never run on the RTSP capture thread.

    Try the proven 1280-wide path first. If that is empty and thorough=True,
    try a mid-width (default 1600) pass on the table region, and a
    native-resolution crop around any detected quad. The cheap path is used
    most of the time so the NAS is not at 300%+ CPU. Do not run
    detectAndDecode on a full 2560 frame.
    """
    if frame is None or getattr(frame, 'size', 0) == 0:
        return ''
    small, scale = _resize_to_width(frame, DETECT_FAST_WIDTH)
    code, pts = _decode_one(detector, small)
    if code:
        return code
    if pts is not None and len(pts):
        quad = _quad_to_native(pts, scale)
        if quad is not None:
            code, _ = _decode_one(detector, _crop_around_quad(frame, quad))
            if code:
                return code
    if not thorough:
        return ''
    roi, offset = _table_roi(frame)
    mid, mid_scale = _resize_to_width(roi, DETECT_MID_WIDTH)
    code, pts = _decode_one(detector, mid)
    if code:
        return code
    if pts is not None and len(pts):
        quad = _quad_to_native(pts, mid_scale, offset)
        if quad is not None:
            code, _ = _decode_one(detector, _crop_around_quad(frame, quad))
            if code:
                return code
    return ''


def current_stage():
    with _lock:
        return _stage


def load_state():
    global _stage, _recent, _capture_id
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
            ids = []
            for item in _recent:
                try:
                    ids.append(int((item or {}).get('id') or 0))
                except (TypeError, ValueError):
                    pass
            if ids:
                _capture_id = max(_capture_id, max(ids))
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


def record_test_capture():
    """Localhost-only tablet check: a clearly marked row, no CompanyBrain upload."""
    timestamp = datetime.now().astimezone()
    filename = TEST_PHOTO_PREFIX + timestamp.strftime('%Y%m%d_%H%M%S_%f') + '.jpg'
    path = OUT / filename
    image = np.zeros((180, 240, 3), dtype=np.uint8)
    image[:] = (40, 90, 40)
    cv2.putText(image, 'TEST', (40, 110), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3)
    if not cv2.imwrite(str(path), image):
        raise OSError('Failed to write test photo')
    return record_capture({
        'at': timestamp.isoformat(timespec='seconds'),
        'label': TEST_LABEL,
        'stage': current_stage(),
        'photo': filename,
        'status': 'stored',
    })


def cleanup_test_captures():
    removed = []
    with _lock:
        kept = []
        for item in _recent:
            photo = str(item.get('photo') or '')
            label = str(item.get('label') or '')
            if photo.startswith(TEST_PHOTO_PREFIX) or label == TEST_LABEL:
                removed.append(photo)
            else:
                kept.append(item)
        _recent[:] = kept
        rows = list(_recent)
        persist_recent(rows)
    for name in removed:
        if name:
            try:
                (OUT / name).unlink()
            except OSError:
                pass
    broadcast({'type': 'status', 'recent': rows, 'stage': current_stage()})
    return len(removed)


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


def tablet_request_path(raw_path):
    """Strip TABLET_PATH_PREFIX when present. Return (path, redirect_to_or_None)."""
    path = raw_path or '/'
    prefix = TABLET_PATH_PREFIX
    if prefix and path == prefix:
        return '/', prefix + '/'
    if prefix and path.startswith(prefix + '/'):
        stripped = path[len(prefix):] or '/'
        return stripped, None
    return path, None


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
        path, redirect = tablet_request_path(urlsplit(self.path).path)
        if redirect:
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header('Location', redirect)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return
        if path in ('/', '/index.html'):
            self._send(200, (APP_DIR / 'tablet.html').read_bytes(), 'text/html; charset=utf-8')
            return
        if path == '/manifest.webmanifest':
            self._send(200, (APP_DIR / 'manifest.webmanifest').read_bytes(), 'application/manifest+json')
            return
        if path == '/api/status':
            with _lock:
                payload = {'stage': _stage, 'recent': list(_recent)}
            payload.update(stream_health())
            body = json.dumps(payload, ensure_ascii=False)
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
                        self.wfile.write(b'data: {"type":"ping"}\n\n')
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

    def _is_loopback(self):
        return self.client_address[0] in ('127.0.0.1', '::1')

    def do_POST(self):
        path, redirect = tablet_request_path(urlsplit(self.path).path)
        if redirect:
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header('Location', redirect)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return
        if path in ('/api/test-capture', '/api/test-capture/cleanup'):
            if not self._is_loopback():
                self._send(HTTPStatus.FORBIDDEN, '{"error":"localhost only"}')
                return
            length = int(self.headers.get('Content-Length') or 0)
            if length > 0:
                self.rfile.read(min(length, 4096))
            try:
                if path.endswith('/cleanup'):
                    removed = cleanup_test_captures()
                    self._send(200, json.dumps({'ok': True, 'removed': removed}, ensure_ascii=False))
                else:
                    entry = record_test_capture()
                    self._send(200, json.dumps({
                        'ok': True, 'test': True, 'id': entry['id'],
                        'photo': entry['photo'], 'label': entry['label'],
                        'stage': entry['stage'],
                    }, ensure_ascii=False))
            except (OSError, ValueError):
                self._send(HTTPStatus.INTERNAL_SERVER_ERROR, '{"error":"test capture failed"}')
            return
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


def list_stream_uris(user, pwd):
    camera = ONVIFCamera(HOST, PORT, user, pwd)
    media = camera.create_media_service()
    uris = []
    for profile in media.GetProfiles():
        req = media.create_type('GetStreamUri')
        req.StreamSetup = {'Stream': 'RTP-Unicast', 'Transport': {'Protocol': 'RTSP'}}
        req.ProfileToken = profile.token
        uris.append(media.GetStreamUri(req).Uri)
    return uris


def open_first_stream(uris, user, pwd):
    for uri in uris:
        cap = open_rtsp_capture(uri, user, pwd)
        if cap is not None:
            return cap
    return None


def main(uris=None):
    print('Laundry QR camera with tablet confirm page and CompanyBrain pending queue.', flush=True)
    user = os.environ['CAMERA_USERNAME']
    pwd = os.environ['CAMERA_PASSWORD']
    if uris is None:
        uris = list_stream_uris(user, pwd)
    cap = open_first_stream(uris, user, pwd)
    if cap is None:
        mark_stream_down()
        raise RuntimeError('No usable RTSP profile')
    detector = cv2.QRCodeDetector()
    latest = {'frame': None, 't': 0.0}
    latest_lock = threading.Lock()
    stream_ok = threading.Event()
    stream_ok.set()
    stop_capture = threading.Event()

    def capture_loop():
        try:
            while not stop_capture.is_set():
                ok, frame = cap.read()
                if not ok:
                    break
                seen = time.monotonic()
                with latest_lock:
                    latest['frame'] = frame
                    latest['t'] = seen
                mark_stream_frame(seen)
        finally:
            stream_ok.clear()
            mark_stream_down()

    reader = threading.Thread(target=capture_loop, name='camera-capture', daemon=True)
    reader.start()
    last_photo = 0.0
    last_seen_code = None
    seen_since = 0.0
    last_frame_t = 0.0
    last_detect = 0.0
    last_thorough = 0.0
    started_at = time.monotonic()
    log = OUT / 'capture_log.csv'
    print('Watching QR codes; capture interval 8 seconds. Current stage:', current_stage(), flush=True)
    stopped = False
    try:
        while stream_ok.is_set():
            now = time.monotonic()
            with latest_lock:
                raw = latest['frame']
                frame_t = latest['t']
            if should_reconnect(frame_t, now, started_at):
                waited = now - (frame_t or started_at)
                print('No frame for %.1fs. Reconnecting.' % waited, flush=True)
                break
            if raw is None or frame_t == last_frame_t:
                time.sleep(0.02)
                continue
            last_frame_t = frame_t
            if now - last_detect < DETECT_INTERVAL_SECONDS:
                continue
            last_detect = now
            frame = raw.copy()
            thorough = (now - last_thorough) >= THOROUGH_INTERVAL_SECONDS
            code = decode_qr(detector, frame, thorough=thorough)
            if thorough:
                last_thorough = time.monotonic()
            now = time.monotonic()
            leftover = DETECT_INTERVAL_SECONDS - (now - last_detect)
            if leftover > 0:
                time.sleep(leftover)
            with latest_lock:
                newest_t = latest['t']
            if (now - frame_t) > FRAME_STALE_SECONDS or (newest_t - frame_t) > FRAME_STALE_SECONDS:
                continue
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
        stopped = True
        print('\nStopped.', flush=True)
        raise
    finally:
        close_capture(cap, reader, stop_capture)
        mark_stream_down()
        if not stopped:
            print('Stream interrupted. Reconnecting.', flush=True)
    return uris


if __name__ == '__main__':
    load_state()
    tablet = start_tablet_server()
    stop = threading.Event()
    worker = threading.Thread(target=delivery_worker, args=(stop,), daemon=True)
    worker.start()
    backoff = RECONNECT_BACKOFF[0]
    uris = None
    try:
        while True:
            started = time.monotonic()
            try:
                uris = main(uris)
                if time.monotonic() - started > FRAME_WATCHDOG_SECONDS:
                    backoff = RECONNECT_BACKOFF[0]
                print('Retrying stream in %s seconds.' % backoff, flush=True)
                time.sleep(backoff)
                backoff = next_backoff(backoff)
            except KeyboardInterrupt:
                break
            except Exception as exc:
                mark_stream_down()
                print('Camera interrupted (%s). Retrying in %s seconds.' % (type(exc).__name__, backoff), flush=True)
                traceback.print_exc()
                time.sleep(backoff)
                backoff = next_backoff(backoff)
                uris = None
    finally:
        stop.set()
        tablet.shutdown()
        worker.join(timeout=3)
