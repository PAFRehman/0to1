import {NextResponse} from 'next/server'
import {parseTransaction} from 'viem'
import {rpcURL,serverClient,sameOrigin} from '@/lib/mint/server'
export const dynamic='force-dynamic'
const methods=new Set(['eth_chainId','eth_blockNumber','eth_getBalance','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getBlockByNumber','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_sendRawTransaction','eth_getLogs'])
let validUntil=0
export async function POST(request:Request){
  if(!sameOrigin(request))return NextResponse.json({error:{message:'Foreign-origin requests are refused.'}},{status:403})
  try{
    const text=await request.text();if(text.length>400_000)throw new Error('Request is too large.')
    const body=JSON.parse(text),calls=Array.isArray(body)?body:[body]
    if(calls.length<1||calls.length>12)throw new Error('Too many requests.')
    for(const call of calls){
      if(!methods.has(call.method))throw new Error('RPC method not supported.')
      if(call.method==='eth_sendRawTransaction'&&parseTransaction(call.params?.[0]).chainId!==84532)throw new Error('Only Base Sepolia transactions can be broadcast.')
    }
    if(Date.now()>validUntil){if(await serverClient().getChainId()!==84532)throw new Error('Wrong RPC network. Use Base Sepolia.');validUntil=Date.now()+60_000}
    const response=await fetch(rpcURL(),{method:'POST',headers:{'Content-Type':'application/json'},body:text,signal:AbortSignal.timeout(15_000),cache:'no-store'})
    if(!response.ok)throw new Error('The testnet RPC is unavailable. Please retry.')
    return NextResponse.json(await response.json(),{headers:{'Cache-Control':'no-store'}})
  }catch(error){return NextResponse.json({jsonrpc:'2.0',id:null,error:{code:-32000,message:error instanceof Error?error.message:'RPC unavailable'}},{status:502})}
}
