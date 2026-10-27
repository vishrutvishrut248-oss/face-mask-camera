/* Lightweight bidirectional block motion, not AI. Pure function for testing. */
export function estimateMotion(a,b,w,h,block=8,range=7){
 const cols=Math.ceil(w/block),rows=Math.ceil(h/block),data=new Uint8Array(cols*rows*4);
 let difference=0;const ha=new Uint32Array(16),hb=new Uint32Array(16);for(let i=0;i<a.length;i++){difference+=Math.abs(a[i]-b[i]);ha[a[i]>>4]++;hb[b[i]>>4]++;}
 let histogramDelta=0;for(let i=0;i<16;i++)histogramDelta+=Math.abs(ha[i]-hb[i]);
 const sceneCut=difference/a.length>52 && histogramDelta/a.length>.6;
 function search(src,dst,cx,cy){
  let best=Infinity,bx=0,by=0,min=255,max=0;
  for(let yy=-3;yy<=3;yy+=2)for(let xx=-3;xx<=3;xx+=2){const v=src[Math.max(0,Math.min(h-1,cy+yy))*w+Math.max(0,Math.min(w-1,cx+xx))];min=Math.min(min,v);max=Math.max(max,v)}
  if(max-min<7)return [0,0];
  for(let dy=-range;dy<=range;dy++)for(let dx=-range;dx<=range;dx++){
   let cost=(Math.abs(dx)+Math.abs(dy))*.15;
   for(let yy=-3;yy<=3;yy+=2){const sy=Math.max(0,Math.min(h-1,cy+yy)),ty=Math.max(0,Math.min(h-1,cy+yy+dy));
    for(let xx=-3;xx<=3;xx+=2){const sx=Math.max(0,Math.min(w-1,cx+xx)),tx=Math.max(0,Math.min(w-1,cx+xx+dx));cost+=Math.abs(src[sy*w+sx]-dst[ty*w+tx])}
   }
   if(cost<best){best=cost;bx=dx;by=dy}
  }return [bx,by];
 }
 for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
  const cx=Math.min(w-1,x*block+block/2),cy=Math.min(h-1,y*block+block/2),f=sceneCut?[0,0]:search(a,b,cx|0,cy|0),r=sceneCut?[0,0]:search(b,a,cx|0,cy|0),o=(y*cols+x)*4;
  data[o]=128+f[0]*8;data[o+1]=128+f[1]*8;data[o+2]=128+r[0]*8;data[o+3]=128+r[1]*8;
 }return {data,cols,rows,sceneCut};
}
