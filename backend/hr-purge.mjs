export const KEEP_RECRUITMENT_STATUS = '待報到';

export function isKeptRecruitmentStatus(status) {
  return String(status || '').trim() === KEEP_RECRUITMENT_STATUS;
}

export function shouldSkipMigratedRecruitment(id, candidateId, purgedIds) {
  if (id && purgedIds.has(id)) return true;
  if (candidateId && purgedIds.has(candidateId)) return true;
  return false;
}
