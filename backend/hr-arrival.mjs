/** Fill empty hire dates from the earliest labor/health enrollment date. */
export function isEnrollment(record) {
  const p = record.payload || record;
  return (p.labor === '加保' || p.health === '加保') && /^\d{4}-\d{2}-\d{2}$/.test(p.date || '');
}

export function earliestEnrollmentDate(records) {
  const dates = records.filter(isEnrollment).map((r) => (r.payload || r).date).sort();
  return dates[0] || '';
}

export function planArrivalFromInsurance(employees, records) {
  const recsByEmp = new Map();
  for (const r of records) {
    if ((r.kind || r.kind === undefined) && (r.kind === 'insurance' || r.payload?.labor || r.labor)) {
      const kind = r.kind || 'insurance';
      if (kind !== 'insurance') continue;
      const eid = r.employeeId || r.employee_id;
      if (!recsByEmp.has(eid)) recsByEmp.set(eid, []);
      recsByEmp.get(eid).push(r);
    }
  }
  const filled = [];
  const stillMissing = [];
  for (const emp of employees) {
    if (emp.arrivalDate) continue;
    const date = earliestEnrollmentDate(recsByEmp.get(emp.id) || []);
    if (date) filled.push({employeeId: emp.id, name: emp.name, arrivalDate: date, source: '加保日'});
    else stillMissing.push({employeeId: emp.id, name: emp.name});
  }
  return {filled, stillMissing};
}

export async function applyArrivalFill(pool, {employees, records, now = new Date().toISOString()} = {}) {
  const list = employees.map((e) => ({
    id: e.id,
    name: e.name || e.payload?.name || '',
    arrivalDate: e.arrivalDate ?? e.payload?.arrivalDate ?? '',
  }));
  const recs = records.map((r) => ({
    ...r,
    kind: r.kind,
    employee_id: r.employeeId || r.employee_id,
    payload: r.payload || r.data || r,
  }));
  const plan = planArrivalFromInsurance(list, recs);
  let filled = 0;
  for (const item of plan.filled) {
    const cur = await pool.query('SELECT payload FROM hr_employees WHERE id=$1', [item.employeeId]);
    if (!cur.rowCount) continue;
    const payload = cur.rows[0].payload || {};
    if (payload.arrivalDate) continue;
    payload.arrivalDate = item.arrivalDate;
    payload.arrivalDateSource = {type: '加保日', date: item.arrivalDate, at: now};
    await pool.query('UPDATE hr_employees SET payload=$2::jsonb, updated_at=now() WHERE id=$1', [item.employeeId, JSON.stringify(payload)]);
    filled += 1;
  }
  return {filled, stillMissing: plan.stillMissing.length, planned: plan};
}
