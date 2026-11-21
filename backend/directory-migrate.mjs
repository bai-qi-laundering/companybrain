// 啟動時把「連結資料夾」的名錄種類對齊對象的種類（例如餐廳從廠商改成客人）。
// 只改資料庫裡的連結（cb_directory_folders role<>'primary'），不搬動、不改名 NAS 上任何檔案或資料夾。
// 可重複執行（已對齊的不會再動）。
import {orgDirectoryKind} from './directory-docs.mjs';

export async function syncLinkedFolderKinds(store, {log = () => {}} = {}) {
  if (typeof store.ensureDirectoryFolders === 'function') await store.ensureDirectoryFolders();
  const state = await store.read();
  const want = new Map((state.organizations || []).map((o) => [o.id, orgDirectoryKind(o)]));
  const rows = (await store.pool.query("SELECT kind, entity_id, relative_path, source FROM cb_directory_folders WHERE kind IN ('vendors','clients') AND role<>'primary'")).rows;
  const moved = [];
  for (const r of rows) {
    const kind = want.get(r.entity_id);
    if (!kind || kind === r.kind) continue;
    await store.pool.query(
      `INSERT INTO cb_directory_folders(kind, entity_id, relative_path, role, source)
       SELECT $1, $2, $3, 'linked', $4
       WHERE NOT EXISTS (SELECT 1 FROM cb_directory_folders WHERE kind=$1 AND entity_id=$2 AND relative_path=$3)`,
      [kind, r.entity_id, r.relative_path, r.source || 'auto']);
    await store.pool.query('DELETE FROM cb_directory_folders WHERE kind=$1 AND entity_id=$2 AND relative_path=$3 AND role<>\'primary\'', [r.kind, r.entity_id, r.relative_path]);
    moved.push({entityId: r.entity_id, from: r.kind, to: kind, relativePath: r.relative_path});
  }
  if (moved.length) log(`名錄連結資料夾種類已對齊：${moved.length} 筆（${[...new Set(moved.map((m) => m.from + '→' + m.to))].join('、')}），未搬動任何檔案`);
  return moved;
}
