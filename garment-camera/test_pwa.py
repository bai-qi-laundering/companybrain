"""PWA install metadata: manifest, icons, head links, subpath and trailing slash.

Runs without the camera. opencv/numpy/onvif are stubbed when they are absent.
"""
import http.client
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
from unittest import mock
from urllib.parse import urljoin

TMP = tempfile.mkdtemp(prefix='garment-pwa-')
os.environ.setdefault('PHOTO_DIR', TMP)
os.environ.setdefault('STAGE_FILE', str(Path(TMP) / 'stage.json'))
os.environ.setdefault('RECENT_FILE', str(Path(TMP) / 'recent.json'))

if 'capture_line' not in sys.modules:
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except ImportError:
        cv2_mod = mock.MagicMock()
        cv2_mod.error = type('cv2_error', (Exception,), {})
        sys.modules['cv2'] = cv2_mod
        sys.modules.setdefault('numpy', mock.MagicMock())
    sys.modules.setdefault('onvif', mock.MagicMock())

import capture_line as cl

PREFIX = '/cam-abcdef0123456789'
THEME = (0x0F, 0x8A, 0x42)


def extract_function(html, name):
    start = html.find('function ' + name)
    if start < 0:
        raise AssertionError('missing function ' + name)
    brace = html.find('{', start)
    depth = 0
    for i in range(brace, len(html)):
        if html[i] == '{':
            depth += 1
        elif html[i] == '}':
            depth -= 1
            if depth == 0:
                return html[start:i + 1]
    raise AssertionError('unclosed function ' + name)


def decode_png(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise AssertionError('missing PNG signature')
    pos = 8
    width = height = None
    idat = bytearray()
    saw_iend = False
    while pos + 12 <= len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        crc = struct.unpack('>I', data[pos + 8 + length:pos + 12 + length])[0]
        if (zlib.crc32(typ + chunk) & 0xFFFFFFFF) != crc:
            raise AssertionError('bad CRC for ' + typ.decode('ascii', 'replace'))
        if typ == b'IHDR':
            width, height, bit, color, comp, filt, inter = struct.unpack('>IIBBBBB', chunk)
            if (bit, color, comp, filt, inter) != (8, 2, 0, 0, 0):
                raise AssertionError('expected 8-bit RGB PNG')
        elif typ == b'IDAT':
            idat.extend(chunk)
        elif typ == b'IEND':
            saw_iend = True
            break
        pos += 12 + length
    if not saw_iend or width is None:
        raise AssertionError('truncated PNG')
    raw = zlib.decompress(bytes(idat))
    stride = width * 3
    rows = []
    i = 0
    for _y in range(height):
        if raw[i] != 0:
            raise AssertionError('unexpected PNG filter')
        i += 1
        rows.append(raw[i:i + stride])
        i += stride
    if i != len(raw):
        raise AssertionError('PNG row length mismatch')
    return width, height, b''.join(rows)


def pixel(rgb, width, x, y):
    i = (y * width + x) * 3
    return rgb[i], rgb[i + 1], rgb[i + 2]


def count_kinds(rgb):
    white = green = 0
    for i in range(0, len(rgb), 3):
        r, g, b = rgb[i], rgb[i + 1], rgb[i + 2]
        if r > 220 and g > 220 and b > 220:
            white += 1
        elif abs(r - THEME[0]) < 30 and abs(g - THEME[1]) < 40 and abs(b - THEME[2]) < 30 and g > r and g > b:
            green += 1
    return white, green


class ManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((cl.APP_DIR / 'manifest.webmanifest').read_text(encoding='utf-8'))
        cls.html = (cl.APP_DIR / 'tablet.html').read_text(encoding='utf-8')

    def test_install_fields_are_relative(self):
        manifest = self.manifest
        self.assertEqual(manifest['name'], '客衣拍照確認')
        self.assertEqual(manifest['short_name'], '客衣拍照')
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['theme_color'], '#0f8a42')
        self.assertEqual(manifest['lang'], 'zh-Hant')
        for key in ('id', 'start_url', 'scope'):
            self.assertEqual(manifest[key], './', key)
        self.assertNotEqual(manifest['start_url'], '/')
        self.assertNotIn('prefer_related_applications', manifest)

    def test_relative_urls_resolve_for_lan_root_and_funnel_subpath(self):
        manifest = self.manifest
        pages = {
            'http://192.168.123.201:8790/manifest.webmanifest': 'http://192.168.123.201:8790/',
            'https://camera.example:8443' + PREFIX + '/manifest.webmanifest': 'https://camera.example:8443' + PREFIX + '/',
        }
        for manifest_url, directory in pages.items():
            for key in ('id', 'start_url', 'scope'):
                self.assertEqual(urljoin(manifest_url, manifest[key]), directory, key)
            for icon in manifest['icons']:
                resolved = urljoin(manifest_url, icon['src'])
                self.assertTrue(resolved.startswith(directory), resolved)
                self.assertFalse(resolved.replace(directory, '', 1).startswith('/'))

    def test_icons_declare_png_sizes_and_purpose(self):
        by_purpose = {}
        for icon in self.manifest['icons']:
            self.assertEqual(icon['type'], 'image/png')
            self.assertNotIn('..', icon['src'])
            self.assertFalse(icon['src'].startswith('/'))
            self.assertFalse(icon['src'].startswith('http'))
            by_purpose.setdefault(icon['purpose'], set()).add(icon['sizes'])
        self.assertIn('192x192', by_purpose['any'])
        self.assertIn('512x512', by_purpose['any'])
        self.assertIn('512x512', by_purpose['maskable'])

    def test_head_links_are_relative_and_line_hint_is_opt_in(self):
        html = self.html
        links = re.findall(r'<link\b[^>]*>', html)
        found = set()
        for tag in links:
            rel = re.search(r'rel="([^"]+)"', tag)
            href = re.search(r'href="([^"]+)"', tag)
            self.assertIsNotNone(rel)
            self.assertIsNotNone(href)
            rel_name = rel.group(1)
            href_val = href.group(1)
            if rel_name in ('manifest', 'icon', 'apple-touch-icon'):
                found.add((rel_name, href_val))
                self.assertFalse(href_val.startswith('/'), href_val)
                self.assertFalse(href_val.startswith('http'), href_val)
        self.assertIn(('manifest', 'manifest.webmanifest'), found)
        self.assertIn(('apple-touch-icon', 'apple-touch-icon.png'), found)
        self.assertIn(('icon', 'favicon-32.png'), found)
        self.assertIn(('icon', 'icon-192.png'), found)
        self.assertIn('name="theme-color" content="#0f8a42"', html)
        self.assertIn('name="mobile-web-app-capable" content="yes"', html)
        self.assertIn('name="apple-mobile-web-app-capable" content="yes"', html)
        self.assertIn('id="line-hint"', html)
        self.assertIn('LINE 內建瀏覽器無法加入主畫面', html)
        self.assertIn("indexOf('Line/')", html)
        self.assertNotIn('id="line-hint" class="show"', html)
        self.assertIn('function tabletDirname', html)
        self.assertIn('function tabletNeedsSlash', html)
        self.assertIn("document.write('<base href=\"'", html)
        self.assertIn('location.replace', html)

    def test_dirname_and_slash_rules_via_node(self):
        js = extract_function(self.html, 'tabletDirname') + '\n' + extract_function(self.html, 'tabletNeedsSlash')
        cases = [
            ['/', '/', False],
            [PREFIX, PREFIX + '/', True],
            [PREFIX + '/', PREFIX + '/', False],
            ['/cam.token', '/cam.token/', True],
            ['/cam.token/', '/cam.token/', False],
            ['/cam.token/index.html', '/cam.token/', False],
            ['/index.html', '/', False],
            ['/manifest.webmanifest', '/', False],
            ['/icon-192.png', '/', False],
            [PREFIX + '/icon-192.png', PREFIX + '/', False],
            [PREFIX + '/photos/a.jpg', PREFIX + '/photos/', False],
            ['', '/', False],
        ]
        script = js + '''
const cases = %s;
for (const [input, dir, needs] of cases) {
  const gotDir = tabletDirname(input);
  const gotNeeds = tabletNeedsSlash(input);
  if (gotDir !== dir || gotNeeds !== needs) {
    console.error(JSON.stringify({input, gotDir, dir, gotNeeds, needs}));
    process.exit(1);
  }
}
''' % json.dumps(cases)
        subprocess.run(['node', '-e', script], check=True)

    def test_unsuffixed_document_url_would_escape_the_mount(self):
        # Documents why tabletNeedsSlash redirects before relative links load.
        escaped = urljoin('https://camera.example:8443' + PREFIX, 'manifest.webmanifest')
        self.assertEqual(escaped, 'https://camera.example:8443/manifest.webmanifest')
        kept = urljoin('https://camera.example:8443' + PREFIX + '/', 'manifest.webmanifest')
        self.assertEqual(kept, 'https://camera.example:8443' + PREFIX + '/manifest.webmanifest')


class IconFileTests(unittest.TestCase):
    def test_png_assets_have_declared_dimensions_and_a_glyph(self):
        expected = {
            'icon-192.png': (192, 192),
            'icon-512.png': (512, 512),
            'icon-maskable-512.png': (512, 512),
            'apple-touch-icon.png': (180, 180),
            'favicon-32.png': (32, 32),
        }
        for name, (width, height) in expected.items():
            blob = (cl.APP_DIR / name).read_bytes()
            got_w, got_h, rgb = decode_png(blob)
            self.assertEqual((got_w, got_h), (width, height), name)
            white, green = count_kinds(rgb)
            self.assertGreater(white, (width * height) // 80, name)
            self.assertGreater(green, (width * height) // 3, name)
            corner = pixel(rgb, width, 0, 0)
            self.assertLess(abs(corner[1] - THEME[1]), 8, name)
        mask_w, _mask_h, mask = decode_png((cl.APP_DIR / 'icon-maskable-512.png').read_bytes())
        cx = cy = (mask_w - 1) / 2.0
        limit = mask_w * 0.40
        for y in range(mask_w):
            for x in range(mask_w):
                r, g, b = pixel(mask, mask_w, x, y)
                if r > 200 and g > 200 and b > 200:
                    self.assertLessEqual(math.hypot(x - cx, y - cy), limit + 1.5, (x, y))

    def test_favicon_ico_embeds_pngs(self):
        data = (cl.APP_DIR / 'favicon.ico').read_bytes()
        reserved, kind, count = struct.unpack_from('<HHH', data, 0)
        self.assertEqual((reserved, kind), (0, 1))
        self.assertGreaterEqual(count, 1)
        sizes = set()
        for i in range(count):
            width, height, _pal, _res, _planes, _bpp, nbytes, offset = struct.unpack_from('<BBBBHHII', data, 6 + 16 * i)
            blob = data[offset:offset + nbytes]
            self.assertTrue(blob.startswith(b'\x89PNG\r\n\x1a\n'))
            got_w, got_h, _rgb = decode_png(blob)
            self.assertEqual(got_w, width or 256)
            self.assertEqual(got_h, height or 256)
            sizes.add(got_w)
        self.assertIn(32, sizes)


class TabletPwaHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prev = cl.TABLET_PATH_PREFIX
        cl.TABLET_PATH_PREFIX = ''
        cls.server = cl.ThreadingHTTPServer(('127.0.0.1', 0), cl.TabletHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cl.TABLET_PATH_PREFIX = cls.prev

    def setUp(self):
        cl.TABLET_PATH_PREFIX = ''

    def request(self, path):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request('GET', path)
            res = conn.getresponse()
            body = res.read()
            headers = {k.lower(): v for k, v in res.getheaders()}
            return res.status, headers, body
        finally:
            conn.close()

    def test_root_manifest_and_icons(self):
        status, headers, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['content-type'])
        html = body.decode('utf-8')
        self.assertIn('href="manifest.webmanifest"', html)
        self.assertIn('href="apple-touch-icon.png"', html)
        self.assertNotIn('href="/manifest.webmanifest"', html)

        status, headers, body = self.request('/manifest.webmanifest')
        self.assertEqual(status, 200)
        self.assertTrue(headers['content-type'].startswith('application/manifest+json'), headers['content-type'])
        manifest = json.loads(body.decode('utf-8'))
        self.assertEqual(manifest['start_url'], './')
        self.assertEqual(manifest['scope'], './')
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['id'], './')

        for path, size in (('/icon-192.png', 192), ('/icon-512.png', 512), ('/apple-touch-icon.png', 180), ('/favicon-32.png', 32)):
            status, headers, blob = self.request(path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers['content-type'], 'image/png', path)
            width, height, _rgb = decode_png(blob)
            self.assertEqual((width, height), (size, size), path)

        status, headers, blob = self.request('/favicon.ico')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'image/x-icon')
        self.assertTrue(blob.startswith(b'\x00\x00\x01\x00'))

    def test_prefix_trailing_slash_and_root_still_works(self):
        cl.TABLET_PATH_PREFIX = PREFIX
        status, headers, _body = self.request(PREFIX)
        self.assertEqual(status, 301)
        self.assertEqual(headers['location'], PREFIX + '/')

        status, headers, body = self.request(PREFIX + '/')
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['content-type'])
        self.assertIn('href="manifest.webmanifest"', body.decode('utf-8'))

        status, headers, body = self.request(PREFIX + '/manifest.webmanifest')
        self.assertEqual(status, 200)
        self.assertTrue(headers['content-type'].startswith('application/manifest+json'))
        manifest = json.loads(body.decode('utf-8'))
        self.assertEqual(manifest['start_url'], './')
        self.assertEqual(manifest['scope'], './')
        for icon in manifest['icons']:
            self.assertIn(icon['purpose'], ('any', 'maskable'))

        status, headers, blob = self.request(PREFIX + '/icon-512.png')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'image/png')
        width, height, _rgb = decode_png(blob)
        self.assertEqual((width, height), (512, 512))

        status, headers, blob = self.request(PREFIX + '/apple-touch-icon.png')
        self.assertEqual(status, 200)
        width, height, _rgb = decode_png(blob)
        self.assertEqual((width, height), (180, 180))

        status, _headers, body = self.request(PREFIX + '/api/status')
        self.assertEqual(status, 200)
        payload = json.loads(body.decode('utf-8'))
        self.assertIn(payload['stage'], ('洗前', '洗後'))

        status, headers, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['content-type'])
        self.assertIn(b'manifest.webmanifest', body)

        status, _headers, _body = self.request('/manifest.webmanifest')
        self.assertEqual(status, 200)

    def test_unknown_path_is_not_redirected_and_empty_path_is_root(self):
        cl.TABLET_PATH_PREFIX = ''
        status, _headers, body = self.request(PREFIX)
        self.assertEqual(status, 404)
        self.assertIn(b'not found', body)
        self.assertEqual(cl.tablet_request_path(''), ('/', None))
        self.assertEqual(cl.tablet_request_path('/'), ('/', None))
        cl.TABLET_PATH_PREFIX = PREFIX
        self.assertEqual(cl.tablet_request_path(''), ('/', None))
        self.assertEqual(cl.tablet_request_path('/'), ('/', None))
        path, redirect = cl.tablet_request_path(PREFIX)
        self.assertEqual(path, '/')
        self.assertEqual(redirect, PREFIX + '/')


if __name__ == '__main__':
    unittest.main()
