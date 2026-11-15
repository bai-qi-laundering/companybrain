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

    def test_falls_back_to_mid_width_when_1280_empty(self):
        roi, _ = cl._table_roi(blank())
        mid, _ = cl._resize_to_width(roi, cl.DETECT_MID_WIDTH)
        det = FakeDetector({
            1280: ('', None),
            mid.shape[1]: ('日航制服', pts_for(mid.shape[1], mid.shape[0])),
        })
        self.assertEqual(cl.decode_qr(det, blank()), '日航制服')
        self.assertEqual(det.calls[0], 1280)
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
