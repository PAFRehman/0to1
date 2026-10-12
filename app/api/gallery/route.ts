import {NextResponse} from 'next/server'
import {resolveContract,verifyContract,serverClient,abi,errorText} from '@/lib/mint/server'
import type {Creation} from '@/lib/mint/types'
export const dynamic='force-dynamic'
export async function GET(request:Request){
  try{
    const address=resolveContract(request);if(!address)return NextResponse.json({items:[],latestId:'0',nextCursor:null,configured:false})
    await verifyContract(address)
    const cursor=new URL(request.url).searchParams.get('cursor')||'0'
    if(!/^\d{1,20}$/.test(cursor))return NextResponse.json({error:'Invalid page cursor.'},{status:400})
    const client=serverClient(),latestId=await client.readContract({address,abi,functionName:'latestId'}) as bigint
    const activity=await client.readContract({address,abi,functionName:'activityNonce'}) as bigint
    if(new URL(request.url).searchParams.get('head')==='1')return NextResponse.json({latestId:latestId.toString(),activity:String(activity)},{headers:{'Cache-Control':'no-store'}})
    const rows=await client.readContract({address,abi,functionName:'getPage',args:[BigInt(cursor),8n]}) as Array<Record<string,unknown>>
    const items=rows.map(r=>({...r,tokenId:String(r.tokenId),mintedAt:Number(r.mintedAt),previousId:String(r.previousId),witnessCount:Number(r.witnessCount)})) as Creation[]
    const last=items.at(-1)?.tokenId
    return NextResponse.json({items,latestId:String(latestId),activity:String(activity),nextCursor:last&&BigInt(last)>1n?String(BigInt(last)-1n):null,configured:true},{headers:{'Cache-Control':'no-store'}})
  }catch(error){return NextResponse.json({error:errorText(error)},{status:503})}
}
