/* Single-pass WebGL grading; the very same canvas is recorded. No cloud/assets. */
window.CameraGrade=class CameraGrade {
 constructor(video,canvas){
  this.video=video;this.canvas=canvas;this.stream=null;this.frames=0;this.fps=0;this.lastStats=0;this.outputHeight=1080;this.look=0;this.intensity=1;
  this.adjust={exposure:0,contrast:1,saturation:1,warmth:0,shadows:0,highlights:0,vignette:0,grain:0,sharpness:0,letterbox:0};
  this.looks=[['Original',[0,1,1,0,0,0,0,0]],['Cinema',[.05,1.12,.9,.12,.05,-.14,.15,1]],['Golden',[.1,1.06,.95,.65,.08,-.1,.08,0]],['Arctic',[0,1.12,.8,-.6,0,-.08,.1,0]],['Soft Film',[.08,.91,.82,.16,.2,-.18,.13,0]],['Mono',[0,1.12,0,0,.05,-.08,.1,0]],['Noir',[-.12,1.48,0,0,-.1,-.08,.35,0]],['Sunset',[.08,1.1,1.16,.8,.04,-.12,.12,0]],['Neon',[-.08,1.22,1.45,-.22,0,-.1,.2,1]],['Portrait',[.12,.96,.92,.15,.09,-.15,.08,0]],['Crisp',[0,1.18,1.1,-.08,0,-.06,.06,0]],['Vintage',[.05,.93,.7,.48,.21,-.15,.28,0]]];
  const gl=canvas.getContext('webgl',{alpha:false,antialias:false,preserveDrawingBuffer:false,powerPreference:'high-performance'});if(!gl)throw Error('WebGL effects unavailable');this.gl=gl;
  const vert='attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,1.-(p.y+1.)*.5);gl_Position=vec4(p,0.,1.);}';
  const frag=`precision mediump float;varying vec2 uv;uniform sampler2D image;uniform vec2 pixel;uniform vec4 a,b;uniform vec4 extra;uniform float teal,grain,seed,sharp,letterbox;
  float noise(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233))+seed)*43758.5453);}
  void main(){vec3 c=texture2D(image,uv).rgb;
   if(sharp>0.){vec3 blur=(texture2D(image,uv+vec2(pixel.x,0.)).rgb+texture2D(image,uv-vec2(pixel.x,0.)).rgb+texture2D(image,uv+vec2(0.,pixel.y)).rgb+texture2D(image,uv-vec2(0.,pixel.y)).rgb)*.25;c+=sharp*(c-blur);}
   c*=exp2(a.x);float lum=dot(c,vec3(.2126,.7152,.0722));
   c+=b.x*(1.-smoothstep(0.,.65,lum))*.28;c+=b.y*smoothstep(.4,1.,lum)*.3;
   c=(c-.5)*a.y+.5;lum=dot(c,vec3(.2126,.7152,.0722));c=mix(vec3(lum),c,a.z);
   c+=a.w*vec3(.09,.018,-.09);c+=teal*(1.-smoothstep(.1,.65,lum))*vec3(-.035,.025,.045);
   float vig=smoothstep(.25,.73,distance(uv,vec2(.5)));c*=1.-b.z*vig;
   c+=(noise(gl_FragCoord.xy)-.5)*grain*.065;c=clamp(c,0.,1.);
   if(letterbox>.5&&(uv.y<.105||uv.y>.895))c=vec3(0.);gl_FragColor=vec4(c,1.);}`;
  const compile=(type,src)=>{let s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s};
  let program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vert));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,frag));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Effect shader failed');gl.useProgram(program);this.program=program;
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);const loc=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  this.u={};for(const n of ['image','pixel','a','b','teal','grain','seed','sharp','letterbox'])this.u[n]=gl.getUniformLocation(program,n);
  this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.failed=true;this.onError?.('Effects renderer stopped. Save your clip and reload.');});
  this.running=true;let last=-1;
  const tick=(t)=>{if(!this.running)return;if(video.readyState>=2&&video.currentTime!==last){last=video.currentTime;this.draw(t)}if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(tick);else requestAnimationFrame(tick)};
  if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(tick);else requestAnimationFrame(tick);
 }
 resize(){const w=this.video.videoWidth,h=this.video.videoHeight;if(!w||!h)return;const factor=Math.min(1,this.outputHeight/Math.min(w,h));this.canvas.width=Math.max(2,Math.round(w*factor/2)*2);this.canvas.height=Math.max(2,Math.round(h*factor/2)*2);this.gl.viewport(0,0,this.canvas.width,this.canvas.height)}
 draw(now=performance.now()){
  if(this.failed||!this.video.videoWidth)return;
  if(!this.canvas.width||this.canvas.width===300)this.resize();
  const gl=this.gl,u=this.u,d=this.adjust,p=this.looks[this.look][1],k=this.intensity;
  gl.bindTexture(gl.TEXTURE_2D,this.texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,this.video);
  gl.uniform2f(u.pixel,1/this.video.videoWidth,1/this.video.videoHeight);
  gl.uniform4f(u.a,d.exposure+p[0]*k,d.contrast*(1+(p[1]-1)*k),d.saturation*(1+(p[2]-1)*k),d.warmth+p[3]*k);
  gl.uniform4f(u.b,d.shadows+p[4]*k,d.highlights+p[5]*k,Math.min(1,d.vignette+p[6]*k),0);
  gl.uniform1f(u.teal,p[7]*k);gl.uniform1f(u.grain,d.grain);gl.uniform1f(u.seed,now*.001);gl.uniform1f(u.sharp,d.sharpness);gl.uniform1f(u.letterbox,d.letterbox);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);this.stream?.getVideoTracks()[0]?.requestFrame?.();
  this.frames++;if(now-this.lastStats>=1000){this.fps=this.frames*1000/(now-this.lastStats);this.frames=0;this.lastStats=now}
 }
 capture(fps){this.stopCapture();this.draw();this.stream=this.canvas.captureStream(0);if(!this.stream.getVideoTracks()[0].requestFrame){this.stopCapture();this.stream=this.canvas.captureStream(Math.min(60,fps||30))}return this.stream}
 stopCapture(){this.stream?.getTracks().forEach(t=>t.stop());this.stream=null}
};
