import 'server-only'
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'
type Claim={address:string;hash:string;expires:number;nonce:string;origin:string}
const secret=()=>process.env.UPLOAD_AUTH_SECRET||process.env.PINATA_JWT||''
export function uploadMessage(c:Claim){return `PenguMint IPFS upload\nAddress: ${c.address.toLowerCase()}\nSHA256: ${c.hash}\nExpires: ${c.expires}\nNonce: ${c.nonce}\nOrigin: ${c.origin}`}
export function makeUploadClaim(address:string,hash:string,origin:string){
  const claim:Claim={address,hash,expires:Date.now()+300_000,nonce:randomBytes(16).toString('hex'),origin}
  const data=Buffer.from(JSON.stringify(claim)).toString('base64url'),mac=createHmac('sha256',secret()).update(data).digest('base64url')
  return {token:data+'.'+mac,message:uploadMessage(claim)}
}
export function readUploadClaim(token:string,origin:string):Claim{
  if(token.length>1400)throw new Error('Invalid upload permission.')
  const [data,mac]=token.split('.'),expected=createHmac('sha256',secret()).update(data||'').digest()
  const actual=Buffer.from(mac||'','base64url')
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error('Invalid upload permission.')
  const claim=JSON.parse(Buffer.from(data,'base64url').toString('utf8')) as Claim
  if(claim.expires<Date.now()||claim.expires>Date.now()+300_000||claim.origin!==origin)throw new Error('Upload permission expired. Please try again.')
  return claim
}
