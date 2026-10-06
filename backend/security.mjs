import {scryptSync,randomBytes,timingSafeEqual,createHash} from 'node:crypto';
export function hashPassword(password){const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');}
export function verifyPassword(password,encoded){const [salt,key]=encoded.split(':');if(!salt||!key)return false;const expected=Buffer.from(key,'hex'),actual=scryptSync(password,salt,64);return expected.length===actual.length&&timingSafeEqual(expected,actual);}
export const token=()=>randomBytes(32).toString('hex');
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function cookieToken(req){const cookie=(req.headers.cookie||'').split(';').find(x=>x.trim().startsWith('companybrain_session='));return cookie?cookie.trim().slice('companybrain_session='.length):'';}
export function sessionCookie(value,secure,maxAge=604800){return `companybrain_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;}
