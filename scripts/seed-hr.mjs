import {writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {today} from '../backend/hr-store.mjs';

export const LOCAL_ADMIN = {username: 'admin1', password: 'local-hr-merge-ok'};

export async function seedOrganizations(store) {
  const state = await store.read();
  const extras = [
    {id: 'org-hotel-demo', name: '示意飯店（中山）', kind: '飯店', contact: '房務主管', role: '窗口', manager: '', contract: '', memo: '示意資料', prices: [], priceNotes: ''},
    {id: 'org-equip-demo', name: '示意設備商', kind: '設備商', contact: '業務', role: '窗口', manager: '', contract: '', memo: '示意資料', prices: [], priceNotes: ''},
    {id: 'org-build-demo', name: '示意工程行', kind: '工程／建築', contact: '工地主任', role: '窗口', manager: '', contract: '', memo: '示意資料', prices: [], priceNotes: ''},
  ];
  const have = new Set(state.organizations.map((o) => o.id));
  state.organizations = [...state.organizations, ...extras.filter((o) => !have.has(o.id))];
  await store.save(state.revision, state, 'seed');
}

export async function seedHr(hr) {
  const employees = [
    {id: 'EMP-001', name: '黃淑芬', department: '行政', job: '人資行政', employmentType: '正職', arrivalDate: '2019-03-01', phone: '0912-000-001', emergencyContact: '黃先生 0912-111-001', paperLocation: '行政櫃 3 層'},
    {id: 'EMP-003', name: '王建宏', department: '廠務', job: '廠務主管', employmentType: '正職', arrivalDate: '2018-07-16', phone: '0912-000-003', emergencyContact: '王太太 0912-111-003', paperLocation: '廠務室'},
    {id: 'EMP-008', name: '林雅婷', department: '客服對帳', job: '客服對帳', employmentType: '正職', arrivalDate: '2024-02-01', phone: '0912-000-008'},
    {id: 'EMP-014', name: '陳志明', department: '物流', job: '物流司機', employmentType: '正職', arrivalDate: '2022-05-20', phone: '0912-000-014', emergencyContact: '陳太太 0912-111-014', paperLocation: '司機室'},
    {id: 'EMP-015', name: '張偉誠', department: '物流', job: '物流司機', employmentType: '正職', arrivalDate: '2023-09-11', arrivalDateSource: {type: '加保日', date: '2023-09-11'}, phone: '0912-000-015', emergencyContact: '張先生 0912-111-015', paperLocation: '司機室'},
    {id: 'EMP-020', name: '周麗華', department: '行政', job: '出納', employmentType: '正職', arrivalDate: '2020-12-20', phone: '0912-000-020', emergencyContact: '周先生 0912-111-020', paperLocation: '行政櫃'},
  ];
  for (const e of employees) {
    try { await hr.upsertEmployee(e.id, e, 'seed', {create: true}); }
    catch (err) { if (!String(err.message).includes('已存在')) throw err; }
  }
  await hr.ensureAllYears();
  const years = (await hr.state()).leaveYears;
  const current = years.find((y) => y.employeeId === 'EMP-001' && y.startsOn === '2026-03-01');
  if (current) {
    const have = (await hr.state()).leaveEntries.some((e) => e.id === 'LV-seed-1');
    if (!have) {
      await hr.addLeaveEntry({id: 'LV-seed-1', employeeId: 'EMP-001', leaveYearId: current.id, takenOn: '2026-06-02', days: 2, notes: '示意請假'}, 'seed');
      await hr.addLeaveEntry({id: 'LV-seed-2', employeeId: 'EMP-001', leaveYearId: current.id, takenOn: '2026-08-18', days: 3.5, notes: '含半天'}, 'seed');
      await hr.addLeaveEntry({id: 'LV-seed-3', employeeId: 'EMP-001', leaveYearId: current.id, takenOn: '2026-10-05', days: 0.5, notes: '半天'}, 'seed');
    }
  }
  const prev = years.find((y) => y.employeeId === 'EMP-001' && y.startsOn === '2025-03-01');
  if (prev && prev.status === '未結算') {
    await hr.addLeaveEntry({id: 'LV-seed-4', employeeId: 'EMP-001', leaveYearId: prev.id, takenOn: '2025-07-10', days: 5, notes: '去年已休'}, 'seed');
    await hr.settleYear(prev.id, {status: '未休完已折現', settledOn: '2026-03-02', settledBy: '黃淑芬', notes: '年度結束未休完，依慣例折現（不記金額）'}, 'seed');
  }
  await hr.addRecord('insurance', {employeeId: 'EMP-001', labor: '加保', health: '加保', date: '2019-03-01', note: ''}, 'seed');
  const candidates = [
    {id: 'R-01', name: '吳佳穎', phone: '0988-100-001', department: '物流', job: '物流司機', source: '1111', status: '待面試', followupDate: today(), interviewAt: today() + 'T14:00', contactPerson: '黃淑芬'},
    {id: 'R-02', name: '周柏翰', phone: '0988-100-002', department: '廠務', job: '廠務助理', source: '介紹', status: '待聯絡', followupDate: today(), contactPerson: '王建宏'},
    {id: 'R-03', name: '許雅琪', phone: '0988-100-003', department: '行政', job: '人資行政', source: '104', status: '待報到', followupDate: today(), availableDate: today(), contactPerson: '黃淑芬'},
    {id: 'R-04', name: '鄭文傑', phone: '0988-100-004', department: '物流', job: '物流司機', source: '1111', status: '待回覆', followupDate: '2026-11-10', contactPerson: '黃淑芬'},
    {id: 'R-05', name: '蔡佩珊', phone: '0988-100-005', department: '客服對帳', job: '客服', source: '104', status: '錄取', followupDate: today(), contactPerson: '林雅婷'},
    {id: 'R-06', name: '林書廷', phone: '0988-100-006', department: '廠務', job: '廠務', source: '介紹', status: '未錄取'},
  ];
  for (const c of candidates) {
    try { await hr.upsertCandidate(c.id, c, 'seed', {create: true}); }
    catch (err) { if (!String(err.message).includes('已存在')) throw err; }
  }
  await hr.upsertGoal('物流', {additional: 4, notes: '示意需求（基準為建立時在職人數）'}, 'seed');
  await hr.upsertGoal('廠務', {additional: 2, notes: ''}, 'seed');
  await hr.upsertGoal('行政', {additional: 1, notes: ''}, 'seed');
  const haveOcr = (await hr.state()).ocrReviews?.some((r) => r.id === 'seed' || r.employeeId === 'EMP-014' && r.status === 'pending');
  if (!haveOcr) {
    await hr.insertOcrReview({
      employeeId: 'EMP-014',
      category: 'bank',
      extracted: {bankCode: '004', branch: '台灣銀行南京東路分行', account: '12345678901234', accountName: '陳志明', warnings: []},
      status: 'pending',
    }, 'seed');
  }
  const haveSal = (await hr.state()).salaries?.some((s) => s.employeeId === 'EMP-014');
  if (!haveSal) {
    await hr.upsertSalary({employeeId: 'EMP-014', month: '2026-09', netPay: 42000, notes: '示意', remittance: '已匯'}, 'seed');
    await hr.upsertSalary({employeeId: 'EMP-014', month: '2026-10', netPay: 41500, notes: '', remittance: '未匯'}, 'seed');
    await hr.upsertSalary({employeeId: 'EMP-001', month: '2026-10', netPay: 38000, notes: '', remittance: '已匯'}, 'seed');
  }
  await seedDocFiles(hr);
}


function writeLabeledJpeg(dest, title, bg) {
  const q = (v) => JSON.stringify(String(v));
  const py = [
    'from PIL import Image, ImageDraw, ImageFont',
    'im = Image.new("RGB", (480, 320), ' + q(bg) + ')',
    'd = ImageDraw.Draw(im)',
    'd.rectangle((16,16,463,303), outline="#182c39", width=6)',
    'try:',
    '    font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 36)',
    '    small = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 18)',
    'except Exception:',
    '    font = ImageFont.load_default()',
    '    small = font',
    'd.text((240, 130), ' + q(title) + ', fill="#182c39", font=font, anchor="mm")',
    'd.text((240, 180), "示意證件（本機種子）", fill="#4a5a63", font=small, anchor="mm")',
    'im.save(' + q(dest) + ', quality=85)',
  ].join('\n');
  const r = spawnSync('python3', ['-c', py], {encoding: 'utf8'});
  if (r.status !== 0) throw new Error('無法產生示意圖片：' + (r.stderr || r.stdout));
}

async function seedDocFiles(hr) {
  const identity = process.env.NAS_IDENTITY_PATH;
  const bank = process.env.NAS_BANK_PATH;
  const license = process.env.NAS_LICENSE_PATH;
  if (!identity || !bank || !license) return;
  const files = [
    {category: 'identity', dir: identity, filename: 'EMP-014_陳志明_身分證_20260501T100000_aabbccddeeff.jpg', title: '身分證示意', bg: '#f3efe4'},
    {category: 'bank', dir: bank, filename: 'EMP-014_陳志明_存摺_20260501T100100_ffeeddccbbaa.jpg', title: '存摺示意', bg: '#e7f0e8'},
  ];
  const state = await hr.state();
  const have = new Set((state.documents || []).map((d) => d.filename));
  for (const f of files) {
    const dest = path.join(f.dir, f.filename);
    writeLabeledJpeg(dest, f.title, f.bg);
    if (have.has(f.filename)) continue;
    const st = await (await import('node:fs/promises')).stat(dest);
    await hr.insertDocument({
      id: 'D-seed-' + f.category, category: f.category, relativePath: f.filename, filename: f.filename,
      size: st.size, mtime: Math.trunc(st.mtimeMs), available: true, employeeId: 'EMP-014', suggestions: [],
    }, 'seed');
  }
  const pdfName = 'EMP-014_陳志明_駕照_20260501T100200_abc123abc123.pdf';
  const pdfDest = path.join(license, pdfName);
  await writeFile(pdfDest, Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
  if (!have.has(pdfName)) {
    const st = await (await import('node:fs/promises')).stat(pdfDest);
    await hr.insertDocument({
      id: 'D-seed-license', category: 'license', relativePath: pdfName, filename: pdfName,
      size: st.size, mtime: Math.trunc(st.mtimeMs), available: true, employeeId: 'EMP-014', suggestions: [], expiresOn: '2026-12-05',
    }, 'seed');
  }
}

export async function prepareDocFolders(root) {
  for (const name of ['身分證', '存摺', '駕照', '履歷表', '身分證離職']) await mkdir(path.join(root, name), {recursive: true});
  process.env.NAS_IDENTITY_PATH = path.join(root, '身分證');
  process.env.NAS_BANK_PATH = path.join(root, '存摺');
  process.env.NAS_LICENSE_PATH = path.join(root, '駕照');
  process.env.NAS_RESUME_PATH = path.join(root, '履歷表');
  process.env.NAS_IDENTITY_LEFT_PATH = path.join(root, '身分證離職');
  return {
    identity: process.env.NAS_IDENTITY_PATH,
    bank: process.env.NAS_BANK_PATH,
    license: process.env.NAS_LICENSE_PATH,
    resume: process.env.NAS_RESUME_PATH,
    identityLeft: process.env.NAS_IDENTITY_LEFT_PATH,
  };
}
