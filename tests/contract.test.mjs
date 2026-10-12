import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {createPublicClient,createWalletClient,http,keccak256,encodeFunctionData} from 'viem'
import {mnemonicToAccount} from 'viem/accounts'
import {baseSepolia} from '../lib/mint/chain.ts'
import {contentHash,proofMessage} from '../lib/mint/proof.ts'
import solc from 'solc'
const artifact=JSON.parse(readFileSync(new URL('../lib/mint/contract.json',import.meta.url)))
const zero='0x'+'00'.repeat(32),mnemonic='test test test test test test test test test test test junk'
const a=mnemonicToAccount(mnemonic),b=mnemonicToAccount(mnemonic,{addressIndex:1})
const url='http://127.0.0.1:18546'
const c=createPublicClient({chain:baseSepolia,transport:http(url,{retryCount:0})})
const w=account=>createWalletClient({chain:baseSepolia,account,transport:http(url)})
const input=(patch={})=>({title:'A student\'s "first" idea 🐧',note:'One useful idea.\nA permanent record.',mediaURI:'',mediaType:'text/plain',fileHash:zero,kind:1,previousId:0n,...patch})
const receipt=async hash=>{const r=await c.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r}

test('real EVM: creator proofs, public records, versions, passports and witnesses',async t=>{
  const evm=spawn(new URL('../node_modules/.bin/anvil',import.meta.url).pathname,['--port','18546','--chain-id','84532','--hardfork','cancun','--silent'],{stdio:'ignore'})
  try{
    let ready=false;for(let i=0;i<120;i++){try{await c.getChainId();ready=true;break}catch{await new Promise(r=>setTimeout(r,100))}}assert.ok(ready,'Anvil started')
    const deployed=await receipt(await w(a).deployContract({abi:artifact.abi,bytecode:artifact.bytecode})),address=deployed.contractAddress
    assert.equal(await c.getChainId(),84532)
    assert.equal(keccak256(await c.getBytecode({address})),keccak256(artifact.deployedBytecode))
    const read=(functionName,args=[])=>c.readContract({address,abi:artifact.abi,functionName,args})
    const sign=(who,i,creator=who.address)=>who.signMessage({message:proofMessage(address,creator,i)})
    const mint=async(who,i)=>{const proof=await sign(who,i);await receipt(await w(who).writeContract({address,abi:artifact.abi,functionName:'mint',args:[i,proof]}));return read('latestId')}
    const refuse=async(who,i,proof,pattern)=>assert.rejects(c.simulateContract({account:who.address,address,abi:artifact.abi,functionName:'mint',args:[i,proof]}),pattern)
    const first=input()
    await t.test('Solidity and browser agree on unambiguous content and proof encoding',async()=>{
      assert.equal(await read('contentHashOf',[first]),contentHash(first))
      assert.equal(await read('proofMessage',[a.address,contentHash(first),first.title,first.kind]),proofMessage(address,a.address,first))
      assert.notEqual(contentHash(input({note:'a\nb',mediaURI:'c'})),contentHash(input({note:'a',mediaURI:'b\nc'})))
    })
    await t.test('notes are immutable public ERC-721 records with valid escaped metadata',async()=>{
      assert.equal(await mint(a,first),1n)
      const record=await read('getCreation',[1n]);assert.equal(record.creator,a.address);assert.equal(record.contentHash,contentHash(first));assert.equal(await read('ownerOf',[1n]),a.address)
      assert.ok(await c.verifyMessage({address:a.address,message:proofMessage(address,a.address,first),signature:record.proof}))
      const metadata=JSON.parse(Buffer.from((await read('tokenURI',[1n])).split(',')[1],'base64').toString())
      assert.equal(metadata.name,first.title);assert.equal(metadata.description,first.note)
      assert.equal(await read('supportsInterface',['0x80ac58cd']),true)
    })
    await t.test('forged signatures, changed content and duplicate mints are refused',async()=>{
      const changed=input({note:'Changed by another person'}),forged=await sign(b,changed,a.address)
      await refuse(a,changed,forged,/Creator proof is invalid/)
      await refuse(a,input({title:'Tampered title',note:'new'}),await sign(a,input({note:'new'})),/Creator proof is invalid/)
      await refuse(a,first,await sign(a,first),/already minted/)
      await refuse(a,input({title:'x'.repeat(97)}),await sign(a,input({title:'x'.repeat(97)})),/Title must/)
    })
    await t.test('media, signatures and checksum-only proofs have real passport counters',async()=>{
      const media=input({title:'Pixel art',note:'Blue dot',kind:0,mediaURI:'data:image/png;base64,iVBORw0KGgo=',mediaType:'image/png',fileHash:'0x'+'12'.repeat(32)})
      await mint(a,media);await mint(a,{...media,title:'Creative signature',note:'My mark',kind:2})
      await mint(a,input({title:'Assignment proof',note:'Private PDF remains local',kind:3,mediaType:'application/octet-stream',fileHash:'0x'+'34'.repeat(32)}))
      const p=await read('passports',[a.address]);assert.deepEqual(p.slice(0,5),[1,1,1,1,0]);assert.ok(p[5]>0n)
      assert.equal((await read('getCreation',[4n])).mediaURI,'')
    })
    await t.test('version links accept own work and reject another creator',async()=>{
      const revision=input({title:'My second draft',note:'Improved note',previousId:1n})
      await mint(a,revision);assert.equal((await read('getCreation',[5n])).previousId,1n)
      const foreign=input({note:'Not my earlier work',previousId:1n});await refuse(b,foreign,await sign(b,foreign),/Only link your own/)
      assert.equal((await read('getCreation',[1n])).note,first.note)
    })
    await t.test('peer witnesses are public, counted once and cannot witness themselves',async()=>{
      await assert.rejects(c.simulateContract({account:a.address,address,abi:artifact.abi,functionName:'witness',args:[1n]}),/Ask another wallet/)
      const before=await read('activityNonce');await receipt(await w(b).writeContract({address,abi:artifact.abi,functionName:'witness',args:[1n]}))
      assert.equal(await read('activityNonce'),before+1n);assert.equal((await read('getCreation',[1n])).witnessCount,1)
      assert.equal((await read('passports',[b.address]))[4],1)
      await assert.rejects(c.simulateContract({account:b.address,address,abi:artifact.abi,functionName:'witness',args:[1n]}),/already witnessed/)
      await assert.rejects(read('getCreation',[999n]),/does not exist/)
    })
    await t.test('pagination reads newest first and bounds response size',async()=>{
      assert.deepEqual((await read('getPage',[0n,3n])).map(x=>x.tokenId),[5n,4n,3n])
      assert.deepEqual((await read('getPage',[2n,3n])).map(x=>x.tokenId),[2n,1n])
      await assert.rejects(read('getPage',[0n,13n]),/Page size/)
    })
    await t.test('ERC-1271 smart wallets can sign and mint without impersonating an EOA',async()=>{
      const src=`pragma solidity ^0.8.24; contract StudentWallet { address immutable owner; constructor(address a){owner=a;} function isValidSignature(bytes32 h,bytes calldata s) external view returns(bytes4){bytes32 r;bytes32 z;uint8 v;assembly { r:=calldataload(s.offset) z:=calldataload(add(s.offset,32)) v:=byte(0,calldataload(add(s.offset,64))) } return ecrecover(h,v,r,z)==owner?bytes4(0x1626ba7e):bytes4(0xffffffff);} function execute(address target,bytes calldata data) external {require(msg.sender==owner);(bool ok,)=target.call(data);require(ok);} function onERC721Received(address,address,uint256,bytes calldata) external pure returns(bytes4){return 0x150b7a02;} }`
      const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Wallet.sol':{content:src}},settings:{evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}))).contracts['Wallet.sol'].StudentWallet
      const smart=(await receipt(await w(a).deployContract({abi:compiled.abi,bytecode:'0x'+compiled.evm.bytecode.object,args:[a.address]}))).contractAddress
      const work=input({title:'Smart-wallet project',note:'ERC1271 support'}),proof=await sign(a,work,smart),data=encodeFunctionData({abi:artifact.abi,functionName:'mint',args:[work,proof]})
      await receipt(await w(a).writeContract({address:smart,abi:compiled.abi,functionName:'execute',args:[address,data]}))
      assert.equal((await read('getCreation',[6n])).creator.toLowerCase(),smart.toLowerCase())
      assert.ok(await c.verifyMessage({address:smart,message:proofMessage(address,smart,work),signature:proof}))
    })
  }finally{evm.kill('SIGTERM')}
})
