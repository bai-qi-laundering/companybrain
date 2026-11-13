#!/usr/bin/env python3
"""Parse HR Excel uploads and print JSON for the Node API. Stdin = file bytes."""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def main():
    if len(sys.argv) < 2:
        print('usage: cli.py recruitment-preview START END FILENAME | leave-preview FILENAME', file=sys.stderr)
        sys.exit(2)
    raw = sys.stdin.buffer.read()
    cmd = sys.argv[1]
    if cmd == 'recruitment-preview':
        from recruitment_excel import read_excel
        data = read_excel(raw, sys.argv[4], sys.argv[2], sys.argv[3])
    elif cmd == 'leave-preview':
        from leave_excel import read_excel
        data = read_excel(raw, sys.argv[2])
    else:
        raise SystemExit('unknown command')
    json.dump(data, sys.stdout, ensure_ascii=False, default=str)

if __name__ == '__main__':
    main()
