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
      catch (error) { reports.push({ name:file.name, size:null, issues:[`Could not read this file: ${error.message || 'unknown error'}.`], warnings:[], state:'fail', category:'integrity' }); }
      render();
    }
  }

  async function inspectFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseSTL(bytes);
    if (!parsed.triangles.length) throw new Error('no valid triangles found');
    const mesh = analyse(parsed.triangles);
    const [x,y,z] = mesh.bounds.map(pair => pair[1] - pair[0]);
    const issues = [], warnings = [], info = [];
    const minZ = mesh.bounds[2][0];
    if (minZ > 0.05) warnings.push(`The model starts ${fmt(minZ)} above z=0, so it is floating above the workplane. Lower it onto the workplane in Tinkercad or use Cura’s “Drop to build plate” tool.`);
    if (minZ < -0.05) warnings.push(`The model extends ${fmt(Math.abs(minZ))} below z=0. Check its placement on the workplane or drop it onto the build plate in Cura.`);
    if (x > LIMITS.x + .01) issues.push(`X width is ${fmt(x)}; maximum is 30 mm.`);
    if (y > LIMITS.y + .01) issues.push(`Y depth is ${fmt(y)}; maximum is 30 mm.`);
    if (z > LIMITS.z + .01) issues.push(`Height is ${fmt(z)}; maximum is 60 mm.`);
    if (mesh.separateSections > 1) warnings.push(`Found ${mesh.separateSections} mesh sections in separate areas that do not touch. This may be more than one printable piece; check the Cura preview.`);
    if (!mesh.flatBase) warnings.push('No broad, flat surface was found at the lowest point. It may need rotating or a brim in Cura.');
    if (mesh.flatBase && mesh.baseRatio < .06) warnings.push('The flat base is small compared with the model footprint; it may be less stable while printing.');
    if (mesh.lean > 2.4) warnings.push('The model’s footprint is notably offset from its overall shape. Review stability and orientation in Cura.');
    if (parsed.format === 'ascii' && !parsed.solidEnded) warnings.push('ASCII STL is missing its closing “endsolid” marker.');
    const symmetry = checkSymmetry(parsed.triangles, mesh.bounds);
    if (!symmetry.rotational || !symmetry.mirror) warnings.push(`Flagged as asymmetrical (approximate check): ${[
      !symmetry.rotational ? 'no clear rotational symmetry around the vertical axis' : '',
      !symmetry.mirror ? 'no clear symmetry across a vertical plane' : ''
    ].filter(Boolean).join('; ')}. This is a shape observation, not a print failure.`);
    const opening = checkTopOpening(parsed.triangles, mesh.bounds);
    if (opening.ok) info.push('Likely circular, vertical opening detected near the top.');
    else warnings.push(opening.message);
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
    if(height<=0||xySpan<=0)return {ok:false,message:'Could not check for a top opening because the model has no measurable height or width.'};
    const offsets=[.004,.012,.024,.04,.06,.085,.115,.15,.19,.24].map(f=>Math.max(.04,height*f)).filter((v,i,a)=>v<height*.35&&(i===0||v-a[i-1]>.01));
    const levels=offsets.map(offset=>({z:bounds[2][1]-offset,circles:[] }));
    const snap=Math.max(.0001,xySpan*.00001);
    for(const level of levels)level.circles=sliceCircles(triangles,level.z,snap);
    const allCircles=levels.flatMap(level=>level.circles);
    if(!allCircles.length)return {ok:false,message:'No circular opening was detected near the top. Check that the model has an open hole on its upper surface.'};
    const centreTolerance=Math.max(.35,xySpan*.012), tracks=[];
    for(let start=0;start<levels.length;start++)for(const seed of levels[start].circles){
      const track=[{...seed,z:levels[start].z}];let previous=seed;
      for(let i=start+1;i<levels.length;i++){
        const candidates=levels[i].circles.filter(c=>Math.abs(c.radius-previous.radius)<=Math.max(.18,previous.radius*.14)&&Math.hypot(c.cx-previous.cx,c.cy-previous.cy)<=centreTolerance);
        if(!candidates.length)continue;
        const next=candidates.sort((a,b)=>Math.hypot(a.cx-previous.cx,a.cy-previous.cy)-Math.hypot(b.cx-previous.cx,b.cy-previous.cy))[0];
        track.push({...next,z:levels[i].z});previous=next;
      }
      if(track.length>=3)tracks.push(track);
    }
    if(!tracks.length)return {ok:false,message:'A circular-looking opening may be present, but the checker could not confirm a straight cylindrical wall extending down from the top.'};
    tracks.sort((a,b)=>b.length-a.length);
    const track=tracks[0], radii=track.map(p=>p.radius), avg=radii.reduce((a,b)=>a+b,0)/radii.length;
    const radiusVariation=Math.max(...radii.map(r=>Math.abs(r-avg)))/Math.max(avg,.001);
    const drift=Math.hypot(track[track.length-1].cx-track[0].cx,track[track.length-1].cy-track[0].cy);
    if(drift>Math.max(.35,xySpan*.012))return {ok:false,message:'A circular opening was detected near the top, but its centre shifts with height. It may be tilted rather than vertical.'};
    if(radiusVariation>.12)return {ok:false,message:'A circular opening was detected near the top, but its width changes with height. It may be tapered rather than cylindrical.'};
    return {ok:true,message:'Likely circular vertical opening'};
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
      if(inner.circularity<.78||inner.radialVariation>.12)continue;
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
    return {cx,cy,radius,radialVariation,area,circularity:4*Math.PI*area/(perimeter*perimeter)};
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
    summary.innerHTML=`<span class="summary-chip"><b>${reports.length}</b> files checked</span><span class="summary-chip"><b>${counts.pass}</b> pass</span><span class="summary-chip"><b>${counts.review}</b> need review</span><span class="summary-chip"><b>${counts.fail}</b> fail size check</span>`;
    body.innerHTML=reports.map(r=>{
      const pill=r.state==='pass'?'pill-pass':r.state==='fail'?'pill-fail':'pill-review';
      const label=r.state==='pass'?'Looks good':r.category==='integrity'?'Invalid STL':r.state==='fail'?'Size limit':'Review';
      const details=[...r.issues.map(t=>({t,type:'bad'})),...r.warnings.map(t=>({t,type:'warn'})),...(r.info||[]).map(t=>({t,type:'good'}))];
      if(!details.length)details.push({t:'STL file read successfully.',type:'good'});
      return `<tr><td title="${esc(r.name)}">${esc(r.name)}</td><td><span class="result-pill ${pill}">${label}</span></td><td class="dimensions">${r.dims?r.dims.map(fmt).join(' × '):'—'}</td><td class="details">${details.map(d=>`<span class="detail ${d.type}"><span class="detail-icon">${d.type==='good'?'✓':d.type==='bad'?'!':'•'}</span>${esc(d.t)}</span>`).join('')}</td></tr>`;
    }).join('');
  }
  function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function downloadReport(){
    const rows=[['File','Result','X width (mm)','Y depth (mm)','Z height (mm)','Issues','Warnings','Checks passed']];
    reports.forEach(r=>rows.push([r.name,r.state,...(r.dims||['','','']).map(n=>Number.isFinite(n)?n.toFixed(2):''),r.issues.join(' | '),r.warnings.join(' | '),(r.info||[]).join(' | ')]));
    const csv=rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='stl-check-report.csv';a.click();URL.revokeObjectURL(a.href);
  }
})();
