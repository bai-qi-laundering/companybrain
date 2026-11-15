"""Unit tests for decode_qr: native frame first, then width-1280 fallback."""
import os
import sys
import tempfile
import types
import unittest
import cv2
import numpy as np

# capture_line creates PHOTO_DIR and imports onvif at module load.
os.environ.setdefault('PHOTO_DIR', tempfile.mkdtemp(prefix='garment-camera-test-'))
if 'onvif' not in sys.modules:
    sys.modules['onvif'] = types.SimpleNamespace(ONVIFCamera=object)

from capture_line import DETECT_FALLBACK_WIDTH, decode_qr  # noqa: E402


class FakeDetector:
    def __init__(self, responses):
        self.responses = dict(responses)
        self.calls = []

    def detectAndDecode(self, img):
        width = int(img.shape[1])
        self.calls.append(width)
        code = self.responses.get(width, '')
        return code, None, None


def frame(width, height=None):
    if height is None:
        height = int(round(width * 9 / 16))
    return np.zeros((height, width, 3), dtype=np.uint8)


class DecodeQrTests(unittest.TestCase):
    def test_prefers_native_2560_and_skips_fallback(self):
        detector = FakeDetector({2560: '富野制服', 1280: 'WRONG'})
        self.assertEqual(decode_qr(detector, frame(2560, 1440)), '富野制服')
        self.assertEqual(detector.calls, [2560])

    def test_falls_back_to_1280_when_native_empty(self):
        detector = FakeDetector({2560: '', 1280: '日航制服'})
        self.assertEqual(decode_qr(detector, frame(2560, 1440)), '日航制服')
        self.assertEqual(detector.calls, [2560, 1280])

    def test_empty_on_both_scales(self):
        detector = FakeDetector({})
        self.assertEqual(decode_qr(detector, frame(2560, 1440)), '')
        self.assertEqual(detector.calls, [2560, 1280])

    def test_strips_whitespace_and_treats_none_as_empty(self):
        detector = FakeDetector({2560: '  富野制服  '})
        self.assertEqual(decode_qr(detector, frame(2560, 1440)), '富野制服')

        detector = FakeDetector({2560: None, 1280: None})
        detector.detectAndDecode = lambda img: (None, None, None)
        # widths still recorded by wrapping
        calls = []
        orig = detector.detectAndDecode

        def wrapped(img):
            calls.append(int(img.shape[1]))
            return orig(img)

        detector.detectAndDecode = wrapped
        self.assertEqual(decode_qr(detector, frame(2560, 1440)), '')
        self.assertEqual(calls, [2560, 1280])

    def test_already_narrow_frame_does_not_downscale(self):
        detector = FakeDetector({1280: 'H2O客衣', 640: 'WRONG'})
        self.assertEqual(decode_qr(detector, frame(1280, 720)), 'H2O客衣')
        self.assertEqual(detector.calls, [1280])

        detector = FakeDetector({960: ''})
        self.assertEqual(decode_qr(detector, frame(960, 540)), '')
        self.assertEqual(detector.calls, [960])

    def test_fallback_width_constant(self):
        self.assertEqual(DETECT_FALLBACK_WIDTH, 1280)


if __name__ == '__main__':
    unittest.main()
