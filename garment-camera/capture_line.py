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
MAX_JPEG = 10_000_000  # LINE originalContentUrl limit
MAX_PREVIEW_JPEG = 1_000_000  # LINE previewImageUrl limit
PREVIEW_MAX_WIDTH = 800
HOLD = OUT / 'pending-unbound'
HOLD_RETRY_SECONDS = 600
CANCELLED = OUT / 'pending-cancelled'
TABLET_BIND = os.environ.get('TABLET_BIND', '0.0.0.0')
TABLET_PORT = int(os.environ.get('TABLET_PORT', '8790'))
# Optional public path prefix (e.g. /cam-xxxxxxxxxxxxxxxx). LAN / still works.
TABLET_PATH_PREFIX = os.environ.get('TABLET_PATH_PREFIX', '').rstrip('/')
STAGE_PATH = Path(os.environ.get('STAGE_FILE', str(OUT / 'stage.json')))
RECENT_PATH = Path(os.environ.get('RECENT_FILE', str(OUT / 'recent.json')))
APP_DIR = Path(__file__).resolve().parent
STAGES = ('洗前', '洗後')
# Home-screen icons. Requests arrive as root-relative paths: LAN `/` is served
# directly, and a Funnel mount is stripped before it reaches this process.
# Manifest icon URLs stay relative so they follow whichever directory served
# manifest.webmanifest.
PWA_ASSETS = {
    '/icon-192.png': ('icon-192.png', 'image/png'),
    '/icon-512.png': ('icon-512.png', 'image/png'),
    '/icon-maskable-512.png': ('icon-maskable-512.png', 'image/png'),
    '/apple-touch-icon.png': ('apple-touch-icon.png', 'image/png'),
    '/favicon-32.png': ('favicon-32.png', 'image/png'),
    '/favicon.ico': ('favicon.ico', 'image/x-icon'),
}

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


def _jpeg_bytes(image, quality):
    ok, data = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise ValueError('JPEG encode failed')
    return data.tobytes()


def encode_photo(frame, original_jpeg=None):
    """Upload the saved JPG as-is when it already fits; otherwise encode a full-res JPEG (max 10MB).

    The uploaded/saved photo is the native stream frame from detection time,
    not a downscaled detect preview. Downscale only as a last resort if even
    low quality cannot fit the LINE limit.
    """
    if original_jpeg and len(original_jpeg) <= MAX_JPEG:
        return original_jpeg
    for quality in (95, 92, 85, 80, 75, 65, 55):
        data = _jpeg_bytes(frame, quality)
        if len(data) <= MAX_JPEG:
            return data
    height, width = frame.shape[:2]
    for target in (1920, 1600, 1280, 960, 720):
        scale = min(1, target / width)
        image = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1 else frame
        for quality in (85, 75, 65, 55):
            data = _jpeg_bytes(image, quality)
            if len(data) <= MAX_JPEG:
                return data
    raise ValueError('Photo could not fit 10MB upload limit')


def encode_preview(frame, max_width=PREVIEW_MAX_WIDTH):
    """Small JPEG for LINE previewImageUrl and the tablet thumbnail (max 1MB)."""
    height, width = frame.shape[:2]
    scale = min(1, float(max_width) / width)
    image = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1 else frame
    for quality in (80, 70, 60, 50):
        data = _jpeg_bytes(image, quality)
        if len(data) <= MAX_PREVIEW_JPEG:
            return data
    raise ValueError('Preview could not fit 1MB LINE limit')


def preview_name(filename):
    return Path(filename).stem + '.thumb.jpg'


def should_hold_upload(status_code):
    """Client errors except rate limits are job-specific; do not block later photos."""
    code = int(status_code or 0)
    return 400 <= code < 500 and code != 429


def hold_job(job, reason):
    HOLD.mkdir(parents=True, exist_ok=True)
    dest = HOLD / job.name
    if job.resolve() != dest.resolve():
        job.replace(dest)
    else:
        os.utime(dest, None)
    mark_recent(job.stem + '.jpg', 'unbound')
    print('PHOTO HELD (will not block queue):', job.stem, reason, flush=True)
    return dest


def due_hold_jobs():
    if not HOLD.exists():
        return []
    now = time.time()
    due = []
    for path in sorted(HOLD.glob('*.json')):
        if now - path.stat().st_mtime >= HOLD_RETRY_SECONDS:
            due.append(path)
    return due


def job_source_jpeg(job):
    return OUT / (Path(job).stem + '.jpg')


def source_jpeg_missing(job):
    return not job_source_jpeg(job).is_file()


def cancel_job(job, reason='source JPEG missing'):
    """Move a queue/hold JSON out of the upload pipeline without deleting it."""
    stamp = datetime.now().astimezone().strftime('%Y%m%d-%H%M')
    dest_dir = CANCELLED / stamp
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / job.name
    if dest.exists():
        dest = dest_dir / (job.stem + '-' + datetime.now().astimezone().strftime('%H%M%S') + '.json')
    if Path(job).resolve() != dest.resolve():
        job.replace(dest)
    mark_recent(job.stem + '.jpg', 'cancelled')
    print('PHOTO CANCELLED (removed from queue):', job.stem, reason, flush=True)
    return dest


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


def _try_decode_region(detector, frame, image, scale, offset=(0, 0)):
    """Decode `image`; if only a quad is found, retry a native crop of `frame`."""
    code, pts = _decode_one(detector, image)
    if code:
        return code
    if pts is not None and len(pts):
        quad = _quad_to_native(pts, scale, offset)
        if quad is not None:
            code, _ = _decode_one(detector, _crop_around_quad(frame, quad))
            if code:
                return code
    return ''


def decode_qr(detector, frame, thorough=True):
    """Read a QR code. Must never run on the RTSP capture thread.

    The original pipeline shrinks the frame to 1280-wide and runs
    OpenCV's QRCodeDetector. Keep that as the cheap fast path on every
    detect tick.

    PR #9 tried the native 2560-wide frame first so an 8 cm symbol stayed
    large enough, then fell back to 1280. PR #10 reverted that because
    detectAndDecode on the uncropped 2560 frame pushed the NAS above 300%
    CPU. When thorough=True, restore a native-resolution pass on the table
    ROI only (OSD margins cropped), then the mid-width (1600) pass, and a
    native crop around any detected quad. Do not run detectAndDecode on
    the uncropped full 2560 frame.
    """
    if frame is None or getattr(frame, 'size', 0) == 0:
        return ''
    small, scale = _resize_to_width(frame, DETECT_FAST_WIDTH)
    code = _try_decode_region(detector, frame, small, scale)
    if code:
        return code
    if not thorough:
        return ''
    roi, offset = _table_roi(frame)
    # Native table pass restores PR #9's 8 cm capability without scanning
    # the full uncropped 2560 frame. Skip when the stream is already <=1280.
    if roi.shape[1] > DETECT_FAST_WIDTH:
        code = _try_decode_region(detector, frame, roi, 1.0, offset)
        if code:
            return code
    mid, mid_scale = _resize_to_width(roi, DETECT_MID_WIDTH)
    if mid.shape[1] < roi.shape[1]:
        code = _try_decode_region(detector, frame, mid, mid_scale, offset)
        if code:
            return code
    return ''


def detection_is_stale(frame_t, decode_done_t, newest_t, stale=FRAME_STALE_SECONDS):
    """True when the decoded frame is older than the stale window."""
    return (decode_done_t - frame_t) > stale or (newest_t - frame_t) > stale


def should_drop_decoded_frame(code, frame_t, decode_done_t, newest_t, stale=FRAME_STALE_SECONDS):
    """Keep a successful decode even if the 2560 pass ran longer than 0.75s.

    On the NAS, a 1280 miss plus native table-ROI decode typically takes 2.5-4s,
    which is always over FRAME_STALE_SECONDS. Dropping those hits made 8 cm
    cards invisible in production even though decode_qr itself succeeded.
    Empty results may still be ignored when stale so a later fresh frame is used.
    """
    if code:
        return False
    return detection_is_stale(frame_t, decode_done_t, newest_t, stale)


def should_clear_seen_code(code, thorough):
    """Fast-path misses must not clear a code that only the thorough pass can read.

    After a native-ROI hit, the next tick is often 1280-only. Clearing the
    seen code there would reset STABLE_SECONDS and a photo would never be saved.
    """
    if code:
        return False
    return bool(thorough)


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
    original = None
    source = OUT / filename
    if source.is_file():
        original = source.read_bytes()
    encoded = encode_photo(frame, original)
    preview = encode_preview(frame)
    payload = {
        'photoId': str(uuid.uuid4()),
        'label': label,
        'stage': stage,
        'imageBase64': base64.b64encode(encoded).decode('ascii'),
        'previewBase64': base64.b64encode(preview).decode('ascii'),
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
    retry_at = {}
    while not stop.is_set():
        jobs = sorted(QUEUE.glob('*.json')) + due_hold_jobs()
        retry_at = {job: retry_at[job] for job in jobs if job in retry_at}
        if not jobs:
            stop.wait(2)
            continue
        for job in jobs:
            if stop.is_set():
                return
            photo_name = job.stem + '.jpg'
            try:
                if source_jpeg_missing(job):
                    cancel_job(job, 'source JPEG missing')
                    continue
                if time.monotonic() < retry_at.get(job, 0):
                    continue
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
                job.unlink(missing_ok=True)
                mark_recent(photo_name, 'stored')
                print('PHOTO STORED:', job.stem, result.get('hotel'), result.get('stage'), result.get('kind'), flush=True)
            except urllib.error.HTTPError as exc:
                err_body = exc.read(500).decode('utf-8', 'replace').replace('\n', ' ')
                if should_hold_upload(exc.code):
                    hold_job(job, 'HTTP %s %s' % (exc.code, err_body[:200]))
                    continue
                print('PHOTO PENDING:', job.stem, 'HTTP', exc.code, err_body[:200], flush=True)
                monthly = exc.code == 429 or 'HTTP 429' in err_body or 'monthly limit' in err_body.lower()
                if monthly:
                    print('This photo will retry in 6 hours due to the message limit.', flush=True)
                # Per-job backoff only: a failed hotel must not block other hotels.
                retry_at[job] = time.monotonic() + (21600 if monthly else 30)
            except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
                print('PHOTO PENDING:', job.stem, type(exc).__name__, flush=True)
                retry_at[job] = time.monotonic() + 30
        stop.wait(2)



def tablet_request_path(raw_path):
    """Strip TABLET_PATH_PREFIX when present. Return (path, redirect_to_or_None).

    An empty path is the app root. Funnel strips the mount before forwarding, so
    a public URL without a trailing slash can arrive here as '' or '/'. Do not
    redirect '/' itself: the browser URL is corrected in tablet.html, and a
    redirect of '/' would target the other service on a shared Funnel port.
    """
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
        asset = PWA_ASSETS.get(path)
        if asset:
            filename, content_type = asset
            self._send(200, (APP_DIR / filename).read_bytes(), content_type, 'public, max-age=86400')
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
            if should_drop_decoded_frame(code, frame_t, now, newest_t):
                continue
            if not code:
                if should_clear_seen_code(code, thorough):
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
            if not cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, 95]):
                print('Failed to save image', flush=True)
                continue
            thumb = path.with_name(preview_name(filename))
            try:
                thumb.write_bytes(encode_preview(frame))
            except (OSError, ValueError) as exc:
                print('Preview thumbnail failed:', type(exc).__name__, flush=True)
                thumb = None
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
                    'thumb': preview_name(filename) if thumb is not None and thumb.is_file() else filename,
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
