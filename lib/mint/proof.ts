import { keccak256, encodeAbiParameters, type Address, type Hex } from 'viem'
import type { MintInput } from './types'
export function contentHash(input:MintInput):Hex{return keccak256(encodeAbiParameters([{type:'string'},{type:'string'},{type:'string'},{type:'bytes32'},{type:'uint256'}],[input.note,input.mediaURI,input.mediaType,input.fileHash,input.previousId]))}
export function proofMessage(contract:Address,creator:Address,input:MintInput){return `PenguMint creation\nChain: 84532\nContract: ${contract.toLowerCase()}\nCreator: ${creator.toLowerCase()}\nContent: ${contentHash(input)}\nTitle: ${input.title}\nKind: ${input.kind}`}
export function validateInput(input:MintInput){
  const size=(s:string)=>new TextEncoder().encode(s).length
  if(!input.title.trim()||size(input.title)>96)throw new Error('Add a title of at most 96 UTF-8 bytes.')
  if(size(input.note)>4096)throw new Error('Keep your note under 4096 UTF-8 bytes.')
  if(size(input.mediaURI)>16384)throw new Error('This image is too large for direct onchain storage. Choose IPFS instead.')
  if(input.kind===1&&!input.note.trim())throw new Error('Write a note first.')
  if(input.kind!==1&&input.kind!==3&&!input.mediaURI)throw new Error('Add media or draw your signature first.')
  if(input.kind===3&&input.fileHash==='0x'+'00'.repeat(32))throw new Error('Choose a local file to create its proof.')
}
export function safeMediaURI(uri:string):string|null{
  if(/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(uri))return uri
  if(/^ipfs:\/\/(bafy[a-z2-7]{20,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})(\/[a-zA-Z0-9._-]+)*$/.test(uri))return 'https://ipfs.io/ipfs/'+uri.slice(7)
  return null
}
