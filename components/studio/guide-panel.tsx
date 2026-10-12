'use client'
import {useState} from 'react'
import {ArrowRight,MessageCircle,X} from 'lucide-react'
import type {StudioWallet} from '@/lib/mint/use-wallet'
export function GuidePanel({open,onClose,hint,wallet,onWallet,onCreate,onLearn}:{open:boolean;onClose:()=>void;hint:string;wallet:StudioWallet;onWallet:()=>void;onCreate:()=>void;onLearn:()=>void}){
  const [question,setQuestion]=useState('')
  const answers:Record<string,string>={
    'What should I do next?':!wallet.address?'Start with Your wallet. Create one here with a password, or connect an existing EVM wallet. Then get free Base Sepolia test ETH.':wallet.locked?'Unlock your in-site wallet with its password. Your key is encrypted in this browser.':Number(wallet.balance)<=0?'Your wallet needs free Base Sepolia test ETH for gas. Open Your wallet, copy its address, and choose a faucet.':'You’re ready to create. Try a note first: write something, sign your free creator proof, review the gas quote, then confirm the public mint.',
    'Why a file proof?':'A file proof records a document’s SHA-256 checksum and timestamp. The original stays on your device. Later, pick the same file to check an exact match. It proves a wallet committed that checksum at that time, not a university grade or legal copyright.',
    'Why use versions?':'Link your previous mint when a project changes. Each version gets its own permanent record. The contract only accepts links to earlier work created by the same wallet.',
    'What is a witness?':'A different wallet can acknowledge seeing a creation. The acknowledgement is recorded onchain, once per wallet. It is a peer receipt, not an instructor certification.',
    'Where is my media?':'Small images, notes and drawn marks can live fully onchain. Larger media lives on IPFS with a content address and checksum stored onchain. The public wall explains the storage of every creation.',
  }
  if(!open)return null
  return <aside className="guide-panel" aria-label="Pip the penguin guide"><div className="guide-heading"><span><MessageCircle size={15}/> Pip · your guide</span><button className="icon-button" aria-label="Close guide" onClick={onClose}><X size={15}/></button></div><p className="guide-answer" role="status">{question?answers[question]:hint}</p><div className="guide-questions">{Object.keys(answers).map(q=><button key={q} className={question===q?'active':''} onClick={()=>setQuestion(q)}>{q}</button>)}</div><div className="button-row"><button className="text-button" onClick={onWallet}>Your wallet <ArrowRight size={12}/></button><button className="text-button" onClick={onCreate}>Create <ArrowRight size={12}/></button><button className="text-button" onClick={onLearn}>Learning passport</button></div><p className="micro">Context-aware guidance from the app’s real state. No AI subscription or chat data collection.</p></aside>
}
