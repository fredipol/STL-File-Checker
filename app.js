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
    const issues = [], warnings = [];
    const minZ = mesh.bounds[2][0];
    if (minZ > 0.05) warnings.push(`The model starts ${fmt(minZ)} above z=0, so it is floating above the workplane. Lower it onto the workplane in Tinkercad or use Cura’s “Drop to build plate” tool.`);
    if (minZ < -0.05) warnings.push(`The model extends ${fmt(Math.abs(minZ))} below z=0. Check its placement on the workplane or drop it onto the build plate in Cura.`);
    if (x > LIMITS.x + .01) issues.push(`X width is ${fmt(x)}; maximum is 30 mm.`);
    if (y > LIMITS.y + .01) issues.push(`Y depth is ${fmt(y)}; maximum is 30 mm.`);
    if (z > LIMITS.z + .01) issues.push(`Height is ${fmt(z)}; maximum is 60 mm.`);
    if (mesh.components > 1) warnings.push(`Found ${mesh.components} disconnected pieces. Check whether the model should be joined.`);
    if (!mesh.flatBase) warnings.push('No broad, flat surface was found at the lowest point. It may need rotating or a brim in Cura.');
    if (mesh.flatBase && mesh.baseRatio < .06) warnings.push('The flat base is small compared with the model footprint; it may be less stable while printing.');
    if (mesh.lean > 2.4) warnings.push('The model’s footprint is notably offset from its overall shape. Review stability and orientation in Cura.');
    if (parsed.format === 'ascii' && !parsed.solidEnded) warnings.push('ASCII STL is missing its closing “endsolid” marker.');
    const symmetry = checkSymmetry(parsed.triangles, mesh.bounds);
    if (!symmetry.rotational || !symmetry.mirror) warnings.push(`Flagged as asymmetrical (approximate check): ${[
      !symmetry.rotational ? 'no clear rotational symmetry around the vertical axis' : '',
      !symmetry.mirror ? 'no clear symmetry across a vertical plane' : ''
    ].filter(Boolean).join('; ')}. This is a shape observation, not a print failure.`);
    return { name:file.name, size:file.size, dims:[x,y,z], issues, warnings, symmetry, state:issues.length ? 'fail' : warnings.length ? 'review' : 'pass', format:parsed.format };
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
    const roots=new Set(parent.map((_,i)=>find(i)));
    const minZ=bounds[2][0], maxZ=bounds[2][1], zSpan=maxZ-minZ, tol=Math.max(1e-5,zSpan*1e-4); let baseArea=0;
    for(const tri of triangles){if(tri.every(p=>Math.abs(p[2]-minZ)<=tol)){const [a,b,c]=tri;baseArea+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;}}
    const footprint=(bounds[0][1]-bounds[0][0])*(bounds[1][1]-bounds[1][0]);
    const centroid=[0,0,0];vertices.forEach(p=>p.forEach((v,k)=>centroid[k]+=v/vertices.length));
    const center=[(bounds[0][0]+bounds[0][1])/2,(bounds[1][0]+bounds[1][1])/2];
    const denom=Math.max(1e-9,Math.min(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0]));
    return {bounds,components:roots.size,flatBase:baseArea>=Math.max(1e-8,footprint*.002),baseRatio:footprint?baseArea/footprint:0,lean:Math.hypot(centroid[0]-center[0],centroid[1]-center[1])/denom};
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

  function render() {
    resultsSection.hidden = !reports.length;
    if (!reports.length) return;
    const counts={pass:0,review:0,fail:0};reports.forEach(r=>counts[r.state]++);
    summary.innerHTML=`<span class="summary-chip"><b>${reports.length}</b> files checked</span><span class="summary-chip"><b>${counts.pass}</b> pass</span><span class="summary-chip"><b>${counts.review}</b> need review</span><span class="summary-chip"><b>${counts.fail}</b> fail size check</span>`;
    body.innerHTML=reports.map(r=>{
      const pill=r.state==='pass'?'pill-pass':r.state==='fail'?'pill-fail':'pill-review';
      const label=r.state==='pass'?'Looks good':r.category==='integrity'?'Invalid STL':r.state==='fail'?'Size limit':'Review';
      const details=[...r.issues.map(t=>({t,type:'bad'})),...r.warnings.map(t=>({t,type:'warn'}))];
      if(!details.length)details.push({t:'STL file read successfully.',type:'good'});
      return `<tr><td title="${esc(r.name)}">${esc(r.name)}</td><td><span class="result-pill ${pill}">${label}</span></td><td class="dimensions">${r.dims?r.dims.map(fmt).join(' × '):'—'}</td><td class="details">${details.map(d=>`<span class="detail ${d.type}"><span class="detail-icon">${d.type==='good'?'✓':d.type==='bad'?'!':'•'}</span>${esc(d.t)}</span>`).join('')}</td></tr>`;
    }).join('');
  }
  function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function downloadReport(){
    const rows=[['File','Result','X width (mm)','Y depth (mm)','Z height (mm)','Issues','Warnings']];
    reports.forEach(r=>rows.push([r.name,r.state,...(r.dims||['','','']).map(n=>Number.isFinite(n)?n.toFixed(2):''),r.issues.join(' | '),r.warnings.join(' | ')]));
    const csv=rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='stl-check-report.csv';a.click();URL.revokeObjectURL(a.href);
  }
})();
