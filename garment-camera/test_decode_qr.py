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

if __name__ == '__main__':
    unittest.main()
