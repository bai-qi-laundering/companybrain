// 客衣群組路由。只接受經 LINE 簽章驗證後的事件；不處理一般 AI 對話。
export const HOTEL_CODE=/^[A-Z][A-Z0-9_-]{1,31}$/;
export function bindingCommand(event){
 if(event?.source?.type!=='group'||typeof event.source.groupId!=='string')return null;
 if(event.type!=='message'||event.message?.type!=='text')return null;
 const text=event.message.text.trim().replace(/\\s+/g,' ');
 if(text==='綁定客衣通知')return {kind:'work'};
 const match=/^綁定飯店 ([A-Za-z][A-Za-z0-9_-]{1,31})$/.exec(text);
 return match?{kind:'hotel',code:match[1].toUpperCase()}:null;
}
export async function initGarmentRouting(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS cb_garment_groups (
 group_id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('hotel','work')),
 hotel_code text, bound_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT cb_garment_hotel_code CHECK((kind='hotel' AND hotel_code IS NOT NULL) OR (kind='work' AND hotel_code IS NULL))
 )`);
 await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS cb_garment_unique_hotel ON cb_garment_groups(hotel_code) WHERE kind='hotel'");
 await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS cb_garment_unique_work ON cb_garment_groups(kind) WHERE kind='work'");
}
export async function bindGarmentGroup(pool,groupId,userId,command){
 if(!/^C[0-9a-f]{32}$/i.test(groupId))throw Error('invalid group id');
 if(!/^U[0-9a-f]{32}$/i.test(userId))throw Error('invalid user id');
 if(command.kind==='hotel'&&!HOTEL_CODE.test(command.code))throw Error('invalid hotel code');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  // 不允許同一飯店代碼或通知群組被另一個群組無聲覆蓋。
  const current=await client.query("SELECT group_id FROM cb_garment_groups WHERE (kind='work' AND $1='work') OR (kind='hotel' AND hotel_code=$2) FOR UPDATE",[command.kind,command.code||null]);
  if(current.rows.some(r=>r.group_id!==groupId)){await client.query('ROLLBACK');return '這個代碼已綁定其他群組，請由管理員先解除舊綁定。';}
  await client.query(`INSERT INTO cb_garment_groups(group_id,kind,hotel_code,bound_by)
  VALUES($1,$2,$3,$4) ON CONFLICT(group_id) DO UPDATE SET kind=excluded.kind,hotel_code=excluded.hotel_code,bound_by=excluded.bound_by,updated_at=now()`,[groupId,command.kind,command.code||null,userId]);
  await client.query('COMMIT');
  return command.kind==='work'?'客衣工作群組綁定完成。':'飯店群組綁定完成：'+command.code;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function findGarmentGroup(pool,hotelCode){
 if(!HOTEL_CODE.test(hotelCode))return null;
 const r=await pool.query("SELECT group_id FROM cb_garment_groups WHERE kind='hotel' AND hotel_code=$1",[hotelCode]);
 return r.rows[0]?.group_id||null;
}
export async function findGarmentWorkGroup(pool){
 const r=await pool.query("SELECT group_id FROM cb_garment_groups WHERE kind='work'");
 return r.rows[0]?.group_id||null;
}
