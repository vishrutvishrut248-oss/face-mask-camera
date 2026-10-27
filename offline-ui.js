'use strict';
let exportWorker=null,exportURL=null,exportWake=null;
$('open-export').onclick=()=>{if(!lastClipBlob)return;$('export-panel').hidden=false;$('export-start').disabled=false;$('export-cancel').textContent='Close';$('export-status').textContent='Ready. Original download remains unchanged.'};
async function releaseExport(){exportInProgress=false;exportWorker?.terminate();exportWorker=null;if(grade)grade.suspended=false;if(stream)video.play().catch(()=>{});if(exportWake){exportWake.release().catch(()=>{});exportWake=null}lock(false);$('export-start').disabled=false;$('export-size').disabled=false;$('export-cancel').textContent='Close'}
$('export-cancel').onclick=async()=>{if(exportInProgress){await releaseExport();$('export-status').textContent='Cancelled. Original clip is safe.'}else $('export-panel').hidden=true};
$('export-start').onclick=async()=>{
 if(!lastClipBlob||exportInProgress)return;
 if(!window.Worker||!window.VideoEncoder||!window.VideoDecoder){$('export-status').textContent='Offline export needs WebCodecs. Update Android Chrome. Your original is still available.';return}
 if(lastClipBlob.size>350*1048576){$('export-status').textContent='Clip is too large for safe on-device export. Use a shorter clip; original is unchanged.';return}
 exportInProgress=true;window.__lastExport=null;lock(true);$('export-start').disabled=true;$('export-size').disabled=true;$('export-save').hidden=true;$('export-progress').value=0;$('export-status').textContent='Preparing decoder and 60 FPS encoder…';$('export-cancel').textContent='Cancel processing';
 if(grade)grade.suspended=true;video.pause();
 try{
  if(navigator.wakeLock)exportWake=await navigator.wakeLock.request('screen').catch(()=>null);
  if(!exportInProgress){exportWake?.release();return}
  exportWorker=new Worker('./vendor/export-worker.js?v=offline60-4',{type:'module'});
  exportWorker.onerror=async e=>{$('export-status').textContent='Export failed: '+e.message+'. Original clip is safe.';await releaseExport()};
  exportWorker.onmessage=async({data:d})=>{
   if(d.type==='progress'){$('export-progress').value=d.progress;$('export-status').textContent=`Synthesizing / encoding ${Math.round(d.progress*100)}% · ${d.frame}/${d.total} frames`}
   if(d.type==='error'){$('export-status').textContent=d.message+' Original clip is unchanged.';await releaseExport()}
   if(d.type==='done'){
    if(exportURL)URL.revokeObjectURL(exportURL);exportURL=URL.createObjectURL(new Blob([d.buffer],{type:d.mime}));$('export-save').href=exportURL;$('export-save').download=`smooth-60-${Date.now()}.${d.extension}`;$('export-save').hidden=false;$('export-progress').value=1;
    $('export-status').textContent=`Verified 60 FPS timing · ${d.frames} frames · ${d.width}×${d.height} · ${d.audio?'audio preserved':'no audio in source'}. Synthetic motion, not native 60 FPS.`;
    window.__lastExport={...d,buffer:undefined};await releaseExport();
   }
  };
  exportWorker.postMessage({type:'export',blob:lastClipBlob,height:+$('export-size').value,grade:lastClipGrade});
 }catch(e){$('export-status').textContent=e.message+'. Original clip is safe.';await releaseExport()}
};
window.addEventListener('pagehide',()=>{exportWorker?.terminate();if(exportURL)URL.revokeObjectURL(exportURL)});
