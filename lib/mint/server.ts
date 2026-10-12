import 'server-only'
import { createPublicClient,http,keccak256,isAddress,type Address,type Hex,type Abi } from 'viem'
import { baseSepolia } from './chain'
import artifact from './contract.json'
export const abi=artifact.abi as Abi
export const rpcURL=()=>process.env.BASE_SEPOLIA_RPC_URL||'https://sepolia.base.org'
export const serverClient=()=>createPublicClient({chain:baseSepolia,transport:http(rpcURL(),{timeout:12_000,retryCount:1})})
const verified=new Map<string,number>()
export async function verifyContract(address:Address){
  if((verified.get(address.toLowerCase())??0)>Date.now())return
  const c=serverClient()
  if(await c.getChainId()!==84532)throw new Error('The RPC must use Base Sepolia, chain 84532.')
  const bytecode=await c.getBytecode({address})
  if(!bytecode||keccak256(bytecode)!==keccak256(artifact.deployedBytecode as Hex))throw new Error('This address is not the included PenguMint contract on Base Sepolia.')
  verified.set(address.toLowerCase(),Date.now()+60_000)
}
export function resolveContract(request:Request):Address|null{
  const candidate=new URL(request.url).searchParams.get('contract')||process.env.NEXT_PUBLIC_MINT_CONTRACT||''
  if(!candidate)return null
  if(!isAddress(candidate))throw new Error('Enter a valid contract address.')
  return candidate as Address
}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin}
export function errorText(error:unknown){return error instanceof Error?error.message:'Please try again.'}
