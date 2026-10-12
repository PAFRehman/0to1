import {NextResponse} from 'next/server'
import {isAddress} from 'viem'
import {resolveContract,verifyContract,serverClient,abi,errorText} from '@/lib/mint/server'
export const dynamic='force-dynamic'
export async function GET(request:Request){try{const contract=resolveContract(request),address=new URL(request.url).searchParams.get('address')||'';if(!contract||!isAddress(address))return NextResponse.json({error:'Choose a wall and a wallet.'},{status:400});await verifyContract(contract);const values=await serverClient().readContract({address:contract,abi,functionName:'passports',args:[address]}) as [number,number,number,number,number,bigint];return NextResponse.json({media:Number(values[0]),notes:Number(values[1]),signatures:Number(values[2]),proofs:Number(values[3]),witnessed:Number(values[4]),firstSeen:Number(values[5])},{headers:{'Cache-Control':'no-store'}})}catch(e){return NextResponse.json({error:errorText(e)},{status:503})}}
