import {NextResponse} from 'next/server'
import {resolveContract,verifyContract,errorText} from '@/lib/mint/server'
export const dynamic='force-dynamic'
export async function GET(request:Request){
  try{const contract=resolveContract(request);if(contract)await verifyContract(contract);return NextResponse.json({contract,chainId:84532,pinning:!!process.env.PINATA_JWT,walletConnect:!!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,status:contract?'ready':'setup'},{headers:{'Cache-Control':'no-store'}})}
  catch(error){return NextResponse.json({contract:null,chainId:84532,pinning:!!process.env.PINATA_JWT,walletConnect:!!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,status:'offline',message:errorText(error)},{status:503})}
}
