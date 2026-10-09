import {readFile} from 'node:fs/promises';
import {AppError,requireText,validateState} from './domain.mjs';
import {token,digest,cookieToken,sessionCookie,verifyPassword,hashPassword} from './security.mjs';
import {extractDraft} from './gemini.mjs';
import {understand,answerQuestion} from './assistant.mjs';
export function createHandler({store,config,htmlPath,line,ai=extractDraft,queryAI=understand,answerAI=answerQuestion}){
 const limits=new Map(),dummyHash=hashPassword(token());
 function limit(key,max){const now=Date.now();if(limits.size>10000)for(const [k,v] of limits)if(now-v.since>60000)limits.delete(k);let v=limits.get(key);if(!v||now-v.since>60000){v={since:now,n:0};limits.set(key,v)}if(++v.n>max)throw new AppError(429,'操作太頻繁，請一分鐘後重試');}
 async function body(req){let size=0,parts=[];for await(const p of req){size+=p.length;if(size>3*1024*1024)throw new AppError(413,'資料太大，請分批處理');parts.push(p)}try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw new AppError(400,'請提供有效的 JSON')}}
 return async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
 try{const path=new URL(req.url,'http://localhost').pathname;
 if(req.method==='POST'&&path==='/api/line/webhook'){if(!line)throw new AppError(503,'LINE 尚未設定');return send(200,await line.webhook(req));}
 if(req.method==='GET'&&path==='/api/health'){await store.health();return send(200,{ok:true,service:'companybrain-api'})}
 if(req.method==='GET'&&['/','/index.html'].includes(path)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end((await readFile(htmlPath,'utf8')).replace('</head>','<meta name="companybrain-runtime" content="nas"></head>'));return}
 if(!path.startsWith('/api/'))throw new AppError(404,'找不到頁面');
 if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==config.origin)throw new AppError(403,'網址不符，請檢查 NAS 的 PUBLIC_ORIGIN');
 if(req.method==='POST'&&path==='/api/login'){limit('login:'+req.socket.remoteAddress,8);const b=await body(req),name=requireText(b.username,'帳號',100),password=requireText(b.password,'密碼',200);const user=await store.user(name);const valid=verifyPassword(password,user?.password_hash||dummyHash);if(!user||!valid)throw new AppError(401,'帳號或密碼錯誤');const raw=token(),csrf=token();await store.addSession(digest(raw),name,csrf);res.setHeader('Set-Cookie',sessionCookie(raw,config.secure));return send(200,{username:name,csrf})}
 const session=await store.session(digest(cookieToken(req)));if(!session)throw new AppError(401,'請先登入');
 if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==session.csrf)throw new AppError(403,'登入驗證已失效，請重新登入');
 if(req.method==='GET'&&path==='/api/session')return send(200,{username:session.username,csrf:session.csrf,geminiConfigured:Boolean(config.key&&config.key!=='PASTE_YOUR_KEY_HERE'),model:config.model});
 if(req.method==='POST'&&path==='/api/logout'){await store.deleteSession(digest(cookieToken(req)));res.setHeader('Set-Cookie',sessionCookie('',config.secure,0));return send(200,{ok:true})}
 if(req.method==='GET'&&/^\/api\/files\/media-[a-f0-9]{64}$/.test(path)){const m=await line?.db.media(path.split('/').at(-1),true);if(!m)throw new AppError(404,'找不到附件');const total=m.body.length;let start=0,end=total-1,status=200;const range=req.headers.range;if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':'bytes */'+total});res.end();return;}if(match[1]){start=Number(match[1]);end=match[2]?Number(match[2]):end;}else start=Math.max(0,total-Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=total||end<start){res.writeHead(416,{'Content-Range':'bytes */'+total});res.end();return;}end=Math.min(end,total-1);status=206;}res.writeHead(status,{'Content-Type':m.mime,'Content-Length':end-start+1,'Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(m.name),'Accept-Ranges':'bytes',...(status===206?{'Content-Range':'bytes '+start+'-'+end+'/'+total}:{})});res.end(m.body.subarray(start,end+1));return;}
 if(req.method==='POST'&&path==='/api/ai/question'){limit('ai:'+session.username,10);const b=await body(req),text=requireText(b.text,'問題',8000),state=await store.read(),plan=await queryAI({text:'查詢：'+text,organizations:state.organizations,key:config.key,model:config.model});if(plan.kind!=='query')throw new AppError(400,'請描述要查詢的問題');return send(200,await answerAI({text,state,plan,key:config.key,model:config.model,origin:config.origin}));}
 if(req.method==='GET'&&path==='/api/state')return send(200,await store.read());
 if(req.method==='PUT'&&path==='/api/state'){const b=await body(req);if(!Number.isSafeInteger(b.revision)||b.revision<0)throw new AppError(400,'版本不正確');const state=validateState({organizations:b.organizations,records:b.records,tasks:b.tasks});return send(200,await store.save(b.revision,state,session.username));}
 if(req.method==='POST'&&path==='/api/ai/draft'){limit('ai:'+session.username,10);const b=await body(req),text=requireText(b.text,'輸入文字',8000),state=await store.read();const draft=await ai({text,organizations:state.organizations,key:config.key,model:config.model});return send(200,{draft,sourceText:text})}
 throw new AppError(404,'找不到這項功能');
 }catch(e){if(!res.headersSent)send(e.status||500,{error:e.status?e.message:'服務暫時無法處理，請查看 NAS 容器狀態'});else res.end();if(!e.status)console.error('companybrain request failed:',e.code||e.name);}
 };
}
