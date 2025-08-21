import React, { useEffect, useMemo, useRef, useState } from "react";

// ===== Utility =====
function randSeeded(seed:number){
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2**32;
}

type Node = {
  id: number;
  name: string;
  parentId: number | null;
  level: string;
  value: number; // 金額指標（用於高業績判定）
  depth: number;
  x: number;
  y: number;
  hasChildren: boolean;
};

// 格式化數字簡寫
function fmt(v:number){
  const a = Math.abs(v);
  if(a>=1e9) return (v/1e9).toFixed(1)+"B";
  if(a>=1e6) return (v/1e6).toFixed(1)+"M";
  if(a>=1e3) return (v/1e3).toFixed(1)+"k";
  return String(v|0);
}

// 百分位
function percentile(values:number[], p:number){
  if(values.length===0) return 0;
  const sorted = [...values].sort((a,b)=>a-b);
  const idx = Math.min(sorted.length-1, Math.max(0, Math.floor((p/100)*sorted.length)));
  return sorted[idx];
}

// ===== Data generation & layout =====
function generateTree(total:number, maxChildren=4, seed=42){
  const rnd = randSeeded(seed);
  const nodes:Node[] = [];
  // 建立 root
  nodes.push({id:1,name:"ROOT",parentId:null,level:"A",value:0,depth:0,x:0,y:0,hasChildren:true});

  // 追蹤每個節點的子數，控制不超過 maxChildren（大多數情況）
  const childCount = new Map<number, number>();
  childCount.set(1, 0);

  function pickParentId(limitTries=8){
    let pid = 1;
    for(let t=0;t<limitTries;t++){
      const r = rnd();
      const biased = 1 + Math.floor(Math.pow(r, 1.2) * (nodes.length));
      pid = Math.max(1, Math.min(nodes.length, biased));
      if((childCount.get(pid)||0) < maxChildren) break;
    }
    childCount.set(pid, (childCount.get(pid)||0)+1);
    return pid;
  }

  // 生成到精確的 total
  for(let id=2; id<=total; id++){
    const pid = pickParentId();
    const level = (rnd()<0.15?"S": rnd()<0.4?"A": rnd()<0.7?"B":"C");
    const value = Math.floor((rnd()**0.3) * 200000);
    nodes.push({id, name:`M${id.toString().padStart(5,'0')}`, parentId:pid, level, value, depth:0, x:0, y:0, hasChildren:true});
  }

  // ===== 正確計算 depth：自 root 起 BFS 設定層級 =====
  const byId = new Map(nodes.map(n=>[n.id,n] as const));
  const childrenMap = new Map<number, number[]>();
  for(const n of nodes){
    if(n.parentId!=null){
      if(!childrenMap.has(n.parentId)) childrenMap.set(n.parentId, []);
      childrenMap.get(n.parentId)!.push(n.id);
    }
  }
  nodes[0].depth = 0; // root
  const q:number[] = [1];
  while(q.length){
    const pid = q.shift()!;
    const kids = childrenMap.get(pid) || [];
    for(const cid of kids){
      const p = byId.get(pid)!; const c = byId.get(cid)!;
      c.depth = p.depth + 1; q.push(cid);
    }
  }

  // 層次式布局：按 depth 分層，水平均分
  const layers = new Map<number, Node[]>();
  for(const n of nodes){
    if(!layers.has(n.depth)) layers.set(n.depth, []);
    layers.get(n.depth)!.push(n);
  }
  const rowGap = 120; // 垂直距離
  const colGapBase = 60; // 最小水平距離
  for(const [d, arr] of layers){
    const n = arr.length;
    const width = Math.max(n*colGapBase, 1200);
    for(let i=0;i<n;i++){
      const x = (i+0.5)*(width/n) - width/2;
      const y = d * rowGap;
      arr[i].x = x; arr[i].y = y;
    }
  }

  // 標註 hasChildren
  const hasChild = new Set(nodes.filter(n=>n.parentId!==null).map(n=>n.parentId as number));
  for(const n of nodes){ n.hasChildren = hasChild.has(n.id); }
  return nodes;
}

// 建索引
function indexByParent(nodes:Node[]){
  const children = new Map<number, Node[]>();
  for(const n of nodes){
    if(n.parentId==null) continue;
    if(!children.has(n.parentId)) children.set(n.parentId, []);
    children.get(n.parentId)!.push(n);
  }
  return children;
}

// ===== Canvas component =====
export default function OrgChartCanvas(){
  const [count, setCount] = useState(5000); // 預設 5k
  const [maxDepth, setMaxDepth] = useState(6);
  const [seed, setSeed] = useState(42);
  const [showEdges, setShowEdges] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [lod, setLod] = useState(true); // Level of Detail 切換

  const nodes = useMemo(()=> generateTree(count, 4, seed), [count, seed]);
  const childrenIndex = useMemo(()=> indexByParent(nodes), [nodes]);
  const nodesById = useMemo(()=> new Map(nodes.map(n=>[n.id, n] as const)), [nodes]);

  // 高業績門檻（p90）
  const p90 = useMemo(()=> percentile(nodes.map(n=>n.value), 90), [nodes]);
  const amtMax = useMemo(()=> nodes.reduce((m,n)=> n.value>m? n.value:m, 0), [nodes]);
  const [minAmt, setMinAmt] = useState(0);
  useEffect(()=>{ if(minAmt>amtMax) setMinAmt(amtMax); }, [amtMax]);

  const canvasRef = useRef<HTMLCanvasElement|null>(null);

  // 抑制拖曳/縮放結束時誤觸 click
  const suppressClickRef = useRef(false);
  const zoomingRef = useRef(false);
  const downRef = useRef<{x:number,y:number}>({x:0,y:0});

  // 互動與渲染使用的變換值使用 ref，避免拖曳時造成 React 重渲染
  const transform = useRef({ scale: 0.6, tx: 0, ty: 80 });
  // 僅用於 UI 顯示的數值（節流更新）
  const [uiScale, setUiScale] = useState(0.6);
  const [uiTx, setUiTx] = useState(0);
  const [uiTy, setUiTy] = useState(80);

  // 折疊狀態
  const [collapsed, setCollapsed] = useState<Set<number>>(()=> new Set());

  // 搜尋
  const [query, setQuery] = useState("");

  // FPS 與統計（節流）
  const fpsRef = useRef({ then: performance.now(), frames:0, fps:60, uiThen: performance.now() });
  const [fps, setFps] = useState(60);
  const [drawStats, setDrawStats] = useState({ nodes:0, edges:0 });

  // 轉換工具
  function worldToScreen(wx:number, wy:number){
    const t = transform.current; return { x: wx*t.scale + t.tx, y: wy*t.scale + t.ty };
  }
  function screenToWorld(sx:number, sy:number){
    const t = transform.current; return { x: (sx - t.tx)/t.scale, y: (sy - t.ty)/t.scale };
  }

  function isVisible(n:Node){
    if(n.depth>maxDepth) return false;
    if(n.value < minAmt) return false;
    let cur = n;
    for(let i=0;i<maxDepth;i++){
      if(cur.parentId==null) break;
      if(collapsed.has(cur.parentId)) return false;
      cur = nodesById.get(cur.parentId)!;
    }
    return true;
  }

  // 畫布尺寸 & DPR
  useEffect(()=>{
    const c = canvasRef.current!;
    function onResize(){
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      c.width = Math.floor(c.clientWidth * dpr);
      c.height = Math.floor(c.clientHeight * dpr);
      const ctx = c.getContext('2d')!; ctx.setTransform(dpr,0,0,dpr,0,0);
      requestDraw();
    }
    onResize();
    window.addEventListener('resize', onResize);
    return ()=> window.removeEventListener('resize', onResize);
  },[]);

  // 拖曳與縮放（只掛一次，不隨狀態改綁）
  useEffect(()=>{
    const c = canvasRef.current!;
    let dragging=false; let lastX=0, lastY=0;

    function onPointerDown(e:PointerEvent){
      dragging = true; lastX = e.clientX; lastY = e.clientY; c.setPointerCapture(e.pointerId);
      downRef.current = { x: e.clientX, y: e.clientY };
      suppressClickRef.current = false;
      c.style.cursor = 'grabbing';
    }
    function onPointerMove(e:PointerEvent){
      if(dragging){
        const dx = e.clientX - lastX; const dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        const dist = Math.hypot(e.clientX - downRef.current.x, e.clientY - downRef.current.y);
        if(dist > 5) suppressClickRef.current = true;
        transform.current.tx += dx; transform.current.ty += dy;
        requestDraw();
      }
    }
    function onPointerUp(e:PointerEvent){ dragging=false; c.releasePointerCapture(e.pointerId); c.style.cursor='grab'; }

    function onWheelPointer(e:PointerEvent){ /* noop */ }

    function onWheel(e:WheelEvent){
      e.preventDefault();
      zoomingRef.current = true; // 短暫標記縮放中，避免隨後 click 誤觸
      suppressClickRef.current = true;
      setTimeout(()=>{ zoomingRef.current = false; }, 350);
      const delta = -e.deltaY; // 向上放大
      const factor = Math.exp(delta*0.001);
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
      const before = screenToWorld(mx, my);
      const t = transform.current;
      const ns = Math.max(0.1, Math.min(3, t.scale*factor));
      t.tx += mx - before.x*ns - t.tx; // 以滑鼠為錨
      t.ty += my - before.y*ns - t.ty;
      t.scale = ns;
      requestDraw();
    }

    c.style.cursor = 'grab';
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    c.addEventListener('wheel', onWheel, { passive:false });
    return ()=>{
      c.removeEventListener('pointerdown', onPointerDown);
      c.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      c.removeEventListener('wheel', onWheel as any);
    }
  },[]);

  // 點擊（折疊/展開）
  useEffect(()=>{
    const c = canvasRef.current!;
    function onClick(e:MouseEvent){
      if(suppressClickRef.current || zoomingRef.current){
        suppressClickRef.current = false; // 僅忽略一次
        return;
      }
      const rect = c.getBoundingClientRect();
      const {x:wx,y:wy} = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const r = 8/transform.current.scale;
      let hit:Node|undefined;
      for(const n of nodes){
        if(!isVisible(n)) continue;
        const dx = n.x - wx; const dy = n.y - wy;
        if(dx*dx+dy*dy <= r*r){ hit = n; break; }
      }
      if(hit){
        setCollapsed(prev=>{ const next = new Set(prev); next.has(hit!.id)? next.delete(hit!.id): next.add(hit!.id); return next; });
        requestDraw();
      }
    }
    c.addEventListener('click', onClick);
    return ()=> c.removeEventListener('click', onClick);
  },[nodes, maxDepth, collapsed]);

  // 搜尋並定位
  function focusOnFirstMatch(){
    const q = query.trim().toLowerCase(); if(!q) return;
    const n = nodes.find(n=> n.name.toLowerCase().includes(q) || String(n.id)===q);
    if(!n) return;
    const c = canvasRef.current!; const rect = c.getBoundingClientRect();
    const targetScale = Math.max(0.6, transform.current.scale);
    transform.current.scale = targetScale;
    transform.current.tx = rect.width/2 - n.x*targetScale;
    transform.current.ty = rect.height/4 - n.y*targetScale;
    requestDraw();
  }

  // 擬合視圖到內容（深度限制下的節點範圍）
  function fitToContent(padPx=40){
    const c = canvasRef.current!; if(!c) return;
    const rect = c.getBoundingClientRect();
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity; let any=false;
    for(const n of nodes){
      if(!isVisible(n)) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); any=true;
    }
    if(!any){ requestDraw(); return; }
    const w = Math.max(1, maxX-minX), h = Math.max(1, maxY-minY);
    const sx = (rect.width - padPx*2) / w;
    const sy = (rect.height - padPx*2) / h;
    const s = Math.max(0.1, Math.min(2.5, Math.min(sx, sy)));
    transform.current.scale = s;
    transform.current.tx = rect.width/2 - (minX+maxX)/2*s;
    transform.current.ty = rect.height/2 - (minY+maxY)/2*s;
    requestDraw();
  }

  // 初始擬合 + 節點數或深度變更後擬合
  useEffect(()=>{ fitToContent(60); },[nodes, maxDepth]);

  // 繪製
  const drawReq = useRef<number|undefined>(undefined);
  const drawRef = useRef<() => void>(()=>{});
  function requestDraw(){
    if(drawReq.current) cancelAnimationFrame(drawReq.current);
    drawReq.current = requestAnimationFrame(()=>drawRef.current());
  }

  function draw(){
    const c = canvasRef.current!; const ctx = c.getContext('2d')!;
    const t = transform.current;
    ctx.save();
    ctx.clearRect(0,0,c.clientWidth,c.clientHeight);

    // 背景網格
    ctx.globalAlpha = 0.06;
    for(let x= (t.tx%40); x<c.clientWidth; x+=40){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,c.clientHeight); ctx.stroke(); }
    for(let y= (t.ty%40); y<c.clientHeight; y+=40){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(c.clientWidth,y); ctx.stroke(); }
    ctx.globalAlpha = 1;

    // 世界轉換
    ctx.translate(t.tx, t.ty);
    ctx.scale(t.scale, t.scale);

    // 可視範圍（世界座標）
    const wMin = screenToWorld(0,0); const wMax = screenToWorld(c.clientWidth, c.clientHeight);
    const pad = 40/t.scale;
    const x0 = wMin.x - pad, x1 = wMax.x + pad, y0 = wMin.y - pad, y1 = wMax.y + pad;

    let nodesDrawn=0, edgesDrawn=0;

    // LOD：低縮放時畫聚類（depth 1 匯總）
    if(lod && t.scale < 0.35){
      const groups = new Map<number, {x:number,y:number,count:number,sum:number}>();
      for(const n of nodes){
        if(n.depth!==1) continue;
        if(n.x<x0||n.x>x1||n.y<y0||n.y>y1) continue;
        { const kids = (childrenIndex.get(n.id) || []).filter(cc=> cc.value>=minAmt);
        const sum = kids.reduce((s,cc)=>s+cc.value,0);
        groups.set(n.id, {x:n.x, y:n.y, count: kids.length, sum}); }
      }
      ctx.font = `${12/t.scale}px ui-sans-serif`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      for(const [id,g] of groups){
        const r = Math.max(10, Math.log2(1+g.count)*6);
        ctx.beginPath(); ctx.arc(g.x, g.y, r, 0, Math.PI*2); ctx.fillStyle = '#e6f0ff'; ctx.fill();
        ctx.lineWidth = 1/t.scale; ctx.strokeStyle='#6aa0ff'; ctx.stroke();
        ctx.fillStyle = '#334155'; ctx.fillText(`${g.count} 節點 / $${fmt(g.sum)}`, g.x, g.y);
        nodesDrawn++;
      }
    } else {
      // 邊
      if(showEdges && t.scale>=0.15){
        ctx.lineWidth = Math.max(0.5/t.scale, 0.5);
        ctx.strokeStyle = '#cbd5e1';
        ctx.beginPath();
        for(const n of nodes){
          if(!isVisible(n)) continue;
          if(n.parentId==null) continue;
          const p = nodesById.get(n.parentId)!;
          if((n.x<x0&&p.x<x0)||(n.x>x1&&p.x>x1)||(n.y<y0&&p.y<y0)||(n.y>y1&&p.y>y1)) continue;
          ctx.moveTo(p.x, p.y); ctx.lineTo(n.x, n.y); edgesDrawn++;
        }
        ctx.stroke();
      }
      // 節點
      ctx.textAlign='left'; ctx.textBaseline='top';
      for(const n of nodes){
        if(!isVisible(n)) continue;
        if(n.x<x0||n.x>x1||n.y<y0||n.y>y1) continue;
        const r = 5;
        let fill = '#e2e8f0';
        if(n.level==='S') fill = '#fde68a'; else if(n.level==='A') fill = '#a7f3d0'; else if(n.level==='B') fill = '#bfdbfe'; else fill = '#e5e7eb';
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2); ctx.fillStyle = fill; ctx.fill();
        if(n.value>=p90){ ctx.lineWidth = Math.max(2/t.scale,1); ctx.strokeStyle='#eab308'; ctx.stroke(); }
        else { ctx.lineWidth = Math.max(1/t.scale, 0.5); ctx.strokeStyle='#64748b'; ctx.stroke(); }
        nodesDrawn++;
        if(showLabels && t.scale>1.0){
          ctx.font = `${12/t.scale}px ui-sans-serif`;
          ctx.fillStyle = '#334155';
          ctx.fillText(`${n.name} $${fmt(n.value)}`, n.x + 8/t.scale, n.y + 8/t.scale);
        }
      }
    }

    ctx.restore();

    // FPS 與 UI 節流更新
    const now = performance.now();
    const f = fpsRef.current; f.frames++;
    if(now - f.then >= 500){ f.fps = Math.round((f.frames*1000)/(now - f.then)); f.then = now; f.frames=0; }
    if(now - f.uiThen >= 250){
      setFps(f.fps); setDrawStats({ nodes: nodesDrawn, edges: edgesDrawn });
      setUiScale(transform.current.scale); setUiTx(transform.current.tx); setUiTy(transform.current.ty);
      f.uiThen = now;
    }
  }

  // 讓事件處理器始終渲染最新一版 draw
  useEffect(()=>{ drawRef.current = draw; });

  // 任一條件變更時請求重畫
  useEffect(()=>{ requestDraw(); },[nodes, maxDepth, showEdges, showLabels, lod, collapsed]);

  function resetView(){ fitToContent(60); }

  return (
    <div style={{width:'100%', height:'100vh', minHeight:460, padding:12, display:'flex', flexDirection:'column', gap:12}}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">節點數</label>
          <input type="range" min={1000} max={15000} step={500} value={count} onChange={e=>setCount(parseInt(e.target.value))} />
          <span className="text-sm tabular-nums w-16 text-right">{count}</span>
          <button className="px-2 py-1 rounded bg-slate-800 text-white text-sm" onClick={()=>setSeed(s=>s+1)}>重生</button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">深度限制</label>
          <input type="range" min={1} max={15} value={maxDepth} onChange={e=>setMaxDepth(parseInt(e.target.value))} />
          <span className="text-sm w-6 text-right">{maxDepth}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">LOD</label>
          <input type="checkbox" checked={lod} onChange={e=>setLod(e.target.checked)} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">邊線</label>
          <input type="checkbox" checked={showEdges} onChange={e=>setShowEdges(e.target.checked)} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">標籤</label>
          <input type="checkbox" checked={showLabels} onChange={e=>setShowLabels(e.target.checked)} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">金額下限</label>
          <input type="range" min={0} max={amtMax||0} step={Math.max(1, Math.round((amtMax||1)/100))} value={minAmt} onChange={e=>setMinAmt(parseInt(e.target.value))} />
          <span className="text-sm tabular-nums w-20 text-right">${fmt(minAmt)}</span>
        </div>
        <button className="px-2 py-1 rounded bg-white border text-sm" onClick={resetView}>重置視圖</button>
        <div className="flex items-center gap-2 ml-2">
          <input className="px-2 py-1 border rounded text-sm" placeholder="搜尋 ID 或名稱" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') focusOnFirstMatch(); }} />
          <button className="px-2 py-1 rounded bg-sky-600 text-white text-sm" onClick={focusOnFirstMatch}>定位</button>
        </div>
        <div className="ml-auto flex items-center gap-4 text-sm text-slate-600">
          <span>Total: <b className="tabular-nums">{nodes.length}</b></span>
          <span>FPS: <b className="tabular-nums">{fps}</b></span>
          <span>Drawn: <b className="tabular-nums">{drawStats.nodes}</b> 節點 / <b className="tabular-nums">{drawStats.edges}</b> 邊</span>
          <span>Scale: <b className="tabular-nums">{uiScale.toFixed(2)}</b></span>
        </div>
      </div>
      <div style={{position:'relative', flex:1, border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', background:'#fff'}}>
        {lod && uiScale < 0.35 && (
          <div className="absolute top-2 left-2 text-xs text-slate-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
            LOD 聚類顯示中（放大以顯示細節）
          </div>
        )}
        <canvas ref={canvasRef} style={{width:'100%', height:'100%', display:'block'}} />
        <div className="absolute bottom-2 left-2 text-xs text-slate-600 bg-white/80 backdrop-blur-sm px-2 py-1 rounded shadow">
          左鍵拖曳移動，滾輪縮放；點擊節點切換展開/折疊。縮放 &lt; 0.35 時啟用聚類泡泡。
        </div>
      </div>
    </div>
  );
}

//export default OrgChartCanvas;
