import {test} from 'node:test'
import assert from 'node:assert/strict'
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts'
import {encryptWallet,unlockWallet,validateVault,createVault} from '../lib/mint/wallet-vault'
import {safeMediaURI,validateInput} from '../lib/mint/proof'
import {ZERO_HASH} from '../lib/mint/types'

test('wallet backups encrypt keys with unique salts and can only unlock with the correct password',async()=>{
  const key=generatePrivateKey(),password='student practice password'
  const a=await encryptWallet(key,password),b=await encryptWallet(key,password)
  assert.notEqual(a.cipher,b.cipher);assert.notEqual(a.salt,b.salt);assert.notEqual(a.iv,b.iv)
  assert.equal(a.address,privateKeyToAccount(key).address);assert.equal(await unlockWallet(JSON.parse(JSON.stringify(a)),password),key)
  assert.ok(!JSON.stringify(a).includes(key));assert.ok(!JSON.stringify(a).includes(password))
  await assert.rejects(unlockWallet(a,'wrong password'),/could not unlock/)
  const modified={...a,cipher:Buffer.from(Buffer.from(a.cipher,'base64').map((v,i)=>i===0?v^1:v)).toString('base64')}
  await assert.rejects(unlockWallet(modified,password),/could not unlock/)
  await assert.rejects(unlockWallet({...a,address:'0x'+'ab'.repeat(20)},password),/could not unlock/)
  assert.throws(()=>validateVault({...a,iterations:1}),/not a PenguMint/)
  await assert.rejects(createVault('short'),/at least 10/)
})
test('public media rendering only permits passive raster data and strict IPFS addresses',()=>{
  assert.equal(safeMediaURI('javascript:alert(1)'),null);assert.equal(safeMediaURI('data:image/svg+xml;base64,PHN2Zz4='),null)
  assert.equal(safeMediaURI('https://attacker.invalid/a.html'),null)
  assert.equal(safeMediaURI('ipfs://bafy'+'a'.repeat(40)),'https://ipfs.io/ipfs/bafy'+'a'.repeat(40))
  assert.equal(safeMediaURI('data:image/png;base64,aGVsbG8='),'data:image/png;base64,aGVsbG8=')
})
test('draft validation respects UTF-8 limits and does not pretend a blank file proof is publishable',()=>{
  const input={title:'First',note:'Text',mediaURI:'',mediaType:'text/plain',fileHash:ZERO_HASH,kind:1,previousId:0n}
  assert.doesNotThrow(()=>validateInput(input))
  assert.throws(()=>validateInput({...input,title:'🐧'.repeat(25)}),/96 UTF-8/)
  assert.throws(()=>validateInput({...input,kind:3}),/Choose a local file/)
  assert.throws(()=>validateInput({...input,note:''}),/Write a note/)
})
