'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {createPublicClient,createWalletClient,http,custom,formatEther,type Address,type Hex,type EIP1193Provider,type Abi,isAddress,parseEther} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {baseSepolia} from './chain'
import {createVault,unlockWallet,validateVault,type WalletVault} from './wallet-vault'
import artifact from './contract.json'
import type {MintInput} from './types'
type Provider=EIP1193Provider & {on?:(name:string,callback:(value:unknown)=>void)=>void;removeListener?:(name:string,callback:(value:unknown)=>void)=>void;disconnect?:()=>Promise<void>}
export type DiscoveredWallet={info:{uuid:string;name:string;icon:string};provider:Provider}
const storageKey='pengumint.wallet.v1'
export const publicClient=()=>createPublicClient({chain:baseSepolia,transport:http('/api/rpc',{timeout:20_000,retryCount:1})})
export function friendlyError(error:unknown){
  const e=error as {shortMessage?:string;message?:string;code?:number}
  if(e.code===4001||/rejected|denied/i.test(e.message||''))return 'You cancelled in your wallet. Your draft is still here.'
  if(/insufficient funds|exceeds the balance/i.test(e.message||''))return 'Your wallet needs Base Sepolia test ETH. Open the faucet, then retry.'
  if(/already minted/i.test(e.message||''))return 'This creation was already minted by your wallet. Check the public wall.'
  return (e.shortMessage||e.message||'Something interrupted this step. Please retry.').slice(0,260)
}
export function useWallet(){
  const [address,setAddress]=useState<Address|null>(null),[mode,setMode]=useState<'local'|'external'|null>(null),[locked,setLocked]=useState(false),[hasVault,setHasVault]=useState(false),[chainId,setChainId]=useState<number|null>(null),[balance,setBalance]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[providers,setProviders]=useState<DiscoveredWallet[]>([]),[providerEpoch,setProviderEpoch]=useState(0)
  const privateKey=useRef<Hex|null>(null),provider=useRef<Provider|null>(null),addressRef=useRef<Address|null>(null),vault=useRef<WalletVault|null>(null),activity=useRef(Date.now())
  const assignAddress=useCallback((next:Address|null)=>{addressRef.current=next;setAddress(next);setBalance(null)},[])
  const lock=useCallback(()=>{privateKey.current=null;setLocked(true)},[])
  const refreshBalance=useCallback(async()=>{if(!addressRef.current)return;try{setBalance(formatEther(await publicClient().getBalance({address:addressRef.current})))}catch{setBalance(null)}},[])
  useEffect(()=>{
    try{const raw=localStorage.getItem(storageKey);if(raw){vault.current=validateVault(JSON.parse(raw));setHasVault(true);assignAddress(vault.current.address as Address);setMode('local');setLocked(true);setChainId(84532)}}catch{setError('The saved wallet could not be read. Import your encrypted backup to restore it.')}
    const announce=(event:Event)=>{const detail=(event as CustomEvent<DiscoveredWallet>).detail;if(!detail?.provider?.request||!detail.info?.uuid)return;setProviders(p=>p.some(x=>x.info.uuid===detail.info.uuid)?p:[...p,detail])}
    window.addEventListener('eip6963:announceProvider',announce);window.dispatchEvent(new Event('eip6963:requestProvider'))
    const injected=(window as Window & {ethereum?:Provider}).ethereum
    if(injected)setProviders(p=>p.length?p:[{info:{uuid:'legacy',name:'Browser wallet',icon:''},provider:injected}])
    const touched=()=>{activity.current=Date.now()};window.addEventListener('pointerdown',touched,{passive:true});window.addEventListener('keydown',touched)
    let hiddenAt=0;const visibility=()=>{if(document.hidden)hiddenAt=Date.now();else if(hiddenAt&&Date.now()-hiddenAt>60_000&&privateKey.current)lock()}
    document.addEventListener('visibilitychange',visibility)
    const idle=setInterval(()=>{if(privateKey.current&&Date.now()-activity.current>600_000)lock()},30_000)
    return()=>{privateKey.current=null;clearInterval(idle);window.removeEventListener('eip6963:announceProvider',announce);window.removeEventListener('pointerdown',touched);window.removeEventListener('keydown',touched);document.removeEventListener('visibilitychange',visibility)}
  },[assignAddress,lock])
  useEffect(()=>{if(!address)return;void refreshBalance();const timer=setInterval(()=>{if(!document.hidden)void refreshBalance()},15_000);return()=>clearInterval(timer)},[address,refreshBalance])
  useEffect(()=>{
    const p=provider.current;if(mode!=='external'||!p)return
    const accounts=(value:unknown)=>{const list=value as string[];assignAddress(list[0]&&isAddress(list[0])?list[0] as Address:null)}
    const chain=(value:unknown)=>{setChainId(Number(value));setBalance(null)}
    const disconnected=()=>{assignAddress(null);setMode(null);provider.current=null}
    p.on?.('accountsChanged',accounts);p.on?.('chainChanged',chain);p.on?.('disconnect',disconnected)
    return()=>{p.removeListener?.('accountsChanged',accounts);p.removeListener?.('chainChanged',chain);p.removeListener?.('disconnect',disconnected)}
  },[mode,address,assignAddress,providerEpoch])
  async function attempt<T>(action:()=>Promise<T>){setBusy(true);setError('');try{return await action()}catch(e){const message=friendlyError(e);setError(message);throw new Error(message)}finally{setBusy(false)}}
  async function connect(p:Provider){return attempt(async()=>{const accounts=await p.request({method:'eth_requestAccounts'}) as Address[];if(!accounts[0])throw new Error('No wallet account was selected.');privateKey.current=null;provider.current=p;setProviderEpoch(v=>v+1);assignAddress(accounts[0]);setMode('external');setLocked(false);setChainId(Number(await p.request({method:'eth_chainId'})));return accounts[0]})}
  async function connectQR(){
    const projectId=process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
    if(!projectId)throw new Error('The instructor must add a WalletConnect project ID to enable QR connections. Browser and in-site wallets work without it.')
    return attempt(async()=>{const {EthereumProvider}=await import('@walletconnect/ethereum-provider');const p=await EthereumProvider.init({projectId,chains:[84532],showQrModal:true,rpcMap:{84532:window.location.origin+'/api/rpc'},metadata:{name:'PenguMint',description:'A student onchain creation studio',url:window.location.origin,icons:[window.location.origin+'/icon.svg']}});await p.connect();return connect(p as unknown as Provider)})
  }
  async function create(password:string){return attempt(async()=>{if(vault.current)throw new Error('A wallet already exists here. Unlock it or import an encrypted backup.');const next=await createVault(password);localStorage.setItem(storageKey,JSON.stringify(next.vault));vault.current=next.vault;privateKey.current=next.privateKey;provider.current=null;assignAddress(next.vault.address as Address);setMode('local');setHasVault(true);setLocked(false);setChainId(84532);activity.current=Date.now()})}
  async function unlock(password:string){return attempt(async()=>{if(!vault.current)throw new Error('No saved wallet found.');const key=await unlockWallet(vault.current,password);privateKey.current=key;provider.current=null;assignAddress(vault.current.address as Address);setMode('local');setLocked(false);setChainId(84532);activity.current=Date.now()})}
  async function importBackup(file:File,password:string){return attempt(async()=>{if(file.size>5000)throw new Error('Choose your small encrypted wallet JSON file.');const next=validateVault(JSON.parse(await file.text())),key=await unlockWallet(next,password);localStorage.setItem(storageKey,JSON.stringify(next));vault.current=next;privateKey.current=key;provider.current=null;assignAddress(next.address as Address);setHasVault(true);setLocked(false);setMode('local');setChainId(84532)})}
  function exportBackup(){if(!vault.current)throw new Error('Create or import a wallet first.');const blob=new Blob([JSON.stringify(vault.current,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='pengumint-'+vault.current.address.slice(2,10)+'.wallet.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  async function disconnect(){privateKey.current=null;const p=provider.current;provider.current=null;await p?.disconnect?.().catch(()=>{});assignAddress(null);setMode(null);setLocked(false);setChainId(null)}
  async function ensureNetwork(){
    if(!addressRef.current)throw new Error('Create or connect a wallet first.')
    if(privateKey.current)return
    if(mode==='local')throw new Error('Unlock your in-site wallet first.')
    const p=provider.current;if(!p)throw new Error('Reconnect your wallet.')
    if(Number(await p.request({method:'eth_chainId'}))!==84532){try{await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x14a34'}]})}catch(e){if((e as {code:number}).code!==4902)throw e;await p.request({method:'wallet_addEthereumChain',params:[{chainId:'0x14a34',chainName:'Base Sepolia',nativeCurrency:{name:'Sepolia ETH',symbol:'ETH',decimals:18},rpcUrls:['https://sepolia.base.org'],blockExplorerUrls:['https://sepolia.basescan.org']}]});await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x14a34'}]})}}
    setChainId(Number(await p.request({method:'eth_chainId'})))
    const accounts=await p.request({method:'eth_accounts'}) as Address[]
    if(accounts[0]?.toLowerCase()!==addressRef.current.toLowerCase())throw new Error('Your wallet account changed. Connect it again before continuing.')
  }
  function client(){if(privateKey.current)return createWalletClient({account:privateKeyToAccount(privateKey.current),chain:baseSepolia,transport:http('/api/rpc')});if(!provider.current||!addressRef.current)throw new Error('Unlock or connect your wallet.');return createWalletClient({account:addressRef.current,chain:baseSepolia,transport:custom(provider.current)})}
  async function signMessage(message:string){await ensureNetwork();return client().signMessage({message})}
  async function mint(contract:Address,input:MintInput,proof:Hex,gas:bigint){await ensureNetwork();return client().writeContract({address:contract,abi:artifact.abi as Abi,functionName:'mint',args:[input,proof],gas})}
  async function witness(contract:Address,id:string,gas:bigint){await ensureNetwork();return client().writeContract({address:contract,abi:artifact.abi as Abi,functionName:'witness',args:[BigInt(id)],gas})}
  async function deploy(){await ensureNetwork();return client().deployContract({abi:artifact.abi as Abi,bytecode:artifact.bytecode as Hex})}
  async function send(to:Address,amount:string){await ensureNetwork();if(!isAddress(to)||parseEther(amount)<=0n)throw new Error('Enter a valid recipient and positive amount.');return client().sendTransaction({to,value:parseEther(amount)})}
  return {address,mode,locked,hasVault,chainId,balance,busy,error,providers,create,unlock,connect,connectQR,importBackup,exportBackup,disconnect,lock,signMessage,mint,witness,deploy,send,refreshBalance,ensureNetwork,clearError:()=>setError('')}
}
export type StudioWallet=ReturnType<typeof useWallet>
