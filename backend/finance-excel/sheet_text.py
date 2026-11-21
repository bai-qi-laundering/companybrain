#!/usr/bin/env python3
"""Print a spreadsheet as plain tab-separated text for document classification.

Usage: sheet_text.py <path> [max_chars]
Reads .xlsx/.xlsm with openpyxl (cached values only, never formulas) and .xls with xlrd.
Only the first rows of each sheet are emitted so huge workbooks stay cheap to classify.
"""
import sys

MAX_ROWS = 150
MAX_COLS = 20


def cell(v):
    if v is None:
        return ''
    if hasattr(v, 'strftime'):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).replace('\t', ' ').replace('\n', ' ').strip()


def emit(name, rows, out):
    out.append('### 工作表：' + str(name))
    for row in rows:
        vals = [cell(v) for v in list(row)[:MAX_COLS]]
        if any(vals):
            out.append('\t'.join(vals).rstrip())


def main():
    path = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
    out = []
    low = path.lower()
    if low.endswith('.xls'):
        import xlrd
        book = xlrd.open_workbook(path, on_demand=True)
        for sh in book.sheets()[:8]:
            rows = (sh.row_values(i) for i in range(min(sh.nrows, MAX_ROWS)))
            emit(sh.name, rows, out)
    else:
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets[:8]:
            emit(ws.title, ws.iter_rows(max_row=MAX_ROWS, values_only=True), out)
    text = '\n'.join(out)
    sys.stdout.write(text[:limit])


if __name__ == '__main__':
    main()
