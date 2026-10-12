import {NextResponse} from 'next/server'
import {createHash} from 'node:crypto'
import type {Address,Hex} from 'viem'
import {readUploadClaim,uploadMessage} from '@/lib/mint/upload-auth'
import {sameOrigin,serverClient} from '@/lib/mint/server'
export const dynamic='force-dynamic'
export const maxDuration=30
const recent=new Map<string,number[]>()
function validMedia(b:Buffer,mime:string){
  if(mime==='image/png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  if(mime==='image/jpeg')return b[0]===255&&b[1]===216&&b[2]===255
  if(mime==='image/gif')return /^GIF8[79]a/.test(b.subarray(0,6).toString())
  if(mime==='image/webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'
  if(mime==='video/mp4')return b.subarray(4,8).toString()==='ftyp'
  if(mime==='video/webm'||mime==='audio/webm')return b.subarray(0,4).equals(Buffer.from([26,69,223,163]))
  if(mime==='audio/ogg')return b.subarray(0,4).toString()==='OggS'
  if(mime==='audio/mpeg')return b.subarray(0,3).toString()==='ID3'||(b[0]===255&&(b[1]&224)===224)
  if(mime==='audio/wav'||mime==='audio/x-wav')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WAVE'
  if(mime==='application/pdf')return b.subarray(0,5).toString()==='%PDF-'
  return false
}
export async function POST(request:Request){
  if(!sameOrigin(request))return NextResponse.json({error:'Foreign-origin uploads are refused.'},{status:403})
  if(!process.env.PINATA_JWT)return NextResponse.json({error:'Add PINATA_JWT in the server settings to enable larger media.'},{status:503})
  try{
    if(Number(request.headers.get('content-length'))>3_400_000)throw new Error('Keep the file below 3 MB.')
    const form=await request.formData(),file=form.get('file'),token=form.get('token'),signature=form.get('signature')
    if(!(file instanceof File)||file.size>3_000_000||file.size===0||typeof token!=='string'||typeof signature!=='string')throw new Error('Choose a supported file below 3 MB.')
    const claim=readUploadClaim(token,new URL(request.url).origin),bytes=Buffer.from(await file.arrayBuffer())
    if(!validMedia(bytes,file.type))throw new Error('Choose a real JPG, PNG, WebP, GIF, MP4, WebM, MP3, OGG, WAV or PDF file.')
    if('0x'+createHash('sha256').update(bytes).digest('hex')!==claim.hash)throw new Error('The file changed after signing. Try again.')
    if(!await serverClient().verifyMessage({address:claim.address as Address,message:uploadMessage(claim),signature:signature as Hex}))throw new Error('The wallet signature is invalid.')
    const key=claim.address.toLowerCase(),times=(recent.get(key)??[]).filter(t=>t>Date.now()-600_000)
    if(times.length>=8)throw new Error('You have uploaded several files. Try again in a few minutes.')
    times.push(Date.now());recent.set(key,times)
    if(recent.size>2000)for(const [k,v] of recent)if(v.every(t=>t<Date.now()-600_000))recent.delete(k)
    const payload=new FormData();payload.append('file',file);payload.append('pinataOptions',JSON.stringify({cidVersion:1}));payload.append('pinataMetadata',JSON.stringify({name:'PenguMint '+file.name.slice(0,80)}))
    const response=await fetch(process.env.PINATA_PIN_URL||'https://api.pinata.cloud/pinning/pinFileToIPFS',{method:'POST',headers:{Authorization:'Bearer '+process.env.PINATA_JWT},body:payload,signal:AbortSignal.timeout(20_000)})
    if(!response.ok)throw new Error('IPFS could not save this file. Your draft is still here.')
    const data=await response.json(),cid=String(data.IpfsHash??'')
    if(!/^(bafy[a-z2-7]{20,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(cid))throw new Error('IPFS returned an invalid content address.')
    return NextResponse.json({uri:'ipfs://'+cid,fileHash:claim.hash,mediaType:file.type})
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Upload failed.'},{status:400})}
}
