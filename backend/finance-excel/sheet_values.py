#!/usr/bin/env python3
"""Print every sheet of a workbook as JSON rows (cached values only, never formulas).

Usage: sheet_values.py <path>
Used by the 收件匣 to detect and import 薪資計算明細 exports locally (salary files are not sent to Gemini).
"""
import json
import sys

MAX_ROWS = 5000
MAX_COLS = 80
MAX_SHEETS = 12


def cell(v):
    if v is None:
        return ''
    if hasattr(v, 'strftime'):
        return v.strftime('%Y/%m/%d')
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def trim(vals):
    while vals and vals[-1] == '':
        vals.pop()
    return vals


def main(path):
    out = []
    if path.lower().endswith('.xls'):
        import xlrd
        book = xlrd.open_workbook(path)
        for sh in book.sheets()[:MAX_SHEETS]:
            rows = []
            for r in range(min(sh.nrows, MAX_ROWS)):
                vals = []
                for c in range(min(sh.ncols, MAX_COLS)):
                    v = sh.cell_value(r, c)
                    if sh.cell_type(r, c) == xlrd.XL_CELL_DATE:
                        try:
                            v = xlrd.xldate.xldate_as_datetime(v, book.datemode)
                        except Exception:
                            pass
                    vals.append(cell(v))
                rows.append(trim(vals))
            out.append({'name': sh.name, 'rows': rows})
    else:
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets[:MAX_SHEETS]:
            rows = []
            for i, row in enumerate(ws.iter_rows(max_col=MAX_COLS, values_only=True)):
                if i >= MAX_ROWS:
                    break
                rows.append(trim([cell(v) for v in row]))
            out.append({'name': ws.title, 'rows': rows})
    print(json.dumps({'sheets': out}, ensure_ascii=False))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('usage: sheet_values.py <path>')
    main(sys.argv[1])
