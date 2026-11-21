"""Unit tests for decode_qr and capture-id restore. Avoid importing ONVIF."""
import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

TMP = tempfile.mkdtemp(prefix='garment-decode-')
os.environ['PHOTO_DIR'] = TMP
os.environ['STAGE_FILE'] = str(Path(TMP) / 'stage.json')
os.environ['RECENT_FILE'] = str(Path(TMP) / 'recent.json')

import sys
sys.modules.setdefault('onvif', mock.MagicMock())

import capture_line as cl


class FakeDetector:
    def __init__(self, by_width):
        self.by_width = by_width
        self.calls = []

    def detectAndDecode(self, image):
        height, width = image.shape[:2]
        self.calls.append(width)
        value = self.by_width.get(width, ('', None))
        code, pts = value
        return code, pts, None


def blank(width=2560, height=1440):
    return np.zeros((height, width, 3), dtype=np.uint8)


def pts_for(width, height):
    return np.array([[[width * 0.3, height * 0.3],
                      [width * 0.7, height * 0.3],
                      [width * 0.7, height * 0.7],
                      [width * 0.3, height * 0.7]]], dtype=np.float32)


class DecodeQrTests(unittest.TestCase):
    def test_prefers_1280_and_skips_mid(self):
        det = FakeDetector({1280: ('H2O客衣', pts_for(1280, 720))})
        self.assertEqual(cl.decode_qr(det, blank()), 'H2O客衣')
        self.assertEqual(det.calls, [1280])

    def test_falls_back_to_native_roi_when_1280_empty(self):
        frame = blank()
        roi, _ = cl._table_roi(frame)
        det = FakeDetector({
            1280: ('', None),
            roi.shape[1]: ('日航制服', pts_for(roi.shape[1], roi.shape[0])),
        })
        self.assertEqual(cl.decode_qr(det, frame), '日航制服')
        self.assertEqual(det.calls[0], 1280)
        self.assertIn(roi.shape[1], det.calls)
        self.assertGreater(roi.shape[1], cl.DETECT_FAST_WIDTH)

    def test_falls_back_to_mid_width_when_1280_and_native_empty(self):
        frame = blank()
        roi, _ = cl._table_roi(frame)
        mid, _ = cl._resize_to_width(roi, cl.DETECT_MID_WIDTH)
        det = FakeDetector({
            1280: ('', None),
            roi.shape[1]: ('', None),
            mid.shape[1]: ('日航制服', pts_for(mid.shape[1], mid.shape[0])),
        })
        self.assertEqual(cl.decode_qr(det, frame), '日航制服')
        self.assertEqual(det.calls[0], 1280)
        self.assertIn(roi.shape[1], det.calls)
        self.assertIn(mid.shape[1], det.calls)

    def test_native_crop_when_1280_finds_quad_only(self):
        def side_effect(image):
            h, w = image.shape[:2]
            det.calls.append(w)
            if w == 1280:
                return '', pts_for(1280, 720), None
            return '富野制服', None, None

        det = FakeDetector({})
        det.detectAndDecode = side_effect
        det.calls = []
        self.assertEqual(cl.decode_qr(det, blank()), '富野制服')
        self.assertGreater(len(det.calls), 1)

    def test_empty_on_all_paths(self):
        det = FakeDetector({})
        self.assertEqual(cl.decode_qr(det, blank()), '')
        self.assertGreaterEqual(len(det.calls), 2)

    def test_strips_whitespace_and_none(self):
        det = FakeDetector({1280: ('  日航制服  ', None)})
        self.assertEqual(cl.decode_qr(det, blank()), '日航制服')
        det = FakeDetector({1280: (None, None)})
        # mid also empty
        self.assertEqual(cl.decode_qr(det, blank()), '')

    def test_already_narrow_frame_does_not_upscale(self):
        frame = blank(800, 450)
        det = FakeDetector({800: ('客衣', None)})
        self.assertEqual(cl.decode_qr(det, frame), '客衣')
        self.assertEqual(det.calls, [800])

    def test_default_widths(self):
        self.assertEqual(cl.DETECT_FAST_WIDTH, 1280)
        self.assertEqual(cl.DETECT_MID_WIDTH, 1600)
        self.assertEqual(cl.FRAME_STALE_SECONDS, 0.75)
        self.assertGreater(cl.DETECT_INTERVAL_SECONDS, 0)
        self.assertGreater(cl.FRAME_WATCHDOG_SECONDS, cl.DETECT_INTERVAL_SECONDS)

    def test_fast_path_skips_mid_when_not_thorough(self):
        roi, _ = cl._table_roi(blank())
        mid, _ = cl._resize_to_width(roi, cl.DETECT_MID_WIDTH)
        det = FakeDetector({
            1280: ('', None),
            mid.shape[1]: ('日航制服', pts_for(mid.shape[1], mid.shape[0])),
        })
        self.assertEqual(cl.decode_qr(det, blank(), thorough=False), '')
        self.assertEqual(det.calls, [1280])
        self.assertEqual(cl.decode_qr(det, blank(), thorough=True), '日航制服')


def _qr_image(payload, box_size=20, border=4):
    import qrcode
    from qrcode.constants import ERROR_CORRECT_M
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, border=border, box_size=box_size)
    qr.add_data(payload)
    qr.make(fit=True)
    import cv2
    pil = qr.make_image(fill_color='black', back_color='white').convert('RGB')
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


# 15 cm printed symbols measured ~294 px on a 2560-wide camera frame.
PX_PER_CM = 294 / 15.0


def _paste_qr(frame, qr, side_px, origin, angle=0):
    """Paste a QR symbol at a known pixel size, optionally rotated in-plane."""
    import cv2
    side_px = int(side_px)
    symbol = cv2.resize(qr, (side_px, side_px), interpolation=cv2.INTER_AREA)
    if angle:
        pad = side_px
        canvas = np.full((side_px + 2 * pad, side_px + 2 * pad, 3), 255, dtype=np.uint8)
        canvas[pad:pad + side_px, pad:pad + side_px] = symbol
        ch, cw = canvas.shape[:2]
        matrix = cv2.getRotationMatrix2D((cw / 2, ch / 2), angle, 1.0)
        symbol = cv2.warpAffine(canvas, matrix, (cw, ch), borderValue=(255, 255, 255))
    sh, sw = symbol.shape[:2]
    x0, y0 = origin
    frame[y0:y0 + sh, x0:x0 + sw] = symbol
    return frame


class RealQrSizeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import cv2
        cls.cv2 = cv2
        cls.detector = cv2.QRCodeDetector()
        cls.payloads = ('日航制服', '富野制服', 'H2O客衣', '客衣')

    def _frame_with(self, payload, cm, angle=0):
        bg = blank(2560, 1440)
        bg[:] = (40, 44, 48)
        qr = _qr_image(payload)
        # Place on the table, clear of the OSD margins.
        return _paste_qr(bg, qr, round(cm * PX_PER_CM), (1100, 800), angle=angle)

    def _old_1280(self, frame):
        small, _ = cl._resize_to_width(frame, cl.DETECT_FAST_WIDTH)
        code, _ = cl._decode_one(self.detector, small)
        return code

    def test_5cm_reads_via_native_roi(self):
        for payload in self.payloads:
            with self.subTest(payload=payload):
                frame = self._frame_with(payload, 5, angle=15)
                self.assertEqual(cl.decode_qr(self.detector, frame, thorough=True), payload)

    def test_8cm_reads_with_thorough_native_or_fast_path(self):
        for payload in self.payloads:
            with self.subTest(payload=payload):
                frame = self._frame_with(payload, 8, angle=15)
                self.assertEqual(cl.decode_qr(self.detector, frame, thorough=True), payload)

    def test_5cm_native_path_is_needed_when_1280_is_too_small(self):
        frame = self._frame_with('日航制服', 5, angle=0)
        self.assertEqual(self._old_1280(frame), '')
        self.assertEqual(cl.decode_qr(self.detector, frame, thorough=True), '日航制服')

    def test_saved_photo_stays_full_resolution_after_detect(self):
        frame = self._frame_with('日航制服', 8, angle=15)
        self.assertEqual(cl.decode_qr(self.detector, frame, thorough=True), '日航制服')
        data = cl.encode_photo(frame)
        decoded = self.cv2.imdecode(np.frombuffer(data, dtype=np.uint8), self.cv2.IMREAD_COLOR)
        self.assertEqual(tuple(decoded.shape[:2]), (1440, 2560))


class StaleDetectPolicyTests(unittest.TestCase):
    def test_keeps_successful_decode_after_slow_native_pass(self):
        # NAS timings: 1280 miss + native table ROI is typically 2.5-4.1s.
        frame_t = 100.0
        decode_done = 104.0
        newest = 104.0
        self.assertTrue(cl.detection_is_stale(frame_t, decode_done, newest))
        self.assertFalse(cl.should_drop_decoded_frame('日航制服', frame_t, decode_done, newest))
        self.assertTrue(cl.should_drop_decoded_frame('', frame_t, decode_done, newest))

    def test_still_drops_empty_stale_frame_but_not_a_fresh_empty(self):
        self.assertTrue(cl.should_drop_decoded_frame('', 100.0, 100.9, 100.9))
        self.assertFalse(cl.should_drop_decoded_frame('', 100.0, 100.2, 100.2))
        self.assertFalse(cl.should_drop_decoded_frame('H2O客衣', 100.0, 100.2, 100.2))

    def test_fast_path_miss_does_not_clear_thorough_code(self):
        self.assertFalse(cl.should_clear_seen_code('', thorough=False))
        self.assertTrue(cl.should_clear_seen_code('', thorough=True))
        self.assertFalse(cl.should_clear_seen_code('日航制服', thorough=False))
        self.assertFalse(cl.should_clear_seen_code('日航制服', thorough=True))


class LoadStateTests(unittest.TestCase):
    def test_restores_capture_id(self):
        cl._capture_id = 0
        cl._recent = []
        path = Path(os.environ['RECENT_FILE'])
        path.write_text(json.dumps([
            {'id': 4, 'label': 'H2O客衣', 'photo': 'a.jpg', 'status': 'stored'},
            {'id': 7, 'label': 'H2O客衣', 'photo': 'b.jpg', 'status': 'stored'},
        ]), encoding='utf-8')
        cl.load_state()
        self.assertEqual(cl._capture_id, 7)

class TabletPrefixTests(unittest.TestCase):
    def setUp(self):
        self.prev = cl.TABLET_PATH_PREFIX

    def tearDown(self):
        cl.TABLET_PATH_PREFIX = self.prev

    def test_no_prefix_passthrough(self):
        cl.TABLET_PATH_PREFIX = ''
        self.assertEqual(cl.tablet_request_path('/api/status'), ('/api/status', None))
        self.assertEqual(cl.tablet_request_path('/'), ('/', None))

    def test_strips_configured_prefix(self):
        cl.TABLET_PATH_PREFIX = '/cam-abcdef0123456789'
        self.assertEqual(cl.tablet_request_path('/cam-abcdef0123456789/'), ('/', None))
        self.assertEqual(cl.tablet_request_path('/cam-abcdef0123456789/api/status'), ('/api/status', None))
        self.assertEqual(cl.tablet_request_path('/cam-abcdef0123456789/photos/a.jpg'), ('/photos/a.jpg', None))
        path, redirect = cl.tablet_request_path('/cam-abcdef0123456789')
        self.assertEqual(path, '/')
        self.assertEqual(redirect, '/cam-abcdef0123456789/')

    def test_does_not_strip_other_paths(self):
        cl.TABLET_PATH_PREFIX = '/cam-abcdef0123456789'
        self.assertEqual(cl.tablet_request_path('/api/status'), ('/api/status', None))
        self.assertEqual(cl.tablet_request_path('/camera/api/status'), ('/camera/api/status', None))

class StreamResilienceTests(unittest.TestCase):
    def test_should_reconnect_when_frames_stop(self):
        self.assertFalse(cl.should_reconnect(100.0, 107.9, 90.0, watchdog=8))
        self.assertTrue(cl.should_reconnect(100.0, 108.0, 90.0, watchdog=8))
        self.assertFalse(cl.should_reconnect(0.0, 97.0, 90.0, watchdog=8))
        self.assertTrue(cl.should_reconnect(0.0, 98.0, 90.0, watchdog=8))

    def test_backoff_steps_up_and_caps(self):
        self.assertEqual(cl.next_backoff(0), 2)
        self.assertEqual(cl.next_backoff(2), 4)
        self.assertEqual(cl.next_backoff(15), 30)
        self.assertEqual(cl.next_backoff(30), 30)
        self.assertEqual(cl.next_backoff(99), 30)

    def test_stream_health_and_close_capture_order(self):
        cl.mark_stream_down()
        health = cl.stream_health(now=10, watchdog=8)
        self.assertFalse(health['stream'])
        self.assertIsNone(health['lastFrameSeconds'])
        cl.mark_stream_frame(9.5)
        health = cl.stream_health(now=10, watchdog=8)
        self.assertTrue(health['stream'])
        self.assertEqual(health['lastFrameSeconds'], 0.5)
        cl.mark_stream_frame(1.0)
        health = cl.stream_health(now=10, watchdog=8)
        self.assertFalse(health['stream'])

        released = []
        joined = []

        class FakeCap:
            def release(self):
                released.append(len(joined))

        class FakeThread:
            def __init__(self):
                self.alive = True
            def is_alive(self):
                return self.alive
            def join(self, timeout=None):
                joined.append(timeout)
                self.alive = False

        cap, reader, stop = FakeCap(), FakeThread(), __import__('threading').Event()
        cl.close_capture(cap, reader, stop, timeout=3)
        self.assertTrue(stop.is_set())
        self.assertEqual(released, [1])  # join happened first, then release
        self.assertFalse(reader.is_alive())


class EncodeAndHoldTests(unittest.TestCase):
    def test_fullres_photo_keeps_native_size(self):
        frame = blank(2560, 1440)
        frame[100:200, 100:200] = (40, 80, 200)
        data = cl.encode_photo(frame)
        arr = np.frombuffer(data, dtype=np.uint8)
        import cv2
        decoded = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        self.assertEqual(tuple(decoded.shape[:2]), (1440, 2560))
        self.assertLessEqual(len(data), cl.MAX_JPEG)
        self.assertGreater(len(data), 1000)
        self.assertEqual(data[:2], b'\xff\xd8')

    def test_preview_is_small_and_under_line_limit(self):
        frame = blank(2560, 1440)
        frame[100:400, 100:400] = (20, 180, 80)
        data = cl.encode_preview(frame)
        import cv2
        decoded = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        self.assertIsNotNone(decoded)
        self.assertLessEqual(decoded.shape[1], cl.PREVIEW_MAX_WIDTH)
        self.assertLessEqual(len(data), cl.MAX_PREVIEW_JPEG)
        self.assertEqual(cl.preview_name('20261115_045730_182270.jpg'), '20261115_045730_182270.thumb.jpg')

    def test_hold_client_errors_but_not_rate_limit_or_server_errors(self):
        self.assertTrue(cl.should_hold_upload(409))
        self.assertTrue(cl.should_hold_upload(400))
        self.assertFalse(cl.should_hold_upload(429))
        self.assertFalse(cl.should_hold_upload(500))
        self.assertFalse(cl.should_hold_upload(0))

    def test_missing_jpeg_is_detected(self):
        job = Path(cl.QUEUE) / '20261115_999999_000000.json'
        job.write_text('{"label":"H2O客衣","stage":"洗後"}', encoding='utf-8')
        self.addCleanup(lambda: job.exists() and job.unlink())
        self.assertTrue(cl.source_jpeg_missing(job))
        jpeg = cl.OUT / (job.stem + '.jpg')
        jpeg.write_bytes(b'\xff\xd8\xff\xd9')
        self.addCleanup(lambda: jpeg.unlink(missing_ok=True))
        self.assertFalse(cl.source_jpeg_missing(job))

    def test_cancel_missing_jpeg_moves_json_out_of_queue_and_hold(self):
        job = Path(cl.QUEUE) / '20261115_888888_000000.json'
        job.write_text('{"label":"然一客衣","stage":"洗後"}', encoding='utf-8')
        self.assertTrue(cl.source_jpeg_missing(job))
        dest = cl.cancel_job(job, 'source JPEG missing')
        self.assertFalse(job.exists())
        self.assertTrue(dest.is_file())
        self.assertEqual(dest.parent.parent.resolve(), Path(cl.CANCELLED).resolve())
        self.assertIn('然一客衣', dest.read_text(encoding='utf-8'))

        cl.HOLD.mkdir(parents=True, exist_ok=True)
        held = cl.HOLD / '20261115_777777_000000.json'
        held.write_text('{"label":"H2O客衣","stage":"洗前"}', encoding='utf-8')
        dest2 = cl.cancel_job(held, 'source JPEG missing')
        self.assertFalse(held.exists())
        self.assertTrue(dest2.is_file())
        self.assertEqual(dest2.parent.parent.resolve(), Path(cl.CANCELLED).resolve())
        self.assertIn('H2O客衣', dest2.read_text(encoding='utf-8'))



class NonBlockingUploadTests(unittest.TestCase):

    def test_failed_hotel_does_not_block_other_uploads(self):
        src = Path(cl.__file__).read_text(encoding='utf-8')
        start = src.find('def delivery_worker')
        end = src.find('\ndef ', start + 4)
        worker = src[start:end]
        self.assertIn('retry_at', worker)
        self.assertIn('retry_at[job]', worker)
        self.assertNotIn('stop.wait(30)', worker)
        self.assertNotIn('stop.wait(21600', worker)
        # A failure records a per-job retry time and continues the loop.
        self.assertIn('continue', worker)
        self.assertNotRegex(worker, r'stop\.wait\(.*\)\n\s+break')



if __name__ == '__main__':
    unittest.main()
