import type {Hex} from 'viem'
export async function sha256(bytes:Uint8Array):Promise<Hex>{const digest=await crypto.subtle.digest('SHA-256',bytes as BufferSource);return ('0x'+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')) as Hex}
export function dataURIBytes(uri:string){const payload=uri.split(',')[1];if(!payload)throw new Error('Invalid image');return Uint8Array.from(atob(payload),x=>x.charCodeAt(0))}
export async function inlineImage(file:Blob){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Direct onchain mode supports JPG, PNG and WebP. Use IPFS for other media.')
  if(file.size>12_000_000)throw new Error('Choose an image below 12 MB.')
  const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas')
  try{
    for(const edge of [512,384,256,192,128]){
      const scale=Math.min(1,edge/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale))
      const ctx=canvas.getContext('2d')!;ctx.drawImage(bitmap,0,0,canvas.width,canvas.height)
      for(const quality of [.86,.7,.52]){const uri=canvas.toDataURL('image/webp',quality);if(uri.length<=14500)return {uri,type:'image/webp',hash:await sha256(dataURIBytes(uri))}}
    }
    throw new Error('This image needs full-size IPFS storage. Choose IPFS to preserve it.')
  }finally{bitmap.close();canvas.width=canvas.height=0}
}
