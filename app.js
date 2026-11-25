(() => {
  const input = document.querySelector('#file-input');
  const zone = document.querySelector('#drop-zone');
  const resultsSection = document.querySelector('#results-section');
  const body = document.querySelector('#results-body');
  const summary = document.querySelector('#summary');
  let reports = [];
  const LIMITS = { x: 30, y: 30, z: 60 };
  const fmt = n => Number.isFinite(n) ? `${n.toFixed(1)} mm` : '—';

  document.querySelector('#browse-button').addEventListener('click', e => { e.stopPropagation(); input.click(); });
  zone.addEventListener('click', e => { if (!e.target.closest('button')) input.click(); });
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  for (const type of ['dragenter','dragover']) zone.addEventListener(type, e => { e.preventDefault(); zone.classList.add('dragging'); });
  for (const type of ['dragleave','drop']) zone.addEventListener(type, e => { e.preventDefault(); zone.classList.remove('dragging'); });
  zone.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
  document.querySelector('#clear-button').addEventListener('click', () => { reports = []; render(); });
  document.querySelector('#download-button').addEventListener('click', downloadReport);

  async function addFiles(files) {
    const stls = files.filter(f => /\.stl$/i.test(f.name) || /model\/stl|application\/sla/i.test(f.type));
    for (const file of stls) {
      try { reports.push(await inspectFile(file)); }
      catch (error) { reports.push({ name:file.name, size:null, issues:[friendlyFileError(error)], warnings:[], state:'fail', category:'integrity' }); }
      render();
    }
  }

  function friendlyFileError(error) {
    const message=String(error?.message||'');
    if(message.includes('empty'))return 'No 3D shape data was found in this file. Export the model again from Tinkercad.';
    if(message.includes('incomplete ASCII'))return 'Some shape data is missing from this STL file. It may be incomplete or damaged; export it again from Tinkercad.';
    if(message.includes('invalid coordinate'))return 'This STL contains a measurement the checker cannot read. Export it again from Tinkercad.';
    if(message.includes('recognised ASCII or binary'))return 'This doesn’t look like a readable STL file. Check the file and export it again from Tinkercad.';
    return 'This file could not be read. Check that it is an STL file, then export it again from Tinkercad.';
  }

  async function inspectFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseSTL(bytes);
    if (!parsed.triangles.length) throw new Error('empty');
    const mesh = analyse(parsed.triangles);
    const [x,y,z] = mesh.bounds.map(pair => pair[1] - pair[0]);
    const issues = [], warnings = [], info = [];
    const minZ = mesh.bounds[2][0];
    if (minZ > 0.05) warnings.push(`The model is ${fmt(minZ)} above Tinkercad’s workplane (z=0). Move it down to the grid in Tinkercad, or use Cura’s “Drop to build plate” tool.`);
    if (minZ < -0.05) warnings.push(`The model extends ${fmt(Math.abs(minZ))} below Tinkercad’s workplane (z=0). Check its position in Tinkercad, or use Cura’s “Drop to build plate” tool.`);
    if (x > LIMITS.x + .01) issues.push(`Width (X) is ${fmt(x)}; the limit is 30 mm. Make the model narrower.`);
    if (y > LIMITS.y + .01) issues.push(`Depth (Y) is ${fmt(y)}; the limit is 30 mm. Make the model shallower.`);
    if (z > LIMITS.z + .01) issues.push(`Height is ${fmt(z)}; the limit is 60 mm. Make the model shorter.`);
    if (mesh.separateSections > 1) warnings.push(`The file contains ${mesh.separateSections} separate areas that do not touch. They may print as separate pieces; check the Cura preview.`);
    if (!mesh.flatBase) warnings.push('I couldn’t find a wide, flat bottom face. Check that the model can sit flat on the build plate; rotating it or adding a brim in Cura may help.');
    if (mesh.flatBase && mesh.baseRatio < .06) warnings.push('The part touching the build plate looks small compared with the model. It may wobble or come loose while printing; check the Cura preview.');
    if (hasHollowBottom(parsed.triangles, mesh.bounds)) warnings.push('The underside appears hollow: only a rim may touch the build plate, with an opening underneath. Check the Cura preview or turn the model so a solid face sits on the plate.');
    if (mesh.lean > 2.4) warnings.push('The model’s shape sits noticeably off-centre over its base. Check that it will stay upright in Cura.');
    if (parsed.format === 'ascii' && !parsed.solidEnded) warnings.push('The file ending looks incomplete. Cura may still open it, but re-export from Tinkercad if Cura shows a problem.');
    const symmetry = checkSymmetry(parsed.triangles, mesh.bounds);
    if (!symmetry.rotational || !symmetry.mirror) warnings.push(`The shape looks asymmetrical: ${[
      !symmetry.rotational ? 'it does not look the same when turned around its upright axis' : '',
      !symmetry.mirror ? 'it does not appear to match across a vertical middle line' : ''
    ].filter(Boolean).join('; ')}. This is not a failure; check whether it matches the assignment.`);
    const opening = checkTopOpening(parsed.triangles, mesh.bounds);
    if (opening.ok) info.push('The top opening looks round and upright.');
    if (!opening.ok) warnings.push(opening.message);
    if (opening.widerBottom) info.push('The socket widens near its deep end, as expected for the click-fit shape.');
    if (Number.isFinite(opening.depthMm)) {
      if (opening.depthMm < 6) issues.push(`The socket is about ${opening.depthMm.toFixed(2)} mm deep; it must be 6–10.3 mm deep. Changing the grouped model’s height can change the socket too. Set the model height first, then make the socket deeper.`);
      else if (opening.depthMm > 10.3) issues.push(`The socket is about ${opening.depthMm.toFixed(2)} mm deep; it must be 6–10.3 mm deep. Changing the grouped model’s height can change the socket too. Set the model height first, then make the socket shallower.`);
      else info.push(`Socket depth: about ${opening.depthMm.toFixed(1)} mm (required: 6–10.3 mm).`);
    } else warnings.push('I couldn’t measure the socket depth reliably. Please check it in Tinkercad or Cura.');
    return { name:file.name, size:file.size, dims:[x,y,z], issues, warnings, info, symmetry, opening, state:issues.length ? 'fail' : warnings.length ? 'review' : 'pass', format:parsed.format };
  }

  function parseSTL(bytes) {
    if (bytes.length >= 84) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(80, true);
      if (count > 0 && 84 + count * 50 === bytes.length) {
        const triangles=[]; let offset=84;
        for(let i=0;i<count;i++,offset+=50){const tri=[];for(let j=0;j<3;j++){const p=offset+12+j*12;tri.push([view.getFloat32(p,true),view.getFloat32(p+4,true),view.getFloat32(p+8,true)]);}triangles.push(tri);}
        if(triangles.every(t=>t.flat().every(Number.isFinite))) return {triangles,format:'binary'};
      }
    }
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*solid(?:\s|$)/i.test(text) || !/\bvertex\s/i.test(text)) throw new Error('not a recognised ASCII or binary STL');
    const matches = [...text.matchAll(/\bvertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/gi)];
    if (!matches.length || matches.length % 3) throw new Error('incomplete ASCII STL triangle data');
    const triangles=[];
    for(let i=0;i<matches.length;i+=3){const tri=matches.slice(i,i+3).map(m=>m.slice(1,4).map(Number));if(tri.flat().some(n=>!Number.isFinite(n)))throw new Error('invalid coordinate value');triangles.push(tri);}
    return {triangles,format:'ascii',solidEnded:/\bendsolid\b/i.test(text)};
  }

  function analyse(triangles) {
    const bounds=[[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]], vertices=[], edgeMap=new Map(), parent=triangles.map((_,i)=>i);
    const key=p=>p.map(n=>Math.round(n*10000)).join(',');
    const find=x=>parent[x]===x?x:(parent[x]=find(parent[x]));
    const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
    triangles.forEach((tri,ti)=>{
      const ids=tri.map(p=>{p.forEach((v,k)=>{bounds[k][0]=Math.min(bounds[k][0],v);bounds[k][1]=Math.max(bounds[k][1],v);});vertices.push(p);return key(p);});
      for(const [u,v] of [[0,1],[1,2],[2,0]]){const ek=[ids[u],ids[v]].sort().join('|');if(edgeMap.has(ek))join(ti,edgeMap.get(ek));else edgeMap.set(ek,ti);}
    });
    const componentBounds=new Map();
    triangles.forEach((tri,i)=>{
      const root=find(i);if(!componentBounds.has(root))componentBounds.set(root,[[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]]);
      const cb=componentBounds.get(root);for(const p of tri)p.forEach((v,k)=>{cb[k][0]=Math.min(cb[k][0],v);cb[k][1]=Math.max(cb[k][1],v);});
    });
    const groups=[...componentBounds.values()], separated=new Set(), gapTolerance=Math.max(0.05,Math.hypot(...bounds.map(b=>b[1]-b[0]))*1e-4);
    for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){
      if(groups[i].some((axis,k)=>axis[1]+gapTolerance<groups[j][k][0]||groups[j][k][1]+gapTolerance<axis[0])){separated.add(i);separated.add(j);}
    }
    const minZ=bounds[2][0], maxZ=bounds[2][1], zSpan=maxZ-minZ, tol=Math.max(1e-5,zSpan*1e-4); let baseArea=0;
    for(const tri of triangles){if(tri.every(p=>Math.abs(p[2]-minZ)<=tol)){const [a,b,c]=tri;baseArea+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;}}
    const footprint=(bounds[0][1]-bounds[0][0])*(bounds[1][1]-bounds[1][0]);
    const centroid=[0,0,0];vertices.forEach(p=>p.forEach((v,k)=>centroid[k]+=v/vertices.length));
    const center=[(bounds[0][0]+bounds[0][1])/2,(bounds[1][0]+bounds[1][1])/2];
    const denom=Math.max(1e-9,Math.min(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0]));
    return {bounds,separateSections:separated.size,flatBase:baseArea>=Math.max(1e-8,footprint*.002),baseRatio:footprint?baseArea/footprint:0,lean:Math.hypot(centroid[0]-center[0],centroid[1]-center[1])/denom};
  }

  function checkSymmetry(triangles, bounds) {
    // Compare sampled surface points with transformed points using a spatial hash.
    // A generous geometric tolerance avoids requiring identical STL triangulation.
    const center=[(bounds[0][0]+bounds[0][1])/2,(bounds[1][0]+bounds[1][1])/2,(bounds[2][0]+bounds[2][1])/2];
    const span=Math.hypot(...bounds.map(b=>b[1]-b[0]));
    const tolerance=Math.max(.12,span*.012), cell=tolerance;
    const points=[], seen=new Set();
    const add=p=>{const k=p.map(v=>Math.round(v*10000)).join(',');if(!seen.has(k)){seen.add(k);points.push(p);}};
    const step=Math.max(1,Math.ceil(triangles.length/5000));
    for(let i=0;i<triangles.length;i+=step){const tri=triangles[i];for(const p of tri)add(p);add([(tri[0][0]+tri[1][0]+tri[2][0])/3,(tri[0][1]+tri[1][1]+tri[2][1])/3,(tri[0][2]+tri[1][2]+tri[2][2])/3]);}
    const hash=new Map();
    for(const p of points){const key=p.map(v=>Math.floor(v/cell)).join(',');if(!hash.has(key))hash.set(key,[]);hash.get(key).push(p);}
    const matchedFraction=transform=>{
      let hit=0;
      for(const p of points){const q=transform(p), base=q.map(v=>Math.floor(v/cell));let found=false;
        for(let dx=-1;dx<=1&&!found;dx++)for(let dy=-1;dy<=1&&!found;dy++)for(let dz=-1;dz<=1&&!found;dz++){
          const bucket=hash.get(`${base[0]+dx},${base[1]+dy},${base[2]+dz}`)||[];
          if(bucket.some(r=>(r[0]-q[0])**2+(r[1]-q[1])**2+(r[2]-q[2])**2<=tolerance*tolerance))found=true;
        }
        if(found)hit++;
      }
      return points.length?hit/points.length:0;
    };
    // Test common rotational orders from 2-fold through 12-fold around vertical Z.
    const rotational=Array.from({length:11},(_,i)=>2*Math.PI/(i+2)).some(angle=>matchedFraction(p=>{
      const x=p[0]-center[0],y=p[1]-center[1],c=Math.cos(angle),s=Math.sin(angle);
      return [center[0]+x*c-y*s,center[1]+x*s+y*c,p[2]];
    })>=.9);
    // Try a set of vertical plane orientations, including diagonal planes.
    const mirror=Array.from({length:12},(_,i)=>i*Math.PI/12).some(angle=>matchedFraction(p=>{
      const x=p[0]-center[0],y=p[1]-center[1],c=Math.cos(2*angle),s=Math.sin(2*angle);
      return [center[0]+x*c+y*s,center[1]+x*s-y*c,p[2]];
    })>=.9);
    return {rotational,mirror};
  }

  function checkTopOpening(triangles, bounds) {
    const height=bounds[2][1]-bounds[2][0], xySpan=Math.hypot(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0]);
    if(height<=0||xySpan<=0)return {ok:false,message:'I couldn’t check for an opening because the model has no measurable height or width.'};
    const offsets=[.004,.012,.024,.04,.06,.085,.115,.15,.19,.24].map(f=>Math.max(.04,height*f)).filter((v,i,a)=>v<height*.35&&(i===0||v-a[i-1]>.01));
    const levels=offsets.map(offset=>({z:bounds[2][1]-offset,circles:[] }));
    const snap=Math.max(.0001,xySpan*.00001);
    for(const level of levels)level.circles=sliceCircles(triangles,level.z,snap);
    const allCircles=levels.flatMap(level=>level.circles);
    if(!allCircles.length)return {ok:false,message:'I couldn’t find an opening at the top. Check that the hole is open on the model’s upper surface.'};
    const tracks=[];
    for(let start=0;start<levels.length;start++)for(const seed of levels[start].circles){
      const track=[{...seed,z:levels[start].z}];let previous=seed;
      for(let i=start+1;i<levels.length;i++){
        const candidates=levels[i].circles;
        if(!candidates.length)continue;
        const next=candidates.sort((a,b)=>Math.hypot(a.cx-previous.cx,a.cy-previous.cy)-Math.hypot(b.cx-previous.cx,b.cy-previous.cy))[0];
        track.push({...next,z:levels[i].z});previous=next;
      }
      if(track.length>=3)tracks.push(track);
    }
    if(!tracks.length)return {ok:false,message:'I found an opening, but its shape changes as it goes down. Check that it is a straight-sided cylinder.'};
    tracks.sort((a,b)=>b.length-a.length);
    const track=tracks[0], radii=track.map(p=>p.radius);
    const meanZ=track.reduce((s,p)=>s+p.z,0)/track.length,meanX=track.reduce((s,p)=>s+p.cx,0)/track.length,meanY=track.reduce((s,p)=>s+p.cy,0)/track.length;
    let zVar=0,xCov=0,yCov=0;
    for(const p of track){const dz=p.z-meanZ;zVar+=dz*dz;xCov+=dz*(p.cx-meanX);yCov+=dz*(p.cy-meanY);}
    const slopeX=zVar?xCov/zVar:0,slopeY=zVar?yCov/zVar:0,slope=Math.hypot(slopeX,slopeY);
    const verticalSpan=Math.max(...track.map(p=>p.z))-Math.min(...track.map(p=>p.z));
    const centreShift=slope*verticalSpan,tiltDegrees=Math.atan(slope)*180/Math.PI;
    const tilted=centreShift>Math.max(.18,xySpan*.006);
    const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
    const axisRatio=median(track.map(p=>p.axisRatio));
    const upperRadii=track.slice(0,Math.max(2,Math.ceil(track.length/3))).map(p=>p.radius);
    const lowerRadii=track.slice(-Math.max(2,Math.ceil(track.length/3))).map(p=>p.radius);
    const upperRadius=upperRadii.reduce((a,b)=>a+b,0)/upperRadii.length,lowerRadius=lowerRadii.reduce((a,b)=>a+b,0)/lowerRadii.length;
    const widerBottom=lowerRadius>upperRadius*1.12;
    const orientationX=track.reduce((s,p)=>s+Math.cos(2*p.axisAngle),0),orientationY=track.reduce((s,p)=>s+Math.sin(2*p.axisAngle),0);
    const majorAxisAngle=.5*Math.atan2(orientationY,orientationX),tiltDirection=Math.atan2(slopeY,slopeX);
    const alignment=Math.acos(Math.min(1,Math.abs(Math.cos(majorAxisAngle-tiltDirection))))*180/Math.PI;
    const tiltedCircle=tilted&&axisRatio<.97&&Math.abs(axisRatio-1/Math.sqrt(1+slope*slope))<.08&&alignment<20;
    // Ignore small slice-to-slice fluctuations from the STL's faceted surface.
    // Only call it oval when the typical cross-section is clearly elongated or irregular.
    const oval=axisRatio<.92||median(track.map(p=>p.circularity))<.88||median(track.map(p=>p.radialVariation))>.16;
    const depthMm=measureOpeningDepth(triangles,bounds[2][1],bounds[2][0],track,meanX,meanY,meanZ,slopeX,slopeY,xySpan);
    if(tiltedCircle)return {ok:false,message:`The hole looks round, but it leans about ${tiltDegrees.toFixed(1)}° from upright.`,depthMm};
    if(tilted)return {ok:false,message:`The hole leans away from upright: it moves sideways about ${centreShift.toFixed(1)} mm as it goes down.${oval?' Looking straight down, it also appears oval.':''}`,depthMm};
    if(oval)return {ok:false,message:'The hole stays upright, but looks wider in one direction than the other instead of round.',depthMm};
    return {ok:true,message:'The top opening looks round and upright.',depthMm,widerBottom};
  }

  function hasHollowBottom(triangles,bounds) {
    const bottomZ=bounds[2][0],height=bounds[2][1]-bottomZ;
    const offsets=[.02,.06,.12].filter(offset=>offset<height*.1);
    if(offsets.length<2)return false;
    const snap=Math.max(.0001,Math.hypot(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0])*.00001);
    const hollowSlices=offsets.filter(offset=>sliceCircles(triangles,bottomZ+offset,snap).length>0).length;
    return hollowSlices>=2;
  }

  function measureOpeningDepth(triangles,topZ,bottomZ,track,meanX,meanY,meanZ,slopeX,slopeY,xySpan) {
    const startDepth=Math.max(.01,topZ-Math.max(...track.map(p=>p.z)));
    const maxDepth=topZ-bottomZ;
    const hasContourAt=depth=>{
      const z=topZ-depth;
      if(z<=bottomZ+.005)return false;
      const expectedX=meanX+slopeX*(z-meanZ),expectedY=meanY+slopeY*(z-meanZ);
      const centerTolerance=Math.max(.55,xySpan*.025);
      return sliceCircles(triangles,z,Math.max(.0001,xySpan*.00001)).some(c=>
        Math.hypot(c.cx-expectedX,c.cy-expectedY)<=centerTolerance
      );
    };
    // Vote across nearby planes so one awkward triangle slice cannot look like
    // the bottom of the socket.
    const hasOpeningAt=depth=>[-.06,0,.06].filter(offset=>hasContourAt(depth+offset)).length>=2;
    if(startDepth>=maxDepth)return maxDepth;
    let low=null;
    for(let d=startDepth;d<Math.min(maxDepth-.1,startDepth+1.5);d+=.1){
      if(hasOpeningAt(d)){low=d;break;}
    }
    if(low===null)return null;
    // Keep scanning until the contour stays absent for 1.5 mm. This ignores
    // intermittent contour breaks caused by the STL's triangulation.
    let high=null,firstMissing=null,misses=0;
    for(let d=low+.25;d<maxDepth-.05;d+=.25){
      if(hasOpeningAt(d)){low=d;firstMissing=null;misses=0;}
      else{
        if(misses===0)firstMissing=d;
        misses++;
        if(misses>=6){high=firstMissing;break;}
      }
    }
    if(high===null)return maxDepth;
    for(let i=0;i<10&&high-low>.04;i++){
      const mid=(low+high)/2;
      if(hasOpeningAt(mid))low=mid;else high=mid;
    }
    return (low+high)/2;
  }

  function sliceCircles(triangles,z,snap) {
    const segments=[];
    for(const tri of triangles){
      const hits=[];
      for(const [i,j] of [[0,1],[1,2],[2,0]]){
        const a=tri[i],b=tri[j];
        if((a[2]<=z&&b[2]>z)||(b[2]<=z&&a[2]>z)){
          const t=(z-a[2])/(b[2]-a[2]);hits.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);
        }
      }
      if(hits.length===2&&Math.hypot(hits[0][0]-hits[1][0],hits[0][1]-hits[1][1])>snap*.25)segments.push(hits);
    }
    const key=p=>`${Math.round(p[0]/snap)},${Math.round(p[1]/snap)}`, nodes=new Map(), edges=[];
    const add=(k,e)=>{if(!nodes.has(k))nodes.set(k,[]);nodes.get(k).push(e);};
    for(const seg of segments){const a=key(seg[0]),b=key(seg[1]);if(a===b)continue;const id=edges.length;edges.push([a,b]);add(a,id);add(b,id);}
    const used=new Uint8Array(edges.length), loops=[];
    for(let first=0;first<edges.length;first++){
      if(used[first])continue;
      const [start,next]=edges[first], path=[start];let at=next,edge=first,closed=false,guard=0;used[edge]=1;
      while(guard++<edges.length+1){path.push(at);if(at===start){closed=true;break;}const options=nodes.get(at)||[];const nextEdge=options.find(e=>!used[e]);if(nextEdge===undefined)break;used[nextEdge]=1;const ends=edges[nextEdge];at=ends[0]===at?ends[1]:ends[0];}
      if(closed&&path.length>=8){const points=path.slice(0,-1).map(k=>{const [x,y]=k.split(',').map(Number);return [x*snap,y*snap];});const metric=circleMetric(points);if(metric)loops.push({...metric,points});}
    }
    const circles=[];
    for(const inner of loops){
      const parent=loops.some(outer=>outer!==inner&&outer.area>inner.area*1.4&&pointInPolygon(inner.cx,inner.cy,outer.points));
      if(parent)circles.push(inner);
    }
    return circles;
  }

  function circleMetric(points) {
    let twiceArea=0,perimeter=0,cx=0,cy=0;
    for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];twiceArea+=a[0]*b[1]-b[0]*a[1];perimeter+=Math.hypot(b[0]-a[0],b[1]-a[1]);cx+=a[0];cy+=a[1];}
    const area=Math.abs(twiceArea)/2;if(!area||!perimeter)return null;cx/=points.length;cy/=points.length;
    const radii=points.map(p=>Math.hypot(p[0]-cx,p[1]-cy)),radius=radii.reduce((a,b)=>a+b,0)/radii.length;
    const radialVariation=Math.sqrt(radii.reduce((a,b)=>a+(b-radius)**2,0)/radii.length)/Math.max(radius,.001);
    // Polygon area moments make the aspect estimate less sensitive to uneven
    // vertex spacing in the STL triangulation than a point-cloud covariance.
    let signedA=0,mx=0,my=0,ix=0,iy=0,ixy=0;
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length],cross=a[0]*b[1]-b[0]*a[1];
      signedA+=cross;mx+=(a[0]+b[0])*cross;my+=(a[1]+b[1])*cross;
      ix+=(a[0]*a[0]+a[0]*b[0]+b[0]*b[0])*cross;
      iy+=(a[1]*a[1]+a[1]*b[1]+b[1]*b[1])*cross;
      ixy+=(2*a[0]*a[1]+a[0]*b[1]+b[0]*a[1]+2*b[0]*b[1])*cross;
    }
    const signedArea=signedA/2, polygonCx=mx/(6*signedArea), polygonCy=my/(6*signedArea);
    let xx=Math.abs(ix/(12*signedArea)-polygonCx*polygonCx),yy=Math.abs(iy/(12*signedArea)-polygonCy*polygonCy),xy=ixy/(24*signedArea)-polygonCx*polygonCy;
    const spread=Math.sqrt((xx-yy)**2+4*xy*xy),major=(xx+yy+spread)/2,minor=(xx+yy-spread)/2;
    const axisRatio=Math.sqrt(Math.max(0,minor)/Math.max(major,.000001));
    const axisAngle=.5*Math.atan2(2*xy,xx-yy);
    return {cx:polygonCx,cy:polygonCy,radius,radialVariation,axisRatio,axisAngle,area,circularity:4*Math.PI*area/(perimeter*perimeter)};
  }

  function pointInPolygon(x,y,points) {
    let inside=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++){
      const a=points[i],b=points[j];
      if(((a[1]>y)!==(b[1]>y))&&(x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]))inside=!inside;
    }
    return inside;
  }

  function render() {
    resultsSection.hidden = !reports.length;
    if (!reports.length) return;
    const counts={pass:0,review:0,fail:0};reports.forEach(r=>counts[r.state]++);
    summary.innerHTML=`<span class="summary-chip"><b>${reports.length}</b> files checked</span><span class="summary-chip"><b>${counts.pass}</b> checks passed</span><span class="summary-chip"><b>${counts.review}</b> need a look</span><span class="summary-chip"><b>${counts.fail}</b> do not meet a requirement</span>`;
    body.innerHTML=sortedReports().map(r=>{
      const pill=r.state==='pass'?'pill-pass':r.state==='fail'?'pill-fail':'pill-review';
      const label=r.state==='pass'?'Checks passed':r.category==='integrity'?'Can’t read file':r.state==='fail'?'Over a limit':'Needs a look';
      const details=[...r.issues.map(t=>({t,type:'bad'})),...r.warnings.map(t=>({t,type:'warn'})),...(r.info||[]).map(t=>({t,type:'good'}))];
      if(!details.length)details.push({t:'No issues were found by these checks. Open the file in Cura and review the preview before printing.',type:'good'});
      return `<tr><td title="${esc(r.name)}">${esc(r.name)}</td><td><span class="result-pill ${pill}">${label}</span></td><td class="dimensions">${r.dims?r.dims.map(fmt).join(' × '):'—'}</td><td class="details">${details.map(d=>`<span class="detail ${d.type}"><span class="detail-icon">${d.type==='good'?'✓':d.type==='bad'?'!':'•'}</span>${esc(d.t)}</span>`).join('')}</td></tr>`;
    }).join('');
  }
  function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function downloadReport(){
    const rows=[['File','Result','X width (mm)','Y depth (mm)','Z height (mm)','Issues','Things to check','Checks passed']];
    sortedReports().forEach(r=>rows.push([r.name,reportLabel(r),...(r.dims||['','','']).map(n=>Number.isFinite(n)?n.toFixed(2):''),r.issues.join(' | '),r.warnings.join(' | '),(r.info||[]).join(' | ')]));
    const csv=rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='stl-check-report.csv';a.click();URL.revokeObjectURL(a.href);
  }
  function reportLabel(r){return r.state==='pass'?'Checks passed':r.category==='integrity'?'Can’t read file':r.state==='fail'?'Over a limit':'Needs a look';}
  function sortedReports(){const priority={fail:0,review:1,pass:2};return reports.map((report,index)=>({report,index})).sort((a,b)=>priority[a.report.state]-priority[b.report.state]||a.index-b.index).map(item=>item.report);}
})();
