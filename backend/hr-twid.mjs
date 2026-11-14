/** Taiwan National ID checksum (legacy A123456789 and 2021 letter-second format). */
const LETTERS = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};

export function normalizeTaiwanId(value) {
  return String(value || '').trim().toUpperCase();
}

export function isValidTaiwanId(value) {
  const s = normalizeTaiwanId(value);
  if (/^[A-Z][12]\d{8}$/.test(s)) return checksum(letterDigits(s[0]).concat(s.slice(1).split('').map(Number)));
  if (/^[A-Z][A-Z]\d{8}$/.test(s)) {
    const first = letterDigits(s[0]);
    const second = letterDigits(s[1]);
    // Second letter contributes only its units digit in the official 2021 scheme.
    return checksum(first.concat(second[1], s.slice(2).split('').map(Number)));
  }
  return false;
}

function letterDigits(ch) {
  const n = LETTERS[ch];
  if (n == null) return [0, 0];
  return [Math.floor(n / 10), n % 10];
}

function checksum(digits) {
  if (digits.length !== 11) return false;
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = digits.reduce((n, d, i) => n + d * weights[i], 0);
  return sum % 10 === 0;
}

export function maskTaiwanId(value) {
  const s = normalizeTaiwanId(value);
  if (s.length < 4) return s ? '****' : '';
  return s[0] + '****' + s.slice(-4);
}
