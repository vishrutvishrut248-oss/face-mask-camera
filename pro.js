'use strict';
let hardwareState={},hardwareQueue=Promise.resolve();
function setupGrade(){
 try{
  if(!grade){grade=new CameraGrade(video,$('graded'));grade.onError=message=>{if(active())stopRecording();notice(message)};buildGradeControls();buildLooks()}
  grade.resize();$('graded').hidden=false;$('app').classList.add('processed');$('graded').classList.toggle('mirror',video.classList.contains('mirror'));$('looks').hidden=false;
 }catch(e){$('graded').hidden=true;$('app').classList.remove('processed');$('looks').hidden=true;notice('Effects unavailable. Original camera recording only.');console.warn(e);grade=null}
}
function buildLooks(){
 $('looks').replaceChildren();grade.looks.forEach(([name],i)=>{const b=document.createElement('button');b.textContent=name;b.dataset.look=i;b.setAttribute('aria-pressed',String(i===grade.look));b.onclick=()=>selectLook(i);$('looks').appendChild(b)});
}
function selectLook(index){if(!grade)return;grade.look=(index+grade.looks.length)%grade.looks.length;for(const b of $('looks').children)b.setAttribute('aria-pressed',String(+b.dataset.look===grade.look));$('looks').children[grade.look].scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'})}
function slider(parent,id,label,min,max,step,value,onchange,format=v=>Number(v).toFixed(2)){
 const wrap=document.createElement('div'),lab=document.createElement('label'),out=document.createElement('output'),input=document.createElement('input');input.type='range';input.id=id;input.min=min;input.max=max;input.step=step;input.value=value;out.value=format(value);out.htmlFor=id;lab.htmlFor=id;lab.textContent=label;lab.appendChild(out);input.oninput=()=>{out.value=format(+input.value);onchange(+input.value,out)};wrap.append(lab,input);parent.appendChild(wrap);return input;
}
function buildGradeControls(){
 const root=$('grade-controls');root.replaceChildren();const heading=document.createElement('h3');heading.textContent='COLOUR & LOOK';root.appendChild(heading);
 slider(root,'intensity','Look intensity',0,1,.01,grade.intensity,v=>grade.intensity=v,v=>Math.round(v*100)+'%');
 const definitions=[['exposure','Digital brightness / exposure',-2,2,.05,v=>(v>0?'+':'')+v.toFixed(2)+' EV'],['contrast','Contrast',.5,1.6,.01],['saturation','Saturation',0,1.8,.01],['warmth','Warmth',-1,1,.02],['shadows','Lift shadows',-.5,1,.02],['highlights','Highlights',-1,.5,.02],['sharpness','Sharpen',0,1,.02],['vignette','Vignette',0,.8,.02],['grain','Film grain',0,1,.02]];
 for(const [key,label,min,max,step,format] of definitions)slider(root,'grade-'+key,label,min,max,step,grade.adjust[key],v=>grade.adjust[key]=v,format);
 const lab=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.id='letterbox';box.onchange=()=>grade.adjust.letterbox=box.checked?1:0;lab.append(box,' Cinema bars (baked into video)');root.appendChild(lab);
 const reset=document.createElement('button');reset.textContent='Reset colour';reset.className='reset';reset.onclick=()=>{grade.adjust={exposure:0,contrast:1,saturation:1,warmth:0,shadows:0,highlights:0,vignette:0,grain:0,sharpness:0,letterbox:0};grade.intensity=1;selectLook(0);buildGradeControls()};root.appendChild(reset);
}
function buildHardware(){
 const root=$('hardware');root.replaceChildren();hardwareState={};const track=stream?.getVideoTracks()[0];if(!track)return;
 const caps=track.getCapabilities?.()||{},settings=track.getSettings();
 const p=document.createElement('p');p.textContent='Only controls exposed by this camera/browser are enabled. ISO and focus are hardware controls, not visual simulations.';root.appendChild(p);
 const unsupported=(label)=>{const e=document.createElement('div');e.className='unsupported';e.textContent=label+' · not exposed by this camera/browser';root.appendChild(e)};
 for(const [key,label] of [['focusMode','Focus mode'],['exposureMode','Exposure mode'],['whiteBalanceMode','White balance']]){
  if(!Array.isArray(caps[key])||!caps[key].length){unsupported(label);continue}
  const lab=document.createElement('label'),select=document.createElement('select');lab.textContent=label;select.id='hw-'+key;
  for(const mode of caps[key]){const option=document.createElement('option');option.value=mode;option.textContent=mode==='continuous'?'Continuous auto':mode==='single-shot'?'Single-shot auto':mode;select.appendChild(option)}
  select.value=settings[key]||caps[key][0];select.onchange=()=>applyHardware(key,select.value).then(refreshHardwareAvailability);root.append(lab,select);
 }
 for(const [key,label] of [['exposureCompensation','Exposure compensation (EV)'],['iso','ISO'],['exposureTime','Exposure time (camera units)'],['focusDistance','Manual focus distance'],['colorTemperature','White balance (K)'],['zoom','Optical / camera zoom']]){
  const cap=caps[key];if(!cap||!Number.isFinite(cap.min)||cap.max<=cap.min){unsupported(label);continue}
  slider(root,'hw-'+key,label,cap.min,cap.max,cap.step||((cap.max-cap.min)/100),settings[key]??cap.min,(value,out)=>{out.value='Requesting…';applyHardware(key,value).then(()=>{const actual=track.getSettings()[key];out.value=actual===undefined?'Unconfirmed':String(Math.round(actual*100)/100)})},v=>String(Math.round(v*100)/100));
 }
 if(caps.torch === true || (Array.isArray(caps.torch) && caps.torch.includes(true))){
  const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.id='hw-torch';box.checked=!!settings.torch;box.onchange=()=>applyHardware('torch',box.checked);label.append(box,' Torch');root.appendChild(label)
 }
 refreshHardwareAvailability();
}
function refreshHardwareAvailability(){
 const s=stream?.getVideoTracks()[0]?.getSettings()||{};
 for(const [id,key,mode] of [['hw-focusDistance','focusMode','manual'],['hw-iso','exposureMode','manual'],['hw-exposureTime','exposureMode','manual'],['hw-colorTemperature','whiteBalanceMode','manual']]){
  const el=$(id);if(el){el.disabled=s[key]!==mode;el.title=el.disabled?'Select manual mode above first':''}
 }
 const ev=$('hw-exposureCompensation');if(ev)ev.disabled=s.exposureMode==='manual';
}
function applyHardware(key,value){
 const track=stream?.getVideoTracks()[0];if(!track)return Promise.resolve();hardwareState[key]=value;
 hardwareQueue=hardwareQueue.catch(()=>{}).then(async()=>{
  if(track!==stream?.getVideoTracks()[0])return;
  const desired={...hardwareState};try{
   const constraints=track.getConstraints();await track.applyConstraints({...constraints,advanced:[desired]});
   const actual=track.getSettings()[key];
   if(actual===undefined|| (typeof value==='string'&&actual!==value))notice('Camera did not confirm '+key+'. Control may not be available.');
  }catch(e){delete hardwareState[key];notice('Camera rejected '+key+': '+e.message)}
 });return hardwareQueue;
}
$('pro').onclick=()=>{$('pro-panel').hidden=!$('pro-panel').hidden;$('pro').setAttribute('aria-expanded',String(!$('pro-panel').hidden));$('quality').hidden=true};
$('pro-close').onclick=()=>{$('pro-panel').hidden=true;$('pro').setAttribute('aria-expanded','false')};
$('output-size').onchange=()=>{if(active()||busy){$('output-size').value=grade?.outputHeight||1080;return}if(grade){grade.outputHeight=+$('output-size').value;grade.resize()}};
let swipeStart=null;
$('graded').addEventListener('pointerdown',e=>{swipeStart={x:e.clientX,y:e.clientY};});
$('graded').addEventListener('pointerup',async e=>{
 if(!swipeStart)return;const dx=e.clientX-swipeStart.x,dy=e.clientY-swipeStart.y;swipeStart=null;
 if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)*1.3){selectLook(grade.look+(dx<0?1:-1));return}
 if(Math.hypot(dx,dy)>12||!stream)return;
 const track=stream.getVideoTracks()[0],caps=track.getCapabilities?.()||{},supported=navigator.mediaDevices.getSupportedConstraints();
 if(!supported.pointsOfInterest||!(Array.isArray(caps.focusMode)&&caps.focusMode.some(m=>m==='single-shot'||m==='continuous'))){notice('Tap focus is not exposed by this camera/browser.');return}
 const rect=$('graded').getBoundingClientRect(),ratio=Math.min(rect.width/video.videoWidth,rect.height/video.videoHeight),w=video.videoWidth*ratio,h=video.videoHeight*ratio;
 let x=(e.clientX-rect.left-(rect.width-w)/2)/w,y=(e.clientY-rect.top-(rect.height-h)/2)/h;
 if(x<0||x>1||y<0||y>1)return;if($('graded').classList.contains('mirror'))x=1-x;
 const ring=$('focus-ring');ring.style.left=e.clientX+'px';ring.style.top=e.clientY+'px';ring.hidden=false;setTimeout(()=>ring.hidden=true,900);
 hardwareState.focusMode=caps.focusMode.includes('single-shot')?'single-shot':'continuous';await applyHardware('pointsOfInterest',[{x,y}]);notice('Focus point requested');refreshHardwareAvailability();
});
$('graded').addEventListener('pointercancel',()=>swipeStart=null);
