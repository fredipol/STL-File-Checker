(() => {
  const input=document.querySelector('#file-input'),zone=document.querySelector('#drop-zone');
  const resultsSection=document.querySelector('#results-section'),body=document.querySelector('#results-body'),summary=document.querySelector('#summary'),progress=document.querySelector('#progress-message');
  const limits={x:36,y:36,z:40},referenceBaseArea=45.2;let reports=[];
  const fmt=n=>Number.isFinite(n)?`${n.toFixed(1)} mm`:'—';
  document.querySelector('#browse-button').addEventListener('click',e=>{e.stopPropagation();input.click();});
  zone.addEventListener('click',e=>{if(!e.target.closest('button'))input.click();});
  zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click();}});
  input.addEventListener('change',()=>{addFiles([...input.files]);input.value='';});
  for(const type of ['dragenter','dragover'])zone.addEventListener(type,e=>{e.preventDefault();zone.classList.add('dragging');});
  for(const type of ['dragleave','drop'])zone.addEventListener(type,e=>{e.preventDefault();zone.classList.remove('dragging');});
  zone.addEventListener('drop',e=>addFiles([...e.dataTransfer.files]));
  document.querySelector('#clear-button').addEventListener('click',()=>{reports=[];progress.textContent='';render();});
  document.querySelector('#download-button').addEventListener('click',downloadReport);

  async function addFiles(files){
    const stls=files.filter(f=>/\.stl$/i.test(f.name)||/model\/stl|application\/sla/i.test(f.type));
    const skipped=files.length-stls.length;
    if(!stls.length){progress.textContent='No STL files found in that selection. Choose files ending in .stl.';return;}
    for(let i=0;i<stls.length;i++){
      const file=stls[i];
      progress.textContent=`Checking file ${i+1} of ${stls.length}: ${file.name}`;
      await new Promise(resolve=>requestAnimationFrame(resolve));
      try{reports.push(await inspectFile(file));}
      catch(error){reports.push({name:file.name,dims:null,issues:[friendlyError(error)],warnings:[],info:[],state:'fail',category:'integrity'});}
      render();
    }
    const skippedText=skipped?`; skipped ${skipped} non-STL file${skipped===1?'':'s'}`:'';
    progress.textContent=`Finished checking ${stls.length} STL file${stls.length===1?'':'s'}${skippedText}.`;
  }
  function friendlyError(error){
    const m=String(error?.message||'');
    if(m==='empty')return 'No 3D shape data was found. Export the model again from Tinkercad.';
    if(m.includes('incomplete ASCII'))return 'Some shape data is missing. The STL may be incomplete or damaged; export it again from Tinkercad.';
    if(m.includes('invalid coordinate'))return 'This STL contains a measurement the checker cannot read. Export it again from Tinkercad.';
    if(m.includes('recognised ASCII or binary'))return 'This doesn’t look like a readable STL file. Check the file and export it again from Tinkercad.';
    return 'This file could not be read. Check that it is an STL file, then export it again from Tinkercad.';
  }

  async function inspectFile(file){
    const parsed=parseSTL(new Uint8Array(await file.arrayBuffer()));
    if(!parsed.triangles.length)throw new Error('empty');
    const mesh=analyse(parsed.triangles),[x,y,z]=mesh.bounds.map(b=>b[1]-b[0]);
    const issues=[],warnings=[],info=[],minZ=mesh.bounds[2][0];
    if(minZ>.05)warnings.push(`The model is ${fmt(minZ)} above Tinkercad’s workplane (z=0). Move it down to the grid, or use Cura’s “Drop to build plate” tool.`);
    if(minZ<-.05)warnings.push(`The model extends ${fmt(Math.abs(minZ))} below Tinkercad’s workplane (z=0). Check its position or use Cura’s “Drop to build plate” tool.`);
    if(x>limits.x+.01)issues.push(`Width (X) is ${fmt(x)}; the limit is 36 mm. Make the model narrower.`);
    if(y>limits.y+.01)issues.push(`Depth (Y) is ${fmt(y)}; the limit is 36 mm. Make the model shallower.`);
    if(z>limits.z+.01)issues.push(`Height is ${fmt(z)}; the limit is 40 mm. Make the model shorter.`);
    if(mesh.separateSections>1)warnings.push(`The file contains ${mesh.separateSections} separate areas that do not touch. They may print as separate pieces; check the Cura preview.`);
    if(!mesh.flatBase)warnings.push('I couldn’t find a wide, flat bottom face. Check that the model can sit flat on the build plate; rotating it or adding a brim in Cura may help.');
    else if(mesh.baseArea<referenceBaseArea*.8)warnings.push(`The stem’s contact area is smaller than the example (${mesh.baseArea.toFixed(1)} mm² versus about ${referenceBaseArea.toFixed(1)} mm²). A brim may help it stay attached.`);
    else info.push('The stem base matches the example shape. A brim may still help it stay attached while printing.');
    if(mesh.lean>2.4)warnings.push('The model’s shape sits noticeably off-centre over its base. Check that it will stay upright in Cura.');
    if(parsed.format==='ascii'&&!parsed.solidEnded)warnings.push('The file ending looks incomplete. Cura may still open it, but re-export from Tinkercad if Cura shows a problem.');
    const stem=checkSnapStem(parsed.triangles,mesh.bounds);
    if(!stem.ok)issues.push(stem.message);
    else info.push('The split snap stem, collar and shaft match the reference shape.');
    const disk=checkStampDisk(parsed.triangles,mesh.bounds);
    issues.push(...disk.issues);warnings.push(...disk.warnings);info.push(...disk.info);
    if(!warnings.length&&!issues.length)info.push('No issues were found by these checks. Open the file in Cura and review the preview before printing.');
    return {name:file.name,dims:[x,y,z],issues,warnings,info,state:issues.length?'fail':warnings.length?'review':'pass',format:parsed.format};
  }

  function parseSTL(bytes){
    if(bytes.length>=84){
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint32(80,true);
      if(count>0&&84+count*50===bytes.length){
        const triangles=[];let offset=84;
        for(let i=0;i<count;i++,offset+=50){const t=[];for(let j=0;j<3;j++){const p=offset+12+j*12;t.push([view.getFloat32(p,true),view.getFloat32(p+4,true),view.getFloat32(p+8,true)]);}triangles.push(t);}
        if(triangles.every(t=>t.flat().every(Number.isFinite)))return {triangles,format:'binary'};
      }
    }
    const text=new TextDecoder().decode(bytes);
    if(!/^\s*solid(?:\s|$)/i.test(text)||!/\bvertex\s/i.test(text))throw new Error('not a recognised ASCII or binary STL');
    const matches=[...text.matchAll(/\bvertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/gi)];
    if(!matches.length||matches.length%3)throw new Error('incomplete ASCII STL triangle data');
    const triangles=[];
    for(let i=0;i<matches.length;i+=3){const t=matches.slice(i,i+3).map(m=>m.slice(1,4).map(Number));if(t.flat().some(n=>!Number.isFinite(n)))throw new Error('invalid coordinate value');triangles.push(t);}
    return {triangles,format:'ascii',solidEnded:/\bendsolid\b/i.test(text)};
  }

  function analyse(triangles){
    const bounds=[[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]],vertices=[],edgeMap=new Map(),parent=triangles.map((_,i)=>i);
    const key=p=>p.map(n=>Math.round(n*10000)).join(',');
    const find=x=>parent[x]===x?x:(parent[x]=find(parent[x]));
    const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
    triangles.forEach((tri,ti)=>{
      const ids=tri.map(p=>{p.forEach((v,k)=>{bounds[k][0]=Math.min(bounds[k][0],v);bounds[k][1]=Math.max(bounds[k][1],v);});vertices.push(p);return key(p);});
      for(const [u,v] of [[0,1],[1,2],[2,0]]){const e=[ids[u],ids[v]].sort().join('|');if(edgeMap.has(e))join(ti,edgeMap.get(e));else edgeMap.set(e,ti);}
    });
    const parts=new Map();
    triangles.forEach((tri,i)=>{const root=find(i);if(!parts.has(root))parts.set(root,[[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]]);const b=parts.get(root);for(const p of tri)p.forEach((v,k)=>{b[k][0]=Math.min(b[k][0],v);b[k][1]=Math.max(b[k][1],v);});});
    const groups=[...parts.values()],separate=new Set(),gap=Math.max(.05,Math.hypot(...bounds.map(b=>b[1]-b[0]))*1e-4);
    for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++)if(groups[i].some((a,k)=>a[1]+gap<groups[j][k][0]||groups[j][k][1]+gap<a[0])){separate.add(i);separate.add(j);}
    const zMin=bounds[2][0],zSpan=bounds[2][1]-zMin,tolerance=Math.max(1e-5,zSpan*1e-4);let baseArea=0;
    for(const tri of triangles)if(tri.every(p=>Math.abs(p[2]-zMin)<=tolerance)){const [a,b,c]=tri;baseArea+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;}
    const footprint=(bounds[0][1]-bounds[0][0])*(bounds[1][1]-bounds[1][0]);
    const centroid=[0,0,0];vertices.forEach(p=>p.forEach((v,k)=>centroid[k]+=v/vertices.length));
    const center=[(bounds[0][0]+bounds[0][1])/2,(bounds[1][0]+bounds[1][1])/2];
    const denom=Math.max(1e-9,Math.min(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0]));
    return {bounds,separateSections:separate.size,flatBase:baseArea>=Math.max(1e-8,footprint*.002),baseArea,baseRatio:footprint?baseArea/footprint:0,lean:Math.hypot(centroid[0]-center[0],centroid[1]-center[1])/denom};
  }

  function checkSnapStem(triangles,bounds){
    const xyCenter=[(bounds[0][0]+bounds[0][1])/2,(bounds[1][0]+bounds[1][1])/2],snap=Math.max(.0001,Math.hypot(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0])*.00001);
    const sectionAt=z=>sectionContours(triangles,z,snap);
    const extent=loops=>{
      const pts=loops.flatMap(l=>l.points);if(!pts.length)return null;
      const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
      return {xMin:Math.min(...xs),xMax:Math.max(...xs),yMin:Math.min(...ys),yMax:Math.max(...ys),width:Math.max(...xs)-Math.min(...xs),depth:Math.max(...ys)-Math.min(...ys)};
    };
    const collar=[.5,1.0].some(z=>{
      const loops=sectionAt(z),e=extent(loops);
      return loops.length===2&&e&&e.width>=10.4&&e.width<=11.4&&e.depth>=10.1&&e.depth<=11.3&&Math.abs((e.xMin+e.xMax)/2-xyCenter[0])<.3&&Math.abs((e.yMin+e.yMax)/2-xyCenter[1])<.3;
    });
    const shaftLevels=[3,6,7.5],shaftMatches=shaftLevels.filter(z=>{
      const loops=sectionAt(z),e=extent(loops);if(loops.length!==2||!e)return false;
      const sorted=[...loops].sort((a,b)=>a.cx-b.cx),gap=sorted[1].xMin-sorted[0].xMax;
      const avgX=(sorted[0].cx+sorted[1].cx)/2,avgY=(sorted[0].cy+sorted[1].cy)/2;
      return e.width>=9.6&&e.width<=10.4&&e.depth>=9.3&&e.depth<=10.2&&
        sorted.every(l=>l.area>=18&&l.area<=27)&&gap>=1.6&&gap<=2.4&&
        Math.abs(avgX-xyCenter[0])<.3&&Math.abs(avgY-xyCenter[1])<.3;
    }).length;
    if(!collar||shaftMatches<2)return {ok:false,message:'The snap stem does not match the reference shape closely enough. Check its split tip, snap collar and 10 mm shaft in Tinkercad; the cone above the stem may be taller or steeper.'};
    return {ok:true};
  }

  function checkStampDisk(triangles,bounds){
    const issues=[],warnings=[],info=[],topZ=bounds[2][1],center=[(bounds[0][0]+bounds[0][1])/2,(bounds[1][0]+bounds[1][1])/2],snap=Math.max(.0001,Math.hypot(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0])*.00001);
    const checks=[1.25,2.25,3.5].map(offset=>{
      const loops=sectionContours(triangles,topZ-offset,snap).sort((a,b)=>b.area-a.area);
      return loops[0]||null;
    });
    const validSections=checks.filter(Boolean);
    if(validSections.length<2)warnings.push('I couldn’t confirm the round top disk from the STL slices. Check the disk shape in Tinkercad.');
    else{
      const diameters=validSections.map(l=>Math.max(l.width,l.depth)),meanDiameter=diameters.reduce((a,b)=>a+b,0)/diameters.length;
      const circular=validSections.every(l=>l.axisRatio>=.94&&l.circularity>=.9&&Math.abs(l.cx-center[0])<.4&&Math.abs(l.cy-center[1])<.4);
      if(Math.abs(meanDiameter-36)>.5)issues.push(`The top disk is about ${meanDiameter.toFixed(1)} mm across; it should be 36 mm.`);
      else if(circular)info.push('The top disk is circular and about 36 mm across.');
      if(!circular)issues.push('The top disk does not appear to be a centred circle. It should be a 36 mm circular disk.');
    }
    const sideZ=[];
    for(const tri of triangles){
      const [a,b,c]=tri,u=b.map((v,i)=>v-a[i]),v=c.map((q,i)=>q-a[i]);
      const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...normal)||1;
      if(Math.abs(normal[2])/length>.05)continue;
      if(tri.every(p=>{const r=Math.hypot(p[0]-center[0],p[1]-center[1]);return r>=17.85&&r<=18.15;}))tri.forEach(p=>sideZ.push(p[2]));
    }
    if(sideZ.length){
      const thickness=Math.max(...sideZ)-Math.min(...sideZ);
      if(Math.abs(thickness-4)>.25)issues.push(`The top disk’s straight side is about ${thickness.toFixed(2)} mm thick; it should be 4 mm.`);
      else info.push(`Top disk straight sidewall: about ${thickness.toFixed(1)} mm thick.`);
    }else warnings.push('I couldn’t measure the top disk thickness reliably. Check it in Tinkercad.');
    const planes=new Map();
    for(const tri of triangles){
      const [a,b,c]=tri,u=b.map((v,i)=>v-a[i]),v=c.map((q,i)=>q-a[i]);
      const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...normal)||1;
      if(normal[2]/length<.98||Math.max(...tri.map(p=>p[2]))-Math.min(...tri.map(p=>p[2]))>.002)continue;
      const z=(a[2]+b[2]+c[2])/3,cx=(a[0]+b[0]+c[0])/3,cy=(a[1]+b[1]+c[1])/3;
      if(Math.hypot(cx-center[0],cy-center[1])>17.6||z<topZ-4.2)continue;
      const level=Math.round(z*100);planes.set(level,(planes.get(level)||0)+length/2);
    }
    if(planes.size){
      const topPlane=Math.max(...planes.keys())/100,deepestPlane=Math.min(...planes.keys())/100,engravingDepth=topPlane-deepestPlane;
      if(engravingDepth>1.05)issues.push(`The top design is about ${engravingDepth.toFixed(2)} mm deep; engravings must not exceed 1 mm.`);
      else info.push(`Top design depth: about ${engravingDepth.toFixed(2)} mm (maximum 1 mm).`);
    }else warnings.push('I couldn’t measure the depth of the top design reliably. Check it in Tinkercad.');
    return {issues,warnings,info};
  }

  function sectionContours(triangles,z,snap){
    const segments=[];
    for(const tri of triangles){
      const hits=[];
      for(const [i,j] of [[0,1],[1,2],[2,0]]){
        const a=tri[i],b=tri[j];
        if((a[2]<=z&&b[2]>z)||(b[2]<=z&&a[2]>z)){const t=(z-a[2])/(b[2]-a[2]);hits.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
      }
      if(hits.length===2&&Math.hypot(hits[0][0]-hits[1][0],hits[0][1]-hits[1][1])>snap*.25)segments.push(hits);
    }
    const key=p=>`${Math.round(p[0]/snap)},${Math.round(p[1]/snap)}`,nodes=new Map(),edges=[];
    for(const s of segments){const a=key(s[0]),b=key(s[1]);if(a===b)continue;const e=edges.length;edges.push([a,b]);if(!nodes.has(a))nodes.set(a,[]);if(!nodes.has(b))nodes.set(b,[]);nodes.get(a).push(e);nodes.get(b).push(e);}
    const used=new Uint8Array(edges.length),loops=[];
    for(let first=0;first<edges.length;first++){
      if(used[first])continue;const [start,next]=edges[first],path=[start];let at=next,closed=false,guard=0;used[first]=1;
      while(guard++<edges.length+1){path.push(at);if(at===start){closed=true;break;}const e=(nodes.get(at)||[]).find(q=>!used[q]);if(e===undefined)break;used[e]=1;const ends=edges[e];at=ends[0]===at?ends[1]:ends[0];}
      if(closed&&path.length>=8){const points=path.slice(0,-1).map(k=>k.split(',').map(v=>Number(v)*snap)),m=polygonMetrics(points);if(m)loops.push({...m,points});}
    }
    return loops;
  }

  function polygonMetrics(points){
    let twiceArea=0,perimeter=0,cx=0,cy=0;
    for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];twiceArea+=a[0]*b[1]-b[0]*a[1];perimeter+=Math.hypot(b[0]-a[0],b[1]-a[1]);cx+=a[0];cy+=a[1];}
    const area=Math.abs(twiceArea)/2;if(!area||!perimeter)return null;cx/=points.length;cy/=points.length;
    let signedA=0,mx=0,my=0,ix=0,iy=0,ixy=0;
    for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],cross=a[0]*b[1]-b[0]*a[1];signedA+=cross;mx+=(a[0]+b[0])*cross;my+=(a[1]+b[1])*cross;ix+=(a[0]*a[0]+a[0]*b[0]+b[0]*b[0])*cross;iy+=(a[1]*a[1]+a[1]*b[1]+b[1]*b[1])*cross;ixy+=(2*a[0]*a[1]+a[0]*b[1]+b[0]*a[1]+2*b[0]*b[1])*cross;}
    const A=signedA/2,pcx=mx/(6*A),pcy=my/(6*A),xx=Math.abs(ix/(12*A)-pcx*pcx),yy=Math.abs(iy/(12*A)-pcy*pcy),xy=ixy/(24*A)-pcx*pcy;
    const spread=Math.sqrt((xx-yy)**2+4*xy*xy),major=(xx+yy+spread)/2,minor=(xx+yy-spread)/2;
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    return {area,cx:pcx,cy:pcy,xMin:Math.min(...xs),xMax:Math.max(...xs),yMin:Math.min(...ys),yMax:Math.max(...ys),width:Math.max(...xs)-Math.min(...xs),depth:Math.max(...ys)-Math.min(...ys),axisRatio:Math.sqrt(Math.max(0,minor)/Math.max(major,.000001)),circularity:4*Math.PI*area/(perimeter*perimeter)};
  }

  function render(){
    resultsSection.hidden=!reports.length;if(!reports.length)return;
    const count={pass:0,review:0,fail:0};reports.forEach(r=>count[r.state]++);
    summary.innerHTML=`<span class="summary-chip"><b>${reports.length}</b> files checked</span><span class="summary-chip"><b>${count.pass}</b> passed</span><span class="summary-chip"><b>${count.review}</b> check in Cura</span><span class="summary-chip"><b>${count.fail}</b> need fixing</span>`;
    body.innerHTML=sortedReports().map(r=>{
      const pill=r.state==='pass'?'pill-pass':r.state==='fail'?'pill-fail':'pill-review';
      const label=r.state==='pass'?'Passed checks':r.category==='integrity'?'Can’t read file':r.state==='fail'?'Needs fixing':'Check in Cura';
      const details=[...r.issues.map(t=>({t,type:'bad'})),...r.warnings.map(t=>({t,type:'warn'})),...r.info.map(t=>({t,type:'good'}))];
      return `<tr><td title="${esc(r.name)}">${esc(r.name)}</td><td><span class="result-pill ${pill}">${label}</span></td><td class="dimensions">${r.dims?r.dims.map(fmt).join(' × '):'—'}</td><td class="details">${details.map(d=>`<span class="detail ${d.type}"><span class="detail-icon">${d.type==='good'?'✓':d.type==='bad'?'!':'•'}</span>${esc(d.t)}</span>`).join('')}</td></tr>`;
    }).join('');
  }
  function sortedReports(){const p={fail:0,review:1,pass:2};return reports.map((r,i)=>({r,i})).sort((a,b)=>p[a.r.state]-p[b.r.state]||a.i-b.i).map(x=>x.r);}
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function downloadReport(){
    const rows=[['File','Result','Width X (mm)','Depth Y (mm)','Height Z (mm)','Issues','Things to check','Checks passed']];
    sortedReports().forEach(r=>rows.push([r.name,reportLabel(r),...(r.dims||['','','']).map(n=>Number.isFinite(n)?n.toFixed(2):''),r.issues.join(' | '),r.warnings.join(' | '),r.info.join(' | ')]));
    const csv=rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='stamp-check-report.csv';a.click();URL.revokeObjectURL(a.href);
  }
  function reportLabel(r){return r.state==='pass'?'Passed checks':r.category==='integrity'?'Can’t read file':r.state==='fail'?'Needs fixing':'Check in Cura';}
})();
