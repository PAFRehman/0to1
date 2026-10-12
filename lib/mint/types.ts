import type { Address, Hex } from 'viem'
export type CreationKind = 'media' | 'note' | 'signature' | 'proof'
export type MintInput = { title:string; note:string; mediaURI:string; mediaType:string; fileHash:Hex; kind:number;previousId:bigint }
export type Creation = { tokenId:string; creator:Address; mintedAt:number; kind:number; title:string; note:string; mediaURI:string; mediaType:string; fileHash:Hex; contentHash:Hex; proof:Hex; previousId:string; witnessCount:number }
export type Draft = { id:string; title:string; note:string; kind:CreationKind; mediaURI:string; mediaType:string; updatedAt:number;previousId?:string }
export type StudioConfig = { contract:Address|null; chainId:number; pinning:boolean; walletConnect:boolean; status:'ready'|'setup'|'offline'; message?:string }
export const ZERO_HASH = ('0x'+'00'.repeat(32)) as Hex
export const kinds = ['Media','Note','Signature','File proof'] as const
export const shortAddress = (value:string) => value.slice(0,6)+'…'+value.slice(-4)
export const explorer = (type:'address'|'tx',value:string) => `https://sepolia.basescan.org/${type}/${value}`
