import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

export type WalletVault = { format:'pengumint-wallet'; version:1; address:string; iterations:number; salt:string; iv:string; cipher:string }
const iterations=310_000
const encode=(value:Uint8Array)=>btoa(Array.from(value,x=>String.fromCharCode(x)).join(''))
const decode=(value:string)=>Uint8Array.from(atob(value),x=>x.charCodeAt(0))
async function derive(password:string,salt:Uint8Array,rounds:number){
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey'])
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:salt as BufferSource,iterations:rounds,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])
}
export async function encryptWallet(privateKey:Hex,password:string):Promise<WalletVault>{
  if(password.length<10)throw new Error('Use a password of at least 10 characters.')
  const account=privateKeyToAccount(privateKey),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12))
  const key=await derive(password,salt,iterations)
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(privateKey))
  return {format:'pengumint-wallet',version:1,address:account.address,iterations,salt:encode(salt),iv:encode(iv),cipher:encode(new Uint8Array(cipher))}
}
export function validateVault(value:unknown):WalletVault{
  const v=value as WalletVault
  if(!v||v.format!=='pengumint-wallet'||v.version!==1||!/^0x[0-9a-fA-F]{40}$/.test(v.address)||v.iterations!==iterations||[v.salt,v.iv,v.cipher].some(x=>typeof x!=='string'||x.length>400))throw new Error('This is not a PenguMint encrypted wallet backup.')
  if(decode(v.salt).length!==16||decode(v.iv).length!==12||decode(v.cipher).length!==82)throw new Error('The wallet backup is incomplete.')
  return v
}
export async function unlockWallet(value:unknown,password:string):Promise<Hex>{
  try{
    const v=validateVault(value),key=await derive(password,decode(v.salt),v.iterations)
    const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(v.iv) as BufferSource},key,decode(v.cipher) as BufferSource)
    const privateKey=new TextDecoder().decode(data) as Hex
    if(privateKeyToAccount(privateKey).address.toLowerCase()!==v.address.toLowerCase())throw new Error('Address mismatch')
    return privateKey
  }catch{throw new Error('That password could not unlock this wallet.')}
}
export async function createVault(password:string){const privateKey=generatePrivateKey();return {vault:await encryptWallet(privateKey,password),privateKey}}
