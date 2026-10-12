import {NextResponse} from 'next/server'
import {isAddress} from 'viem'
import {makeUploadClaim} from '@/lib/mint/upload-auth'
export const dynamic='force-dynamic'
export async function GET(request:Request){
  if(!process.env.PINATA_JWT)return NextResponse.json({error:'IPFS uploads are not configured. Direct onchain notes and images still work.'},{status:503})
  const url=new URL(request.url),address=url.searchParams.get('address')||'',hash=url.searchParams.get('hash')||''
  if(!isAddress(address)||!/^0x[0-9a-f]{64}$/.test(hash))return NextResponse.json({error:'Invalid upload request.'},{status:400})
  return NextResponse.json(makeUploadClaim(address,hash,url.origin),{headers:{'Cache-Control':'no-store'}})
}
