/* =====================================================================
   EDGES: rendering (MathJax), the live-preview editor (CodeMirror 6),
   the page UI, and the service worker hookup. Storage lives in store.js.
   Depends on core.js and store.js; neither depends on this file.
   ===================================================================== */
"use strict";
const { EditorState, StateField, StateEffect, EditorView, Decoration, WidgetType,
        keymap, showTooltip, history, historyKeymap, defaultKeymap, undo, closeBrackets, closeBracketsKeymap } = CM;
const $ = id => document.getElementById(id);

/* ---------- 1. TeX renderer: source → SVG node, cached ---------- */
const TeX = {
  ready:false, ver:0, preamble:DEFAULT_PREAMBLE, cache:new Map(),
  setPreamble(p){ this.preamble=p; this.cache.clear(); this.ver++ },
  /** @returns {{node: Element|null, err: string}} */
  render(src, display){
    if(!this.ready || !src.trim()) return {node:null, err:''};
    const key=(display?'D':'I')+src;
    let hit=this.cache.get(key);
    if(!hit){
      let node=null, err='';
      try{
        node=MathJax.tex2svg(this.preamble+'\n'+src,{display});
        const e=node.querySelector('[data-mjx-error]'); if(e){ err=e.getAttribute('data-mjx-error')||'TeX error'; node=null }
      }catch(e){ err=String(e.message||e) }
      hit={node,err};
      if(this.cache.size>800) this.cache.clear();
      this.cache.set(key,hit);
    }
    return {node: hit.node && hit.node.cloneNode(true), err: hit.err};
  },
  check(p){
    if(!this.ready) return '';
    try{ const n=MathJax.tex2svg(p,{display:false}); const e=n.querySelector('[data-mjx-error]'); return e?e.getAttribute('data-mjx-error'):'' }
    catch(e){ return String(e.message||e) }
  },
  /** Fill `el` with rendered maths, or the raw source if it can't render yet. */
  fill(el, src, display){
    const r=this.render(src,display);
    if(r.node){ el.append(r.node); return true }
    el.classList.add(r.err?'pt-texerr':'pt-raw'); el.textContent=src; if(r.err) el.title=r.err;
    return false;
  },
  /** Prose with inline maths, for env titles. */
  inline(text, el){
    for(const t of tokenize(text)){
      if(t.t==='text') el.append(t.v);
      else { const s=document.createElement('span'); this.fill(s,t.v,false); el.append(s) }
    }
    return el;
  }
};

/* ---------- 2. Widgets drawn in place of source ---------- */
class MathWidget extends WidgetType {
  constructor(src, display, block, lead, ver){ super(); Object.assign(this,{src,display,block,lead,ver}) }
  eq(o){ return o.src===this.src && o.display===this.display && o.block===this.block && o.ver===this.ver }
  toDOM(view){
    const el=document.createElement(this.block?'div':'span');
    el.className='pt-math'+(this.display?' pt-math-d':'');
    TeX.fill(el,this.src,this.display);
    el.addEventListener('click',()=>{        // a tap puts the caret inside the maths
      const pos=view.posAtDOM(el);
      view.dispatch({selection:{anchor:pos+this.lead}}); view.focus();
    });
    return el;
  }
  ignoreEvent(){ return true }
}
class LabelWidget extends WidgetType {
  constructor(label,title,cls,ver){ super(); Object.assign(this,{label,title,cls,ver}) }
  eq(o){ return o.label===this.label && o.title===this.title && o.ver===this.ver }
  toDOM(){
    const el=document.createElement('span'); el.className='pt-label pt-label-'+this.cls; el.textContent=this.label;
    if(this.title){ const t=document.createElement('span'); t.className='pt-label-title'; t.append(' (');
      TeX.inline(this.title,t); t.append(')'); el.append(t) }
    el.append('. ');
    return el;
  }
}
class TextWidget extends WidgetType {
  constructor(text,cls){ super(); this.text=text; this.cls=cls }
  eq(o){ return o.text===this.text }
  toDOM(){ const el=document.createElement('span'); el.className=this.cls; el.textContent=this.text; return el }
}

/* ---------- 3. Editor state: focus, source mode, decorations, preview bubble ---------- */
const setFocus=StateEffect.define(), setSource=StateEffect.define(), rerender=StateEffect.define();

const focusField=StateField.define({
  create:()=>false,
  update(v,tr){ for(const e of tr.effects) if(e.is(setFocus)) v=e.value; return v }
});
const sourceField=StateField.define({
  create:()=>false,
  update(v,tr){ for(const e of tr.effects) if(e.is(setSource)) v=e.value; return v }
});

/** Everything that turns source into rendered output. Source is revealed wherever the caret touches it. */
function buildDecorations(state){
  if(state.field(sourceField)) return Decoration.none;
  const doc=state.doc, src=doc.toString(), focused=state.field(focusField);
  const touch=(a,b)=>focused && state.selection.ranges.some(r=>r.from<=b && r.to>=a);
  const out=[];
  for(const b of parseBlocks(src)){
    const l1=doc.lineAt(b.start), l2=doc.lineAt(b.end);
    let hidden=[b.start,b.start];          // a replaced prefix; maths inside it is drawn by the label
    if(b.kind==='heading'){
      out.push(Decoration.line({class:'pt-h pt-h'+b.level}).range(l1.from));
      if(!touch(l1.from,l1.to)) out.push(Decoration.replace({}).range(b.start,b.start+b.prefixLen));
    } else if(b.kind==='env'){
      for(let n=l1.number;n<=l2.number;n++){
        const cls='pt-env pt-env-'+b.cls+(n===l1.number?' pt-env-first':'')+(n===l2.number?' pt-env-last':'');
        out.push(Decoration.line({class:cls}).range(doc.line(n).from));
      }
      const pEnd=b.start+b.prefixLen;
      if(!touch(b.start,pEnd)){
        out.push(Decoration.replace({widget:new LabelWidget(b.name+(b.num?' '+b.num:''),b.title,b.cls,TeX.ver)}).range(b.start,pEnd));
        hidden=[b.start,pEnd];
      }
      if(b.cls==='pf') out.push(Decoration.widget({widget:new TextWidget('∎','pt-qed'),side:1}).range(b.end));
    } else if(b.kind==='list'){
      for(let n=l1.number;n<=l2.number;n++){
        const ln=doc.line(n);
        if(/^[-*] /.test(ln.text)) out.push(Decoration.line({class:'pt-li'}).range(ln.from));
        if(/^[-*] /.test(ln.text) && !touch(ln.from,ln.to)) out.push(Decoration.replace({widget:new TextWidget('•','pt-bullet')}).range(ln.from,ln.from+2));
      }
    }
    for(const t of tokenize(b.src,b.start)){
      if(t.t==='text'){
        // **bold**, *italic*, `code`: markers hide unless the caret touches the span, then show dimmed.
        for(const f of formatSpans(t.v,t.from)){
          if(f.from<hidden[1]) continue;
          const a=f.from+f.mark, z=f.to-f.mark, marker=touch(f.from,f.to) ? Decoration.mark({class:'pt-fmt'}) : Decoration.replace({});
          out.push(marker.range(f.from,a), Decoration.mark({class:'pt-'+f.kind}).range(a,z), marker.range(z,f.to));
        }
        continue;
      }
      if(t.from<hidden[1]) continue;
      if(t.open || touch(t.from,t.to)){ if(t.to>t.from) out.push(Decoration.mark({class:'pt-src'}).range(t.from,t.to)); continue }
      const block = t.d && t.from===doc.lineAt(t.from).from && t.to===doc.lineAt(t.to).to;
      out.push(Decoration.replace({widget:new MathWidget(t.v,t.d,block,t.innerFrom-t.from,TeX.ver),block}).range(t.from,t.to));
    }
  }
  return Decoration.set(out,true);
}
const decoField=StateField.define({
  create:buildDecorations,
  update(v,tr){ return (tr.docChanged||tr.selection||tr.effects.length) ? buildDecorations(tr.state) : v },
  provide:f=>EditorView.decorations.from(f)
});

/** While the caret is in maths, show what it will look like just above the line. */
function previewAt(state, prev){
  if(!state.field(focusField) || state.field(sourceField)) return null;
  const sel=state.selection.main; if(!sel.empty) return null;
  const src=state.doc.toString(), pos=sel.head;
  const t=findMath(src).find(t=>t.from<=pos && pos<=t.to && (t.open || pos>t.from));
  if(!t || !t.v.trim()) return null;
  if(prev && prev.pos===t.from && prev.src===t.v && prev.ver===TeX.ver) return prev;
  return { pos:t.from, src:t.v, ver:TeX.ver, above:true, arrow:false,
    create(){ const dom=document.createElement('div'); dom.className='pt-bubble'; TeX.fill(dom,t.v,t.d); return {dom} } };
}
const previewField=StateField.define({
  create:s=>previewAt(s,null),
  update(v,tr){ return (tr.docChanged||tr.selection||tr.effects.length) ? previewAt(tr.state,v) : v },
  provide:f=>showTooltip.from(f)
});

/* ---------- 4. Editing commands: snippets, jump, key row ---------- */
function insertAtCursor(view, text, userEvent='input.key'){
  const {from,to}=view.state.selection.main;
  if(from!==to && text.includes('¦')) text=text.replace('¦', view.state.sliceDoc(from,to)+'¦');   // wrap selection
  const caret=text.indexOf('¦'), clean=text.replace('¦','');
  view.dispatch({changes:{from,to,insert:clean}, selection:{anchor:from+(caret>=0?caret:clean.length)}, userEvent});
  view.focus();
}
function jump(view){
  const p=jumpTarget(view.state.doc.toString(), view.state.selection.main.to);
  view.dispatch({selection:{anchor:p}, scrollIntoView:true}); return true;
}
/** Runs after typing settles; works with phone keyboards that compose words. */
function trySnippet(view){
  if(view.composing) return;
  const sel=view.state.selection.main; if(!sel.empty) return;
  const pos=sel.head, src=view.state.doc.toString();
  const hit=expandSnippet(src.slice(Math.max(0,pos-200),pos), inMathAt(src,pos-1));
  if(!hit) return;
  const caret=hit.ins.indexOf('¦'), clean=hit.ins.replace('¦','');
  view.dispatch({changes:{from:pos-hit.del,to:pos,insert:clean}, selection:{anchor:pos-hit.del+(caret>=0?caret:clean.length)}, userEvent:'input.snippet'});
}
const snippetListener=EditorView.updateListener.of(u=>{
  if(!u.docChanged) return;
  if(!u.transactions.some(tr=>tr.isUserEvent('input.type'))) return;
  let endsAtCaret=false; const head=u.state.selection.main.head;
  u.changes.iterChanges((fA,tA,fB,tB)=>{ if(tB===head && tB>fB) endsAtCaret=true });
  if(endsAtCaret) setTimeout(()=>trySnippet(u.view),0);
});

/* ---------- 5. App ---------- */
const S = { nb:null, cur:null, view:null, greek:false, source:false };
const newId=()=>'n'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const now=()=>Date.now();
const docText=()=>S.view.state.doc.toString();
const sortedNotes=()=>Object.values(S.nb.notes).sort((a,b)=>b.updated-a.updated);

function setStatus(override){ $('status').textContent = override || 'this device' }

const saveListener=EditorView.updateListener.of(u=>{
  if(!u.docChanged) return;
  const n=S.nb.notes[S.cur]; if(!n) return;
  n.body=u.state.doc.toString(); n.updated=now(); Store.putNote(n);
  $('noteTitle').textContent=titleOf(n.body);
});

function makeState(body){
  return EditorState.create({doc:body, extensions:[
    history(), closeBrackets(),
    EditorState.languageData.of(()=>[{closeBrackets:{brackets:['(','[','{']}}]),
    keymap.of([{key:'Tab',run:jump}, ...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({autocorrect:'off',autocapitalize:'off',spellcheck:'false','aria-label':'Note'}),
    EditorView.focusChangeEffect.of((_,f)=>setFocus.of(f)),
    focusField.init(()=>S.view?S.view.hasFocus:false), sourceField.init(()=>S.source),
    decoField, previewField, snippetListener, saveListener,
  ]});
}

function openNote(id){
  S.cur=id; S.nb.last=id; Store.setMeta({last:id});
  S.view.setState(makeState(S.nb.notes[id].body));
  $('noteTitle').textContent=titleOf(S.nb.notes[id].body);
  closeAll();
}
function createNote(body=''){
  const id=newId(); S.nb.notes[id]={id,body,created:now(),updated:now()};
  Store.putNote(S.nb.notes[id]); openNote(id);
  if(!body) S.view.focus();
}
function rerenderAll(){ if(S.view) S.view.dispatch({effects:rerender.of(null)}) }

/* ---------- 6. Key row (pointerdown + preventDefault keeps the phone keyboard open) ---------- */
const KEYS = [
  {l:'⇥', cls:'prime', run:v=>jump(v), t:'Jump to next slot'},
  {l:'$', run:v=>insertAtCursor(v, inMathAt(v.state.doc.toString(), v.state.selection.main.head) ? '$' : '$¦$')},
  {l:'\\', ins:'\\'}, {l:'{ }', ins:'{¦}'}, {l:'^', ins:'^{¦}'}, {l:'_', ins:'_{¦}'},
  {l:'a⁄b', ins:'\\frac{¦}{}'}, {l:'√', ins:'\\sqrt{¦}'}, {l:'( )', ins:'(¦)'}, {l:'=', ins:'='}, {l:'&', ins:'&'},
  {l:'\\\\', ins:' \\\\\n'}, {l:'αβγ', cls:'mode', run:()=>{ S.greek=true; drawKeys() }, t:'Greek letters'},
  {l:'∑', ins:'\\sum_{¦}^{}'}, {l:'∫', ins:'\\int_{¦}^{} '}, {l:'lim', ins:'\\lim_{¦ \\to \\infty}'},
  {l:'→', ins:'\\to '}, {l:'≤', ins:'\\le '}, {l:'≥', ins:'\\ge '}, {l:'≠', ins:'\\neq '}, {l:'∈', ins:'\\in '},
  {l:'⊆', ins:'\\subseteq '}, {l:'∀', ins:'\\forall '}, {l:'∃', ins:'\\exists '}, {l:'∞', ins:'\\infty'},
  {l:'ℝ', ins:'\\R'}, {l:'ℕ', ins:'\\N'}, {l:'ℤ', ins:'\\Z'},
  {l:'↶', cls:'mode', run:v=>undo(v), t:'Undo'},
];
const GREEK_KEYS = [{l:'abc', cls:'mode', run:()=>{ S.greek=false; drawKeys() }, t:'Back to symbols'}].concat(
  Object.entries({α:'alpha',β:'beta',γ:'gamma',δ:'delta',ε:'varepsilon',θ:'theta',λ:'lambda',μ:'mu',π:'pi',σ:'sigma',
    φ:'varphi',ω:'omega',Δ:'Delta',Σ:'Sigma',Ω:'Omega',Φ:'Phi',ξ:'xi',ρ:'rho',τ:'tau',χ:'chi',ψ:'psi',η:'eta',κ:'kappa',ζ:'zeta'})
    .map(([l,c])=>({l, ins:'\\'+c+' '})));
// Digits count as typing, so snippets still fire: x then 1 gives x_1.
const NUM_KEYS = [...'1234567890'].map(d=>({l:d, run:v=>insertAtCursor(v,d,'input.type')}));
function drawKeys(){
  drawRow($('nums'), NUM_KEYS);
  drawRow($('keys'), S.greek?GREEK_KEYS:KEYS);
}
function drawRow(row, keys){
  row.replaceChildren();
  for(const k of keys){
    const b=document.createElement('button'); b.type='button'; b.className='key'+(k.cls?' '+k.cls:''); b.textContent=k.l;
    b.setAttribute('aria-label',k.t||k.ins||k.l); if(k.t) b.title=k.t;
    const press=()=>{ k.run ? k.run(S.view) : insertAtCursor(S.view,k.ins) };
    b.addEventListener('pointerdown',e=>{ e.preventDefault(); press() });
    b.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); press() } });
    row.append(b);
  }
}

/* ---------- 7. Drawer, sheets, export, backup ---------- */
function renderNoteList(){
  const ul=$('notes'); ul.replaceChildren();
  for(const n of sortedNotes()){
    const li=document.createElement('li'); if(n.id===S.cur) li.className='cur';
    const open=document.createElement('button'); open.className='open';
    const t=document.createElement('span'); t.textContent=titleOf(n.body);
    const d=document.createElement('small'); d.textContent=new Date(n.updated).toLocaleString([],{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    open.append(t,d); open.onclick=()=>openNote(n.id);
    const del=document.createElement('button'); del.className='del'; del.textContent='Delete';
    del.onclick=()=>{
      if(!del.classList.contains('armed')){ del.classList.add('armed'); del.textContent='Sure?'; setTimeout(()=>{del.classList.remove('armed');del.textContent='Delete'},3000); return }
      delete S.nb.notes[n.id]; Store.deleteNote(n.id);
      if(!Object.keys(S.nb.notes).length) createNote(''); else if(n.id===S.cur) openNote(sortedNotes()[0].id);
      renderNoteList();
    };
    li.append(open,del); ul.append(li);
  }
}
/** Number row: auto (CSS decides from the pointer) until the user picks, then 'show' or 'hide' on this device. */
const numsShown=()=>getComputedStyle($('nums')).display!=='none';
function setNums(mode){ $('nums').dataset.mode=mode||''; $('numsBtn').textContent=numsShown()?'Hide numbers':'Show numbers' }
function openDrawer(){ renderNoteList(); setStatus(); setNums(S.nb.nums); $('drawer').hidden=false; $('scrim').hidden=false }
function openSheet(id){ $('drawer').hidden=true; $('scrim').hidden=false; $(id).hidden=false }
function closeAll(){ document.querySelectorAll('.sheet').forEach(s=>s.hidden=true); $('drawer').hidden=true; $('scrim').hidden=true }
function toast(msg){ const t=$('toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast.h); toast.h=setTimeout(()=>t.hidden=true,2200) }

function drawCheat(){
  const rows=[['Text',null], ...SNIPPETS.filter(s=>s.mode==='t').map(s=>[s.k,s.info]),
    ['Inside maths',null], ['x1','x_1 (x12 → x_{12})'], ['xbar','\\overline{x} (also hat, vec, dot, til)'],
    [';a','α (;b β, ;t θ, ;l λ, ;e ε, ;p π, ;s σ, ;o ω; capitals give Γ Δ Σ Ω …)'],
    ...SNIPPETS.filter(s=>s.mode==='m'&&!s.hide).reverse().map(s=>[s.show||s.k,s.info]),
    ['Blocks',null], ['# / ##','section / subsection'], ['def:','Definition (also thm: lem: prop: cor: ex: q:)'],
    ['def: [Name]','titled environment'], ['pf:','Proof with ∎ (also sol: rmk:)'], ['- item','bullet list'],
    ['blank line','new block'], ['⇥ or Tab','jump to the next {} or past $'], ['</>','show all source']];
  const tb=$('cheatTable'); tb.replaceChildren();
  for(const [k,v] of rows){
    const tr=document.createElement('tr');
    if(v===null){ const th=document.createElement('th'); th.colSpan=2; th.textContent=k; tr.append(th) }
    else{ const a=document.createElement('td'), b=document.createElement('td'); a.textContent=k; b.textContent=v; tr.append(a,b) }
    tb.append(tr);
  }
}

/** Keep the key row sitting on top of the on-screen keyboard. */
function fitViewport(){
  const vv=window.visualViewport, app=$('app');
  if(!vv){ app.style.height='100%'; return }
  app.style.height=vv.height+'px'; app.style.transform='translateY('+vv.offsetTop+'px)';
}

/** Save text as a file through the browser's normal download. */
function download(name, text, type){
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name;
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),10000);
}

function importBackup(data){
  const {notes,book}=mergeBackup(S.nb,data);
  for(const n of notes){ S.nb.notes[n.id]=n; Store.putNote(n) }
  if(book){ Object.assign(S.nb,book); Store.setMeta(book); TeX.setPreamble(book.preamble); rerenderAll() }
  if(notes.some(n=>n.id===S.cur)) openNote(S.cur); else renderNoteList();
  toast(notes.length ? 'Imported '+notes.length+(notes.length>1?' notes':' note') : 'No newer notes in that file');
}

function wireUI(){
  $('menuBtn').onclick=openDrawer;
  $('scrim').onclick=closeAll;
  $('newBtn').onclick=()=>createNote('');
  $('srcBtn').onclick=()=>{
    S.source=!S.source; $('srcBtn').setAttribute('aria-pressed',S.source);
    S.view.dispatch({effects:setSource.of(S.source)});
  };
  $('macrosBtn').onclick=()=>{ $('preambleInput').value=S.nb.preamble; $('preambleErr').textContent=''; openSheet('macroSheet') };
  $('cheatBtn').onclick=()=>openSheet('cheatSheet');
  $('numsBtn').onclick=()=>{ S.nb.nums=numsShown()?'hide':'show'; Store.setMeta({nums:S.nb.nums}); setNums(S.nb.nums) };
  for(const id of ['macroDone','cheatDone','texDone']) $(id).onclick=()=>{ closeAll(); S.view.focus() };

  let t;
  $('preambleInput').addEventListener('input',()=>{
    clearTimeout(t);
    t=setTimeout(()=>{
      const p=$('preambleInput').value, err=TeX.check(p);
      $('preambleErr').textContent = err ? 'Not applied yet: '+err : 'Applied.';
      $('preambleErr').classList.toggle('bad',!!err);
      if(err) return;
      S.nb.preamble=p; S.nb.preambleUpdated=now(); Store.setMeta({preamble:p,preambleUpdated:S.nb.preambleUpdated});
      TeX.setPreamble(p); rerenderAll();
    },500);
  });

  $('copyTexBtn').onclick=()=>{
    const tex=toLatex(docText(),S.nb.preamble);
    const fallback=()=>{ $('texOut').value=tex; openSheet('texSheet'); $('texOut').select() };
    try{ navigator.clipboard.writeText(tex).then(()=>{ closeAll(); toast('LaTeX copied') }, fallback) }catch{ fallback() }
  };
  $('saveTexBtn').onclick=()=>{
    const name=titleOf(docText()).replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-').toLowerCase()||'note';
    download(name+'.tex', toLatex(docText(),S.nb.preamble), 'application/x-tex'); closeAll();
  };
  $('exportBtn').onclick=()=>{
    const data={app:'quicktex', version:1, exported:new Date().toISOString(),
      preamble:S.nb.preamble, preambleUpdated:S.nb.preambleUpdated||0, notes:sortedNotes()};
    download('quicktex-notes-'+new Date().toISOString().slice(0,10)+'.json', JSON.stringify(data,null,1), 'application/json'); closeAll();
  };
  $('importBtn').onclick=()=>$('importFile').click();
  $('importFile').onchange=async e=>{
    const f=e.target.files[0]; e.target.value=''; if(!f) return;
    let data; try{ data=JSON.parse(await f.text()) }catch{ toast("That isn't a QuickTeX backup"); return }
    importBackup(data);
  };
  if(window.visualViewport){ visualViewport.addEventListener('resize',fitViewport); visualViewport.addEventListener('scroll',fitViewport) }
}

/* ---------- 8. Offline: service worker, plus a prompt when a new version is waiting ---------- */
function registerWorker(){
  if(!('serviceWorker' in navigator)) return;
  let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{ if(reloading) location.reload() });
  navigator.serviceWorker.register('sw.js').then(reg=>{
    const offer=w=>{ const b=$('updateBtn'); b.hidden=false; b.onclick=()=>{ reloading=true; b.hidden=true; w.postMessage('skipWaiting') } };
    if(reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound',()=>{
      const w=reg.installing;
      w.addEventListener('statechange',()=>{ if(w.state==='installed' && navigator.serviceWorker.controller) offer(w) });
    });
    // An installed app resumes rather than reloads, so look for a new version whenever it comes back.
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden) reg.update().catch(()=>{}) });
  },()=>{});
}

/* ---------- 9. Boot ---------- */
(async function boot(){
  const onMathJax=()=>{
    if(TeX.ready) return;
    TeX.ready=true;
    try{ document.head.appendChild(MathJax.svgStylesheet()) }catch{}
    TeX.cache.clear(); TeX.ver++; rerenderAll();
  };
  window.__onMathJax=onMathJax;
  if(window.MathJax && MathJax.tex2svg) onMathJax();
  registerWorker();

  Store.onError=()=>setStatus('not saved');
  try{ S.nb=await Store.open() }
  catch{ S.nb={notes:{}}; setStatus('not saved') }   // e.g. storage blocked: still usable, nothing kept
  if(!S.nb.preamble) S.nb.preamble=DEFAULT_PREAMBLE;
  TeX.setPreamble(S.nb.preamble);
  if(!Object.keys(S.nb.notes).length){
    const id=newId(); S.nb.notes[id]={id,body:WELCOME,created:now(),updated:now()}; Store.putNote(S.nb.notes[id]);
  }
  S.view=new EditorView({parent:$('ed')});
  drawKeys(); drawCheat(); wireUI(); setNums(S.nb.nums); fitViewport();
  openNote(S.nb.notes[S.nb.last] ? S.nb.last : sortedNotes()[0].id);
  if($('status').textContent==='loading') setStatus();
})();
