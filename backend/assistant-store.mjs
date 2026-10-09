import {AppError} from './domain.mjs';
export const taipeiDay=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export const taipeiHour=(now=new Date())=>Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',hourCycle:'h23'}).format(now));
export class AssistantStore {
 constructor(store){this.store=store;this.pool=store.pool;}
 async init(){await this.pool.query(`
 CREATE TABLE IF NOT EXISTS cb_line_jobs(id text PRIMARY KEY,event jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',lease_until timestamptz,reply_text text,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS cb_line_members(user_id text PRIMARY KEY,display_name text NOT NULL DEFAULT '',active boolean NOT NULL DEFAULT true,reminders boolean NOT NULL DEFAULT true,event_ms bigint NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS cb_media(id text PRIMARY KEY,mime text NOT NULL,name text NOT NULL,body bytea NOT NULL,owner_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS cb_notifications(id text PRIMARY KEY,user_id text NOT NULL,retry_key text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,lease_until timestamptz,next_attempt timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS cb_notifications_pending ON cb_notifications(status,next_attempt);`);}
 async member(id){return (await this.pool.query('SELECT * FROM cb_line_members WHERE user_id=$1',[id])).rows[0];}
 async register(id,name='',active=true,ms=Date.now()){await this.pool.query(`INSERT INTO cb_line_members(user_id,display_name,active,event_ms) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET display_name=CASE WHEN excluded.display_name<>'' THEN excluded.display_name ELSE cb_line_members.display_name END,active=excluded.active,event_ms=excluded.event_ms WHERE cb_line_members.event_ms<=excluded.event_ms`,[id,name,active,ms]);}
 async subscription(id,on){await this.pool.query('UPDATE cb_line_members SET reminders=$2 WHERE user_id=$1',[id,on]);}
 async media(id,includeBody=false){return (await this.pool.query('SELECT id,mime,name,owner_id,created_at'+(includeBody?',body':'')+' FROM cb_media WHERE id=$1',[id])).rows[0];}
 async putMedia(m){await this.pool.query('INSERT INTO cb_media(id,mime,name,body,owner_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[m.id,m.mime,m.name,m.body,m.owner_id]);return this.media(m.id);}
 async enqueue(events){const c=await this.pool.connect();try{await c.query('BEGIN');for(const e of events)await c.query('INSERT INTO cb_line_jobs(id,event) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.webhookEventId,e]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async claim(){return (await this.pool.query(`UPDATE cb_line_jobs SET status='processing',lease_until=now()+interval '5 minutes' WHERE id=(SELECT id FROM cb_line_jobs WHERE status='pending' OR (status='processing' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];}
 async answer(id,text){await this.pool.query('UPDATE cb_line_jobs SET reply_text=$2 WHERE id=$1',[id,text]);}
 async finish(id,status='done'){await this.pool.query("UPDATE cb_line_jobs SET status=$2,lease_until=NULL,event=event-'replyToken' WHERE id=$1",[id,status]);}
 async mutate(fn,actor){for(let attempt=0;attempt<8;attempt++){const state=await this.store.read(),next=fn(state);if(!next)return state;try{return await this.store.save(state.revision,next,actor);}catch(e){if(e.status!==409||attempt===7)throw e;}}throw new AppError(409,'多人同時修改，請稍後重試');}
 async notify(id,userId,payload,retryKey){await this.pool.query('INSERT INTO cb_notifications(id,user_id,payload,retry_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,userId,payload,retryKey]);}
 async claimNotice(){return (await this.pool.query(`UPDATE cb_notifications SET status='sending',lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE id=(SELECT id FROM cb_notifications WHERE ((status='pending' AND next_attempt<=now()) OR (status='sending' AND lease_until<now())) AND created_at>now()-interval '23 hours' AND attempts<6 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];}
 async finishNotice(id,status,retry=false){await this.pool.query("UPDATE cb_notifications SET status=$2,lease_until=NULL,next_attempt=now()+interval '15 minutes' WHERE id=$1",[id,retry?'pending':status]);}
}
