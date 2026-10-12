import * as T from 'three'
import type { StoryScene } from './story'
import { createStoryStage } from './story-stage'
import { instanceStoryMeshes } from './instance-story-meshes'
import type { WorldHost, WorldSurface } from './world-surface'

export type Reaction = 'none' | 'hello' | 'words' | 'writing' | 'sent' | 'promise' | 'love'
export type WorldOptions = { scene: StoryScene; motion: boolean; together: number; reaction: Reaction; cue: number; flowers: boolean }
type Options = WorldOptions
export type ActorProjection = { boy: { x: number; y: number }; girl: { x: number; y: number } }
export type WorldController = { update: (options: Options) => void; dispose: () => void }
export type WorldHooks = { together: (value: number) => void; projection: (value: ActorProjection) => void; touch: (who: 'boy' | 'girl') => void; progress: (value: number) => void; finish: (kind: 'kiss'|'jet') => void }

export async function createWorld(canvas: WorldSurface, hooks: WorldHooks, signal: AbortSignal, host?: WorldHost): Promise<WorldController> {
  const coast = await createStoryStage(canvas, hooks.progress, signal, host?.pixelRatio)
  const { scene, camera } = coast
  const objects = new T.Group(); objects.name = 'our-story'; scene.add(objects)
  const geometries = new Set<T.BufferGeometry>(), materials = new Set<T.Material>(), textures = new Set<T.Texture>()
  const geometry = <G extends T.BufferGeometry>(g: G) => { geometries.add(g); return g }
  const mat = (color: string, roughness = .62, metalness = 0) => { const m = new T.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: .65 }); materials.add(m); return m }
  const sphere = geometry(new T.SphereGeometry(1, 28, 20)), detailSphere = geometry(new T.SphereGeometry(1, 18, 12)), smallSphere = geometry(new T.SphereGeometry(1, 12, 8))
  const cream = mat('#fff6e6', .68), blue = mat('#6a9de0', .53), rose = mat('#9eb8e3', .53), orange = mat('#edac77', .55), black = mat('#1c2637', .28), peach = mat('#f3c6b3'), blush = mat('#f2aaa9')
  orange.emissive.set('#f08b48');orange.emissiveIntensity=.18
  const blushPink = mat('#e9a7bf'), mint = mat('#8dd4c8'), gold = mat('#f4d79a', .45)
  function mesh(g: T.BufferGeometry, m: T.Material, parent: T.Object3D, p = [0, 0, 0], s = [1, 1, 1]) {
    const result = new T.Mesh(g, m); result.position.set(p[0], p[1], p[2]); result.scale.set(s[0], s[1], s[2]); result.castShadow = true; result.receiveShadow = true; parent.add(result); return result
  }
  const ball = (m: T.Material, parent: T.Object3D, p: number[], s: number[], high = true) => mesh(high ? Math.max(...s) <= .14 ? detailSphere : sphere : smallSphere, m, parent, p, s)
  function faceMaterial(color: string) {
    const m = mat(color, .53)
    // Cream face follows the head's curved surface, including the familiar forehead dip.
    m.onBeforeCompile = shader => {
      shader.vertexShader = 'varying vec3 vPenguLocal;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPenguLocal=position;')
      const white = new T.Color('#fff9ed')
      shader.fragmentShader = 'varying vec3 vPenguLocal;\n' + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec2 q=vPenguLocal.xy; float edge=pow(q.x/.88,2.)+pow((q.y+.13)/.94,2.);
        float dip=.23*exp(-pow(q.x/.25,2.));
        float mask=(1.-smoothstep(.94,1.,edge))*smoothstep(.25,.38,vPenguLocal.z)*(1.-smoothstep(.54-dip,.59-dip,q.y));
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(${white.r.toFixed(5)},${white.g.toFixed(5)},${white.b.toFixed(5)}),mask);`)
    }
    m.customProgramCacheKey = () => 'pudgy-face-v1-' + color
    return m
  }
  function heartGeometry() {
    const s = new T.Shape(); s.moveTo(0, .18); s.bezierCurveTo(-.42, .66, -.9, .08, 0, -.62); s.bezierCurveTo(.9, .08, .42, .66, 0, .18)
    return geometry(new T.ExtrudeGeometry(s, { depth: .12, bevelEnabled: true, bevelSegments: 4, steps: 1, bevelSize: .055, bevelThickness: .045, curveSegments: 24 }))
  }
  const heartG = heartGeometry()

  function penguin(isGirl: boolean) {
    const root = new T.Group(), rig = new T.Group(), head = new T.Group(); root.name=isGirl?'girl-pengu':'boy-pengu';root.add(rig); objects.add(root)
    const shell = isGirl ? rose : blue
    // A low, generous pear-shaped torso and oversized round head, rather than a stacked capsule.
    const profile = [[0,.12],[.34,.14],[.56,.23],[.72,.47],[.75,.72],[.71,1.0],[.60,1.28],[.45,1.5],[.25,1.62],[0,1.65]].map(p=>new T.Vector2(p[0],p[1]))
    mesh(geometry(new T.LatheGeometry(profile, 48)), shell, rig, [0, 0, 0], [1, 1, .86])
    ball(cream, rig, [0, .83, .405], [.61, .7, .25])
    ball(peach, rig, [0, .31, .44], [.48, .13, .2])
    head.position.set(0, 1.54, .025); rig.add(head)
    ball(faceMaterial(isGirl ? '#9eb8e3' : '#6a9de0'), head, [0, .09, 0], [.72, .69, .63])
    const eyes: T.Group[] = [], pupils: T.Mesh[] = [], lids: T.Mesh[] = [], brows: T.Mesh[] = []
    for (const side of [-1, 1]) {
      const eye = new T.Group(); eye.position.set(side * .255, .135, .578); head.add(eye); eyes.push(eye)
      ball(black, eye, [0, 0, 0], [.087, .116, .039])
      const pupil = ball(cream, eye, [side * -.022, .035, .035], [.024, .031, .012]); pupils.push(pupil)
      ball(cream, eye, [side * .023, -.034, .031], [.009, .011, .01], false)
      const lid = ball(cream, eye, [0, 0, .028], [.093, .001, .025]); lids.push(lid)
      const brow = mesh(geometry(new T.TorusGeometry(.096, .009, 6, 20, 1.05)), black, head, [side * .25, .294, .559]); brow.rotation.z = side === 1 ? .35 : 1.76; brows.push(brow)
      ball(blush, head, [side * .405, -.045, .492], [.095, .038, .013])
    }
    const beak = new T.Group(); beak.position.set(0, -.018, .646); head.add(beak)
    ball(orange, beak, [0, .015, 0], [.109, .069, .065]); ball(peach, beak, [0, -.041, -.002], [.074, .031, .035])
    const mouth = mesh(geometry(new T.TorusGeometry(.037, .006, 6, 20, Math.PI)), black, beak, [0, -.012, .06]); mouth.rotation.z = Math.PI; mouth.scale.y = .35
    const arms: T.Group[] = [], feet: T.Group[] = []
    for (const side of [-1,1]) {
      const arm = new T.Group(); arm.position.set(side * .63, 1.25, .025); rig.add(arm)
      const flipper = ball(shell, arm, [side * .052, -.31, .025], [.19,.43,.115]); flipper.rotation.z = side * .12; arms.push(arm)
      const foot = new T.Group(); foot.position.set(side * .33,.075,.36); root.add(foot)
      ball(orange,foot,[0,0,.035],[.235,.075,.30]); feet.push(foot)
      for(let toe=0;toe<2;toe++) mesh(geometry(new T.CylinderGeometry(.004,.004,.12,5)), peach,foot,[.04*(toe*2-1),.055,.18]).rotation.x=Math.PI/2
    }
    if(isGirl) {
      const bow = new T.Group(); bow.position.set(.36,.69,.05); bow.rotation.z=-.24;head.add(bow)
      ball(blushPink,bow,[-.14,0,0],[.19,.115,.075]);ball(blushPink,bow,[.14,0,0],[.19,.115,.075]);ball(peach,bow,[0,0,.043],[.064,.075,.063])
      for(const side of [-1,1]) { const lash=mesh(geometry(new T.CylinderGeometry(.007,.007,.068,6)),black,head,[side*.333,.2,.582]);lash.rotation.z=-side*.65 }
    } else for(let i=0;i<3;i++){const tuft=ball(blue,head,[-.08+i*.065,.763+i%2*.015,-.04],[.039,.075,.056]);tuft.rotation.z=-.35+i*.3}
    root.traverse(node=>{node.userData.penguin=isGirl?'girl':'boy'})
    return {root,rig,head,arms,feet,eyes,pupils,lids,brows,beak,footPlants:[null,null] as (T.Vector3|null)[],phase:0,stride:0,last:new T.Vector3(),scale:1}
  }
  const boy = penguin(false)
  // A coordinate placeholder keeps the original flight choreography without creating a second rig.
  const girl = { ...boy, root: new T.Group(), last:new T.Vector3(), scale:1 }
  canvas.dataset.guideCount='1'
  const shadowCanvas=typeof document==='undefined'?new OffscreenCanvas(64,64):document.createElement('canvas');shadowCanvas.width=64;shadowCanvas.height=64
  const shadowContext=shadowCanvas.getContext('2d') as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D,gradient=shadowContext.createRadialGradient(32,32,3,32,32,31)
  gradient.addColorStop(0,'rgba(15,29,30,.32)');gradient.addColorStop(1,'rgba(15,29,30,0)');shadowContext.fillStyle=gradient;shadowContext.fillRect(0,0,64,64)
  const shadowTexture=new T.CanvasTexture(shadowCanvas);textures.add(shadowTexture)
  const shadowMat=new T.MeshBasicMaterial({map:shadowTexture,transparent:true,depthWrite:false,toneMapped:false});materials.add(shadowMat)
  for(const p of [boy]){const contact=mesh(geometry(new T.PlaneGeometry(1.8,1.45)),shadowMat,p.root,[0,.024,0]);contact.rotation.x=-Math.PI/2;contact.castShadow=false;contact.receiveShadow=false}
  const heart = mesh(heartG,blushPink,objects);heart.scale.setScalar(.18)
  const heldLetter = new T.Group(); boy.arms[1].add(heldLetter);heldLetter.position.set(.03,-.37,.17)
  const paper=mat('#fffaf0');mesh(geometry(new T.BoxGeometry(.43,.30,.025)),paper,heldLetter)
  const letterHeart=mesh(heartG,blushPink,heldLetter,[0,0,.035]);letterHeart.scale.setScalar(.06)
  heldLetter.rotation.z=-.13
  const happyHearts:Array<T.Mesh>=[]
  for(let i=0;i<7;i++){const h=mesh(heartG,i%2?blushPink:gold,objects);h.castShadow=false;happyHearts.push(h)}
  const handHeart=mesh(heartG,blushPink,boy.arms[1],[0,-.32,.2]);handHeart.scale.setScalar(.16)

  // Original detailed twin-engine fighter. +Z is the nose, and the engines point aft.
  const jet = new T.Group(); jet.name='fighter-jet';objects.add(jet);jet.visible=false
  const alloy=mat('#8f9fa9',.34,.67), rim=mat('#66727e',.3,.75), exhaust=mat('#303947',.29,.82), canopy=mat('#223c52',.1,.65)
  alloy.emissive.set('#40546a');alloy.emissiveIntensity=.12
  const sections=[[3.1,0.012,.013],[2.7,.115,.085],[2.15,.24,.15],[1.5,.33,.2],[.7,.43,.245],[-.1,.63,.24],[-.8,.72,.23],[-1.65,.66,.225],[-2.4,.57,.2],[-2.8,.51,.17]]
  const jp:number[]=[],ji:number[]=[],ring=24
  for(const [z,w,h] of sections) for(let a=0;a<ring;a++){const angle=a/ring*Math.PI*2;jp.push(Math.cos(angle)*w,Math.sin(angle)*h,z)}
  for(let j=0;j<sections.length-1;j++)for(let a=0;a<ring;a++){const n=j*ring+a,b=j*ring+(a+1)%ring;ji.push(n,n+ring,b,b,n+ring,b+ring)}
  const fuselage=geometry(new T.BufferGeometry());fuselage.setAttribute('position',new T.Float32BufferAttribute(jp,3));fuselage.setIndex(ji);fuselage.computeVertexNormals();mesh(fuselage,alloy,jet)
  function plate(points:number[][],parent:T.Object3D,material:T.Material,thickness=.055){
    const shape=new T.Shape();shape.moveTo(points[0][0],points[0][1]);points.slice(1).forEach(p=>shape.lineTo(p[0],p[1]));shape.closePath()
    const result=mesh(geometry(new T.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:true,bevelSegments:2,bevelSize:.018,bevelThickness:.015,steps:1})),material,parent)
    result.rotation.x=-Math.PI/2;return result
  }
  for(const side of [-1,1]) {
    // Coordinates of plates are x / -z because their plane rotates into the horizontal.
    plate([[side*.31,-1.15],[side*2.23,.48],[side*2.17,1.4],[side*.66,1.9],[side*.58,.5]],jet,alloy)
    const tail=plate([[side*.43,1.78],[side*1.38,2.41],[side*1.22,2.91],[side*.5,2.7]],jet,alloy);tail.position.y=.05
    plate([[side*.25,-2.0],[side*.64,-.30],[side*.72,.44],[side*.39,.8]],jet,rim,.035).position.y=.03
    const finShape=new T.Shape();finShape.moveTo(-2.7,0);finShape.lineTo(-1.39,0);finShape.lineTo(-1.92,1.01);finShape.lineTo(-2.4,1.02);finShape.closePath()
    const finMount=new T.Group();finMount.position.set(side*.46,.15,0);finMount.rotation.z=side*-.21;jet.add(finMount)
    const fin=mesh(geometry(new T.ExtrudeGeometry(finShape,{depth:.06,bevelEnabled:true,bevelThickness:.009,bevelSize:.015,bevelSegments:1,steps:1})),alloy,finMount);fin.rotation.y=-Math.PI/2
    const inlet=mesh(geometry(new T.BoxGeometry(.32,.23,.63)),exhaust,jet,[side*.52,-.09,.05]);inlet.rotation.y=side*-.15
    const engine=mesh(geometry(new T.CylinderGeometry(.205,.17,.46,24,1,true)),exhaust,jet,[side*.29,-.01,-2.88]);engine.rotation.x=Math.PI/2
    const lip=mesh(geometry(new T.TorusGeometry(.194,.023,8,30)),rim,jet,[side*.29,-.01,-3.105])
    const glowMat=new T.MeshBasicMaterial({color:'#ffe0aa',transparent:true,opacity:.88});materials.add(glowMat)
    mesh(geometry(new T.CircleGeometry(.155,24)),glowMat,jet,[side*.29,-.01,-3.112]).rotation.y=Math.PI
    const flame=mesh(geometry(new T.ConeGeometry(.15,.72,18)),glowMat,jet,[side*.29,-.01,-3.45]);flame.rotation.x=-Math.PI/2
    for(let line=0;line<3;line++){const p1=new T.Vector3(side*(.72+line*.34),.043,-.43-line*.28),p2=new T.Vector3(side*(1.64+line*.16),.043,-1.25-line*.07);const lineG=geometry(new T.BufferGeometry().setFromPoints([p1,p2]));const lm=new T.LineBasicMaterial({color:'#586978',transparent:true,opacity:.45});materials.add(lm);jet.add(new T.Line(lineG,lm))}
    lip.castShadow=false
  }
  ball(canopy,jet,[0,.255,1.28],[.265,.225,.68]);const canopyFrame=plate([[-.29,-1.9],[.29,-1.9],[.35,-.63],[-.35,-.63]],jet,rim,.018);canopyFrame.position.y=.13
  const contrailMat=new T.MeshBasicMaterial({color:'#faf8ee',transparent:true,opacity:.48,depthWrite:false});materials.add(contrailMat)
  const contrails:T.Mesh[]=[];for(let i=0;i<32;i++){const puff=ball(contrailMat,objects,[0,0,0],[1,1,1],false);puff.visible=false;puff.castShadow=false;contrails.push(puff)}

  const kiss=new T.Group();kiss.name='flying-kiss';objects.add(kiss);kiss.visible=false
  const kissTexture=typeof document==='undefined'?new T.Texture(await new T.ImageBitmapLoader().setOptions({imageOrientation:'flipY',premultiplyAlpha:'none'}).loadAsync('/images/kiss.webp')):new T.TextureLoader().load('/images/kiss.webp');kissTexture.colorSpace=T.SRGBColorSpace;textures.add(kissTexture)
  if(typeof document==='undefined'){kissTexture.flipY=false;kissTexture.needsUpdate=true}
  const kissMat=new T.MeshBasicMaterial({map:kissTexture,transparent:true,depthWrite:false,side:T.DoubleSide});materials.add(kissMat)
  mesh(geometry(new T.PlaneGeometry(2.5,1.67)),kissMat,kiss)
  const wings:T.Group[]=[]
  for(const side of [-1,1]){const wing=new T.Group();wing.position.set(side*.7,.1,-.07);kiss.add(wing);wings.push(wing);for(let i=0;i<5;i++){const feather=ball(cream,wing,[side*(.15+i*.18),.1+Math.sin(i*.4)*.24,-.04],[.1,.29+i*.03,.055]);feather.rotation.z=-side*(.65+i*.15)}}

  const actorBatches = instanceStoryMeshes(objects)
  canvas.dataset.actorBatches = String(actorBatches.count)
  let options:Options={scene:'arrival',motion:true,together:0,reaction:'none',cue:0,flowers:false}
  let width=1,height=1,mobile=false,frame=0,disposed=false,initialized=false,time=0,start=0,lastNow=performance.now(),lastRender=0,hidden=host?.hidden??document.hidden,dirty=true
  let reactionStart=0,pointerX=.5,pointerY=.5,dragging:'boy'|'girl'|null=null,pressed:'boy'|'girl'|null=null,dragMoved=false,jetSeen=false,flightFinished=false
  const giftPose = 0
  const scratch=new T.Vector3(),ray=new T.Raycaster(),pointer=new T.Vector2(),right=new T.Vector3(),upVector=new T.Vector3(),forward=new T.Vector3()
  const anchors={boy:new T.Vector3(),girl:new T.Vector3(),togetherBoy:new T.Vector3(),togetherGirl:new T.Vector3()}
  function pointOnScreen(x:number,y:number,depth:number){camera.updateMatrixWorld();const fov=Math.tan(T.MathUtils.degToRad(camera.fov/2));right.setFromMatrixColumn(camera.matrixWorld,0);upVector.setFromMatrixColumn(camera.matrixWorld,1);camera.getWorldDirection(forward);return camera.position.clone().addScaledVector(forward,depth).addScaledVector(right,(x-.5)*2*fov*depth*camera.aspect).addScaledVector(upVector,(.5-y)*2*fov*depth)}
  function groundAtScreen(x:number,y:number){
    ray.setFromCamera(new T.Vector2(x*2-1,1-y*2),camera)
    let previous=ray.ray.at(.6,new T.Vector3())
    for(let distance=.75;distance<250;distance+=.15){const p=ray.ray.at(distance,new T.Vector3());if(p.y<=coast.layout.heightAt(p.x,p.z)){let a=previous,b=p;for(let i=0;i<10;i++){const m=a.clone().lerp(b,.5);if(m.y>coast.layout.heightAt(m.x,m.z))a=m;else b=m}b.y=coast.layout.heightAt(b.x,b.z)+.025;return b}previous=p}
    const fallback=pointOnScreen(x,y,7);fallback.y=coast.layout.heightAt(fallback.x,fallback.z)+.025;return fallback
  }
  function setAnchors(initial=false){
    camera.updateMatrixWorld();right.setFromMatrixColumn(camera.matrixWorld,0)
    const footY=mobile?.82:.87, bx=mobile?.72:.76, gx=bx
    anchors.boy.copy(groundAtScreen(bx,footY));anchors.girl.copy(groundAtScreen(gx,footY))
    const centre=anchors.boy.clone().lerp(anchors.girl,.5)
    for(const p of [boy,girl]){const d=centre.distanceTo(camera.position);p.scale=(mobile?.20:.24)*d*2*Math.tan(T.MathUtils.degToRad(camera.fov/2))/2.28;p.root.scale.setScalar(p.scale)}
    const half=boy.scale*.72
    anchors.togetherBoy.copy(anchors.boy);anchors.togetherGirl.copy(anchors.boy)
    anchors.togetherBoy.y=coast.layout.heightAt(anchors.togetherBoy.x,anchors.togetherBoy.z)+.025;anchors.togetherGirl.y=coast.layout.heightAt(anchors.togetherGirl.x,anchors.togetherGirl.z)+.025
    if(initial){boy.root.position.copy(anchors.boy).addScaledVector(right,-boy.scale*(mobile?.5:1.25));girl.root.position.copy(anchors.girl);boy.last.copy(boy.root.position);girl.last.copy(girl.root.position)}
  }
  function resize(){const wasMobile=mobile;width=Math.max(1,canvas.clientWidth);height=Math.max(1,canvas.clientHeight);mobile=width<=760;coast.resize(!options.motion);setAnchors();dirty=true;if(wasMobile!==mobile){const joined=['ready','kiss','complete','jet','signature'].includes(options.scene)?1:options.together;boy.root.position.copy(anchors.boy).lerp(anchors.togetherBoy,joined);girl.root.position.copy(anchors.girl).lerp(anchors.togetherGirl,joined)}wake()}
  resize();setAnchors(true)
  const stopResize=host?host.observeResize(resize):(()=>{const observer=new ResizeObserver(resize);observer.observe(canvas as HTMLCanvasElement);return()=>observer.disconnect()})()
  function coordinates(e:PointerEvent){const r=canvas.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2);ray.setFromCamera(pointer,camera)}
  function down(e:PointerEvent){coordinates(e);const hits=ray.intersectObjects([boy.root,girl.root],true);if(!hits.length)return;pressed=hits[0].object.userData.penguin;dragMoved=false;canvas.setPointerCapture(e.pointerId);}
  function move(e:PointerEvent){pointerX=e.clientX/width;pointerY=e.clientY/height;if(!dragging)return;dragMoved=true;const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;const bx=mobile?.26:.64,gx=mobile?.75:.85;const halfGap=(gx-bx)/2;const value=dragging==='boy'?(x-bx)/halfGap:(gx-x)/halfGap;hooks.together(T.MathUtils.clamp(value,0,1))}
  function release(e:PointerEvent){if(pressed&&!dragMoved)hooks.touch(pressed);pressed=null;dragging=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);canvas.style.cursor=options.scene==='closer'?'grab':'pointer'}
  function wake(){if(initialized&&!disposed&&!hidden&&!frame)frame=requestAnimationFrame(render)}
  const visibility=()=>{hidden=host?.hidden??document.hidden;lastNow=performance.now();if(hidden){cancelAnimationFrame(frame);frame=0}else wake()}
  const stopVisibility=host?host.observeVisibility(visibility):(()=>{document.addEventListener('visibilitychange',visibility);return()=>document.removeEventListener('visibilitychange',visibility)})()
  canvas.addEventListener('pointerdown',down as EventListener);canvas.addEventListener('pointermove',move as EventListener);canvas.addEventListener('pointerup',release as EventListener);canvas.addEventListener('pointercancel',release as EventListener)
  const targetBoy=anchors.boy.clone(),targetGirl=anchors.girl.clone(),delta=new T.Vector3()
  function angleTowards(current:number,target:number,step:number){const diff=T.MathUtils.euclideanModulo(target-current+Math.PI,Math.PI*2)-Math.PI;return current+T.MathUtils.clamp(diff,-step,step)}
  function walk(p:typeof boy,target:T.Vector3,dt:number,t:number,isGirl:boolean,joined:number){
    delta.subVectors(target,p.root.position);delta.y=0
    const length=delta.length(),moving=length>.012*p.scale
    const distance=options.motion?Math.min(length,p.scale*1.02*dt):length
    // Step phase derives from distance travelled. Feet cannot cycle while the root stands still.
    if(moving){const direction=Math.atan2(delta.x,delta.z);p.root.rotation.y=angleTowards(p.root.rotation.y,direction,dt*5.2);if(Math.abs(T.MathUtils.euclideanModulo(direction-p.root.rotation.y+Math.PI,Math.PI*2)-Math.PI)<.65||!options.motion){p.root.position.addScaledVector(delta.normalize(),distance);p.stride+=distance/p.scale;}}
    p.root.position.y=coast.layout.heightAt(p.root.position.x,p.root.position.z)+.025
    const phase=p.stride/0.46*Math.PI,step=moving&&options.motion?Math.sin(phase):0
    p.rig.position.y=moving&&options.motion?Math.abs(step)*.042:options.motion?Math.sin(t*1.8+(isGirl?1:0))*.008:0
    p.rig.rotation.z=step*.09
    p.rig.rotation.x=moving?.025:0
    p.root.updateMatrixWorld(true)
    for(let i=0;i<2;i++){
      const f=p.feet[i],a=phase+i*Math.PI,swing=moving&&options.motion?Math.max(0,Math.sin(a)):0
      f.position.set((i?1:-1)*.33,.075+swing*.13,.36+(moving?-Math.cos(a)*.23:0))
      if(moving&&options.motion&&swing<.015){
        if(!p.footPlants[i]){const plant=p.root.localToWorld(f.position.clone());plant.y=coast.layout.heightAt(plant.x,plant.z)+.025+p.scale*.075;p.footPlants[i]=plant}
        f.position.copy(p.root.worldToLocal(p.footPlants[i]!.clone()))
      }else p.footPlants[i]=null
      f.rotation.x=-swing*.2;f.rotation.z=(i?1:-1)*swing*.06
    }
    const sc=options.scene,react=options.reaction,cueAge=t-reactionStart
    const reaction=options.motion&&cueAge<2.4
    const forwardAngle=Math.atan2(camera.position.x-p.root.position.x,camera.position.z-p.root.position.z)
    let facing=forwardAngle
    if(sc==='sorry'&&!isGirl)facing=Math.atan2(girl.root.position.x-p.root.position.x,girl.root.position.z-p.root.position.z)
    if(joined>.95)facing=forwardAngle+(isGirl?-.16:.16)
    if(!isGirl&&giftPose>0)facing=forwardAngle
    if(sc==='arrival'&&isGirl)facing=forwardAngle+.28
    if(!moving||!options.motion)p.root.rotation.y=options.motion?angleTowards(p.root.rotation.y,facing,dt*2.6):facing
    const bow=!isGirl&&sc==='sorry'?.19:0
    const lookingUp=['kiss','jet'].includes(sc)?-.26:0
    p.head.rotation.x=T.MathUtils.lerp(p.head.rotation.x,bow+lookingUp+(reaction&&['promise','sent'].includes(react)?Math.sin(cueAge*7)*.10:0),1-Math.exp(-dt*6))
    p.head.rotation.z=options.motion?Math.sin(t*.55+(isGirl?1:0))*.015:0
    const glance=options.motion?T.MathUtils.clamp(pointerX-.65,-.12,.12):0
    p.head.rotation.y=T.MathUtils.lerp(p.head.rotation.y,react==='writing'?-.12:glance,1-Math.exp(-dt*4))
    const blink=options.motion&&t%4.7>(isGirl?4.29:4.52)&&t%4.7<(isGirl?4.46:4.69)
    p.eyes.forEach(e=>{e.scale.y=blink?.11:1})
    p.pupils.forEach(pupil=>{pupil.position.x+=(T.MathUtils.clamp((pointerX-.5)*.04,-.02,.02)-pupil.position.x)*.08})
    p.brows.forEach((b,i)=>{b.rotation.z=(i===1?.35:1.76)+(!isGirl&&sc==='sorry'?(i?-.15:.15):0)})
    const hand=isGirl?0:1,outer=1-hand
    let innerArm=(isGirl?-.18:.18),outerArm=(isGirl?.18:-.18)
    if(moving){innerArm+=(isGirl?-1:1)*step*.14;outerArm+=(isGirl?-1:1)*step*.14}
    if(joined>.94){innerArm=isGirl?-1.05:1.05;outerArm=isGirl?.2:-.2}
    if(!isGirl&&sc==='sorry')innerArm=.74
    if(!isGirl&&sc==='listen')outerArm=-.58
    if(reaction&&react==='hello')outerArm=(isGirl?1:-1)*(1.55+Math.sin(cueAge*12)*.18)
    if(reaction&&react==='words'&&!isGirl)outerArm=-1.1
    if(reaction&&['promise','sent','love'].includes(react))innerArm=(isGirl?-1:1)*1.35
    if(!isGirl&&giftPose>0){innerArm=T.MathUtils.lerp(innerArm,-.78,giftPose);outerArm=T.MathUtils.lerp(outerArm,.78,giftPose)}
    p.arms[hand].rotation.z=options.motion?T.MathUtils.lerp(p.arms[hand].rotation.z,innerArm,1-Math.exp(-dt*8)):innerArm;p.arms[outer].rotation.z=options.motion?T.MathUtils.lerp(p.arms[outer].rotation.z,outerArm,1-Math.exp(-dt*8)):outerArm
    p.arms[hand].rotation.x=joined>.94?-.35:sc==='sorry'?-.22:0
    if(!isGirl&&giftPose>0){p.arms[0].rotation.x=-.93*giftPose;p.arms[1].rotation.x=T.MathUtils.lerp(p.arms[1].rotation.x,-.93,giftPose)}else p.arms[outer].rotation.x=0
    if(!options.motion){p.rig.position.y=0;p.rig.rotation.set(0,0,0);p.eyes.forEach(e=>e.scale.y=1)}
  }
  function jetPoint(u:number){const depth=80-Math.pow(Math.sin(Math.PI*T.MathUtils.clamp(u,0,1)),.65)*71;return pointOnScreen(-.6+u*2.2,(mobile?.15:.155)+Math.sin(u*Math.PI)*(mobile?.045:.085),depth)}
  function render(now:number){
    frame=0;if(disposed||hidden)return
    if(!options.motion&&!dirty){lastNow=now;return}dirty=false
    const graphicsReady=coast.canRender()
    if(now-lastRender<coast.frameMs||!graphicsReady){dirty=true;wake();return}
    const realDelta=Math.max(0,(now-lastNow)/1000),dt=Math.min(realDelta,.3);lastNow=now;lastRender=now
    if(options.motion)time+=realDelta
    const sc=options.scene,elapsed=time-start,celebrating=['ready','kiss','complete','jet','signature'].includes(sc),joined=celebrating?1:options.together
    const presenting=false
    canvas.dataset.flowersVisible='false';canvas.dataset.flowerOffer='0'
    targetBoy.copy(anchors.boy).lerp(anchors.togetherBoy,joined);targetGirl.copy(anchors.girl).lerp(anchors.togetherGirl,joined)
    if(sc==='sorry')targetBoy.lerp(anchors.togetherBoy,.3)
    if(sc==='space')targetBoy.addScaledVector(right,-boy.scale*.36)
    walk(boy,targetBoy,dt,time,false,0);girl.root.position.copy(boy.root.position)
    heldLetter.visible=sc==='sorry'||sc==='listen';handHeart.visible=!presenting&&(sc==='promise'||sc==='forgive'||options.reaction==='love'&&time-reactionStart<2)
    heart.visible=joined>.85;heart.position.copy(boy.root.position).lerp(girl.root.position,.5);heart.position.y+=boy.scale*(2.46+Math.sin(time*2)*.05);heart.scale.setScalar(boy.scale*.21);heart.rotation.y=Math.sin(time*.6)*.1
    happyHearts.forEach((h,i)=>{h.visible=celebrating||sc==='closer'&&joined>.95;const centre=boy.root.position.clone().lerp(girl.root.position,.5);h.position.copy(centre).add(new T.Vector3(Math.sin(i*2.4+time*.15)*boy.scale*1.2,boy.scale*(2.2+(i*.39+time*.15)%1.5),Math.cos(i*2.4)*boy.scale*.15));h.scale.setScalar(boy.scale*(.05+i%3*.022));h.rotation.y=Math.sin(time+i)*.2})
    for(const [p,key]of[[boy,'boy'],[girl,'girl']]as const){p.root.updateMatrixWorld();scratch.set(0,2.32,0).applyMatrix4(p.root.matrixWorld).project(camera);const value={x:(scratch.x+1)/2,y:(1-scratch.y)/2};if(key==='boy'){canvas.dataset.boyX=String(value.x);canvas.dataset.boyY=String(value.y)}else{canvas.dataset.girlX=String(value.x);canvas.dataset.girlY=String(value.y)}}
    hooks.projection({boy:{x:Number(canvas.dataset.boyX),y:Number(canvas.dataset.boyY)},girl:{x:Number(canvas.dataset.girlX),y:Number(canvas.dataset.girlY)}})
    canvas.dataset.walking=String(boy.root.position.distanceTo(targetBoy)>boy.scale*.015||girl.root.position.distanceTo(targetGirl)>girl.scale*.015)
    canvas.dataset.step=boy.stride.toFixed(3)
    kiss.visible=sc==='kiss'
    if(kiss.visible){const u=T.MathUtils.clamp(elapsed/3.15,0,1),from=boy.root.position.clone().lerp(girl.root.position,.5);from.y+=boy.scale*1.8;const target=camera.position.clone().addScaledVector(camera.getWorldDirection(scratch),.78);kiss.position.copy(from).lerp(target,Math.pow(u,2.1));kiss.position.y+=Math.sin(u*Math.PI)*boy.scale*1.5;kiss.lookAt(camera.position);kiss.rotateZ(Math.sin(u*Math.PI*3)*.09);kiss.scale.setScalar(.13+Math.pow(u,1.5)*.86);wings.forEach((w,i)=>w.rotation.y=Math.sin(time*15)*.36*(i?-1:1))}
    const rawFlight=(elapsed-.25)/2.2
    // A slow renderer must still show the closest approach, even if it missed that part of the pass.
    let flight=rawFlight
    if(sc==='jet'&&!jetSeen&&rawFlight>.55){flight=.5;jetSeen=true}
    else if(sc==='jet'&&rawFlight>.45&&rawFlight<.55)jetSeen=true
    jet.visible=sc==='jet'&&flight>=0&&flight<=1
    canvas.dataset.jetPhase=flight.toFixed(3)
    if(jet.visible){jet.position.copy(jetPoint(flight));jet.lookAt(jetPoint(flight+.008));jet.rotateZ(-.48+Math.sin(flight*Math.PI)*1.02);jet.scale.setScalar(mobile?.72:.9);canvas.dataset.jetVisible='true'}else canvas.dataset.jetVisible='false'
    contrails.forEach((p,i)=>{const past=flight-i*.022;p.visible=sc==='jet'&&past>0&&past<1.08;if(p.visible){p.position.copy(jetPoint(Math.min(1,past)));p.scale.set(.12+i*.007,.07+i*.004,.12+i*.009)}})
    coast.update(time,dt);actorBatches.update();coast.render()
    if(!flightFinished&&options.motion&&(sc==='kiss'&&elapsed>=3.35||sc==='jet'&&elapsed>=3.0&&jetSeen)){flightFinished=true;hooks.finish(sc as 'kiss'|'jet')}
    if(options.motion||dirty)wake()
  }
  coast.update(0,.016);actorBatches.update();coast.render()
  const controller: WorldController = {
    update(next){if(options.scene!==next.scene){start=time;jetSeen=false;flightFinished=false}if(options.cue!==next.cue)reactionStart=time;const changedMotion=options.motion!==next.motion;options=next;dirty=true;coast.invalidate();if(changedMotion){lastNow=performance.now();coast.resize(!next.motion)}canvas.style.cursor=next.scene==='closer'?'grab':'pointer';if(!next.motion){boy.root.position.copy(targetBoy);girl.root.position.copy(targetGirl)}wake()},
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);stopResize();stopVisibility();canvas.removeEventListener('pointerdown',down as EventListener);canvas.removeEventListener('pointermove',move as EventListener);canvas.removeEventListener('pointerup',release as EventListener);canvas.removeEventListener('pointercancel',release as EventListener);actorBatches.dispose();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>{if(typeof ImageBitmap!=='undefined'&&t.image instanceof ImageBitmap)t.image.close();t.dispose()});objects.removeFromParent();coast.dispose()},
  }
  await new Promise<void>(resolve=>{
    const done=()=>{cancelAnimationFrame(frame);frame=0;signal.removeEventListener('abort',done);resolve()}
    const ready=()=>{frame=0;if(signal.aborted||coast.canRender())done();else frame=requestAnimationFrame(ready)}
    signal.addEventListener('abort',done,{once:true});ready()
  })
  if(signal.aborted){controller.dispose();throw new DOMException('Cancelled','AbortError')}
  initialized=true;lastNow=performance.now();hooks.progress(1);wake();return controller

}
