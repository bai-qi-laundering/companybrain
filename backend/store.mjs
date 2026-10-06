import pg from 'pg';
import {initialState,AppError} from './domain.mjs';
import {hashPassword} from './security.mjs';
const tableNames={organizations:'cb_organizations',records:'cb_records',tasks:'cb_tasks'};
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
const equal=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
export class Store {
 constructor(pool=new pg.Pool({max:5,connectionTimeoutMillis:10000})){this.pool=pool;}
 async init(username,password){await this.pool.query(`CREATE TABLE IF NOT EXISTS cb_users (username text PRIMARY KEY,password_hash text NOT NULL);
 CREATE TABLE IF NOT EXISTS cb_sessions (token_hash text PRIMARY KEY,username text NOT NULL REFERENCES cb_users(username),csrf text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS cb_meta (id integer PRIMARY KEY CHECK(id=1),revision integer NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS cb_organizations (id text PRIMARY KEY,payload jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS cb_records (id text PRIMARY KEY,org_id text NOT NULL REFERENCES cb_organizations(id),payload jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS cb_tasks (id text PRIMARY KEY,org_id text REFERENCES cb_organizations(id),payload jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS cb_audit (id bigserial PRIMARY KEY,revision integer NOT NULL,username text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,before_data jsonb,after_data jsonb,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS cb_records_org ON cb_records(org_id);
 CREATE INDEX IF NOT EXISTS cb_tasks_org ON cb_tasks(org_id);`);
 await this.pool.query('INSERT INTO cb_users(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash',[username,hashPassword(password)]);
 await this.pool.query('DELETE FROM cb_sessions');
 const added=await this.pool.query('INSERT INTO cb_meta(id,revision) VALUES(1,0) ON CONFLICT DO NOTHING RETURNING id');
 if(added.rowCount)for(const o of initialState.organizations)await this.pool.query('INSERT INTO cb_organizations(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING',[o.id,o]);}
 async user(name){return (await this.pool.query('SELECT * FROM cb_users WHERE username=$1',[name])).rows[0];}
 async addSession(hash,user,csrf){await this.pool.query("INSERT INTO cb_sessions(token_hash,username,csrf,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[hash,user,csrf]);}
 async session(hash){return (await this.pool.query('SELECT * FROM cb_sessions WHERE token_hash=$1 AND expires_at>now()',[hash])).rows[0];}
 async deleteSession(hash){await this.pool.query('DELETE FROM cb_sessions WHERE token_hash=$1',[hash]);}
 async read(client=this.pool){
 // One statement ensures revision and all entity arrays share one MVCC snapshot.
 const r=(await client.query(`SELECT revision,
 COALESCE((SELECT jsonb_agg(payload ORDER BY id) FROM cb_organizations),'[]'::jsonb) AS organizations,
 COALESCE((SELECT jsonb_agg(payload ORDER BY id) FROM cb_records),'[]'::jsonb) AS records,
 COALESCE((SELECT jsonb_agg(payload ORDER BY id) FROM cb_tasks),'[]'::jsonb) AS tasks
 FROM cb_meta WHERE id=1`)).rows[0];return r;
 }
 async save(expected,state,user){const c=await this.pool.connect();try{await c.query('BEGIN');const lock=(await c.query('SELECT revision FROM cb_meta WHERE id=1 FOR UPDATE')).rows[0];if(lock.revision!==expected)throw new AppError(409,'另一台裝置已更新資料，請先重新載入，再重試。');const old=await this.read(c),rev=expected+1;const changes=[];
 for(const kind of ['organizations','records','tasks']){const previous=new Map(old[kind].map(x=>[x.id,x])),next=new Map(state[kind].map(x=>[x.id,x]));for(const [id,before] of previous)if(!next.has(id))changes.push({kind,id,before,after:null});for(const [id,after] of next){const before=previous.get(id)||null;if(!before||!equal(before,after))changes.push({kind,id,before,after});}}
 for(const kind of ['records','tasks','organizations'])for(const change of changes.filter(x=>x.kind===kind&&!x.after))await c.query(`DELETE FROM ${tableNames[kind]} WHERE id=$1`,[change.id]);
 for(const kind of ['organizations','records','tasks'])for(const change of changes.filter(x=>x.kind===kind&&x.after)){const row=change.after;if(kind==='organizations')await c.query(`INSERT INTO cb_organizations(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,[row.id,row]);else await c.query(`INSERT INTO ${tableNames[kind]}(id,org_id,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET org_id=excluded.org_id,payload=excluded.payload`,[row.id,row.org||null,row]);}
 for(const change of changes)await c.query('INSERT INTO cb_audit(revision,username,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)',[rev,user,change.kind,change.id,change.before,change.after]);
 await c.query('UPDATE cb_meta SET revision=$1 WHERE id=1',[rev]);await c.query('COMMIT');return {...state,revision:rev};}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
 async health(){await this.pool.query('SELECT 1');}
}
