'use client'
import {useEffect,useRef,useState} from 'react'
type Point={x:number;y:number}
export function SignaturePad({onChange}:{onChange:(uri:string)=>void}){
  const canvas=useRef<HTMLCanvasElement>(null),lines=useRef<Point[][]>([]),active=useRef<Point[]|null>(null),[count,setCount]=useState(0)
  function redraw(){const c=canvas.current;if(!c)return;const ctx=c.getContext('2d')!;ctx.clearRect(0,0,c.width,c.height);ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#153d4c';for(const line of lines.current){if(!line.length)continue;ctx.beginPath();ctx.moveTo(line[0].x*c.width,line[0].y*c.height);for(const p of line)ctx.lineTo(p.x*c.width,p.y*c.height);ctx.stroke()}}
  function publish(){setCount(lines.current.length);const c=canvas.current!;onChange(lines.current.length?c.toDataURL('image/png'):'')}
  useEffect(()=>{redraw()},[])
  const point=(e:React.PointerEvent)=>{const r=e.currentTarget.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}}
  return <div className="signature-field"><canvas ref={canvas} width={640} height={200} aria-label="Draw your creative signature here" onPointerDown={e=>{if(e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);active.current=[point(e)];lines.current.push(active.current);redraw()}} onPointerMove={e=>{if(!active.current)return;active.current.push(point(e));redraw()}} onPointerUp={()=>{active.current=null;publish()}} onPointerCancel={()=>{active.current=null;publish()}}/><div className="signature-toolbar"><span>{count?'Your mark, in your own hand.':'Draw a creative mark with your finger or mouse.'}</span><button type="button" className="text-button" onClick={()=>{lines.current.pop();redraw();publish()}} disabled={!count}>Undo</button><button type="button" className="text-button" onClick={()=>{lines.current=[];redraw();publish()}} disabled={!count}>Clear</button></div><p className="micro">Use a creative mark, not the signature you use for banking or official documents. This wall is public.</p></div>
}
