#!/usr/bin/env python3
"""Read the owner's 「月份_自動損益表.xlsx」 (read-only) and print monthly totals as JSON.

Usage: pnl_import.py <path>
Only cached values are read (openpyxl read_only + data_only); the workbook is never written.
Output: {"sheets": [...], "summarySheet": "年度損益表", "months": {"1": {"categories": {...}, "revenue": n}},
         "details": {"1": {"rows": n, "categories": {...}}}, "warnings": [...]}
"""
import json
import sys

SUMMARY = '年度損益表'


def num(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(',', '')
    try:
        return float(s)
    except ValueError:
        return None


def month_of(label):
    s = str(label or '').strip()
    if s.endswith('月') and s[:-1].isdigit() and 1 <= int(s[:-1]) <= 12:
        return int(s[:-1])
    return None


def main(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = {'sheets': wb.sheetnames, 'summarySheet': None, 'months': {}, 'details': {}, 'warnings': []}
    if SUMMARY not in wb.sheetnames:
        out['warnings'].append('找不到「年度損益表」工作表')
        print(json.dumps(out, ensure_ascii=False))
        return
    out['summarySheet'] = SUMMARY
    rows = list(wb[SUMMARY].iter_rows(values_only=True))
    header = rows[0] if rows else ()
    cols = {}
    for i, h in enumerate(header):
        m = month_of(h)
        if m and m not in cols:
            cols[m] = i
    for m, ci in cols.items():
        cats, revenue = {}, None
        for r in rows[1:]:
            label = str(r[0]).strip() if r and r[0] is not None else ''
            if not label or ci >= len(r):
                continue
            v = num(r[ci])
            if label == '收入':
                revenue = v
            elif label not in ('總支出', '淨利'):
                cats[label] = v
        out['months'][str(m)] = {'categories': cats, 'revenue': revenue}
    # 各月工作表的明細合計，只用來交叉檢查（B 欄科目、G 欄合計）
    for name in wb.sheetnames:
        m = month_of(name)
        if not m:
            continue
        sums, n = {}, 0
        for r in wb[name].iter_rows(min_row=2, max_col=7, values_only=True):
            if len(r) < 7:
                continue
            label = str(r[1]).strip() if r[1] is not None else ''
            v = num(r[6])
            if not label or not v:
                continue
            sums[label] = sums.get(label, 0) + v
            n += 1
        out['details'][str(m)] = {'rows': n, 'categories': sums}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('usage: pnl_import.py <path>')
    main(sys.argv[1])
