'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import type {Address} from 'viem'
import type {Creation} from './types'
export function useGallery(contract:Address|null){
  const [items,setItems]=useState<Creation[]>([]),[latestId,setLatestId]=useState('0'),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[live,setLive]=useState(false)
  const head=useRef('0'),generation=useRef(0),pending=useRef(false)
  const load=useCallback(async(page='0',signal?:AbortSignal)=>{
    if(!contract)return
    const current=generation.current;setLoading(true)
    try{const r=await fetch(`/api/gallery?contract=${contract}&cursor=${page}`,{signal,cache:'no-store'}),data=await r.json();if(!r.ok)throw new Error(data.error||'The wall is temporarily unavailable.');if(current!==generation.current)return;setItems(previous=>{const all=new Map(previous.map(x=>[x.tokenId,x]));for(const x of data.items)all.set(x.tokenId,x);return [...all.values()].sort((a,b)=>BigInt(a.tokenId)>BigInt(b.tokenId)?-1:1)});head.current=data.activity;setLatestId(data.latestId);setCursor(previous=>page!=='0'||previous===null?data.nextCursor:BigInt(previous)<BigInt(data.nextCursor??previous)?previous:data.nextCursor);setError('');setLive(true)}catch(e){if(!signal?.aborted&&current===generation.current){setError(e instanceof Error?e.message:'Could not read the wall.');setLive(false)}}finally{if(current===generation.current)setLoading(false)}
  },[contract])
  useEffect(()=>{generation.current++;pending.current=false;head.current='0';setItems([]);setCursor(null);setLatestId('0');setError('');setLive(false);if(!contract)return;const abort=new AbortController();void load('0',abort.signal)
    const poll=async()=>{if(document.hidden||pending.current)return;pending.current=true;try{const r=await fetch(`/api/gallery?contract=${contract}&head=1`,{signal:abort.signal,cache:'no-store'}),data=await r.json();if(!r.ok)throw new Error(data.error||'The wall is temporarily unavailable.');if(data.activity!==head.current)await load('0',abort.signal);else{setLive(true);setError('')}}catch(e){if(!abort.signal.aborted){setLive(false);setError(e instanceof Error?e.message:'Could not refresh the wall.')}}finally{pending.current=false}}
    const timer=setInterval(()=>void poll(),4000);const visible=()=>{if(!document.hidden)void poll()};document.addEventListener('visibilitychange',visible);return()=>{abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible)}
  },[contract,load])
  return {items,latestId,loading,error,live,hasMore:!!cursor,refresh:()=>load(),loadMore:()=>cursor?load(cursor):Promise.resolve()}
}
