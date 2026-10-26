/* =====================================================================
   CORE: pure functions over note text. No DOM, no editor, no storage.
   Model:
     Note     { id, body, created, updated }    title is derived from body
     Notebook { notes: {id: Note}, preamble, preambleUpdated, last }
     Block    { start, end, src, kind, ... }    a blank-line-separated chunk
     Token    { t:'text'|'math', from, to, ... } positions are absolute
   ===================================================================== */
"use strict";

const DEFAULT_PREAMBLE = String.raw`\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\Z}{\mathbb{Z}}
\newcommand{\Q}{\mathbb{Q}}
\newcommand{\C}{\mathbb{C}}
\newcommand{\F}{\mathbb{F}}
\newcommand{\eps}{\varepsilon}
\newcommand{\abs}[1]{\left|#1\right|}
\newcommand{\norm}[1]{\left\lVert#1\right\rVert}
\newcommand{\inner}[2]{\left\langle#1,#2\right\rangle}
\newcommand{\set}[1]{\left\{#1\right\}}
\newcommand{\floor}[1]{\left\lfloor#1\right\rfloor}
\newcommand{\ceil}[1]{\left\lceil#1\right\rceil}
\newcommand{\dd}{\,\mathrm{d}}
\newcommand{\deriv}[2]{\frac{\mathrm{d}#1}{\mathrm{d}#2}}
\newcommand{\pd}[2]{\frac{\partial#1}{\partial#2}}
\DeclareMathOperator{\Span}{span}
\DeclareMathOperator{\rank}{rank}
\DeclareMathOperator{\tr}{tr}`;

const WELCOME = String.raw`# Example: why √2 is irrational

def: [Rational] $x \in \R$ is rational if $x = \frac{p}{q}$ with $p \in \Z$, $q \in \N$.

thm: $\sqrt{2} \notin \Q$.

pf: Suppose $\sqrt{2} = \frac{p}{q}$ in lowest terms. Then
$$p^2 = 2q^2,$$
so $p$ is even, say $p = 2k$. Then $q^2 = 2k^2$, so $q$ is even too, contradicting lowest terms.

## How it works
- maths renders as soon as the cursor leaves it; tap an equation to edit it
- type mk for inline maths, dm for display maths, bb for **bold**, itt for *italic*
- inside maths: x1 → x_1, xsr → x^2, // → fraction, ;a → α
- tap ⇥ to jump to the next empty slot`;

const ENVS = {
  def:['Definition','def',true], defn:['Definition','def',true], thm:['Theorem','thm',true], lem:['Lemma','thm',true],
  prop:['Proposition','thm',true], cor:['Corollary','thm',true], ex:['Example','ex',true], eg:['Example','ex',true],
  q:['Question','q',true], pf:['Proof','pf',false], proof:['Proof','pf',false], sol:['Solution','pf',false],
  rmk:['Remark','rmk',false], note:['Note','rmk',false]
};
const LATEX_ENV = {Definition:'definition',Theorem:'theorem',Lemma:'lemma',Proposition:'proposition',Corollary:'corollary',
  Example:'example',Question:'question',Proof:'proof',Solution:'solution',Remark:'remark',Note:'remark'};

/** Split a note into blocks at blank lines, never inside $$…$$, \[…\] or \begin…\end. */
function parseBlocks(src){
  const raw=[]; let cur=null, pos=0, dd=false, env=0;
  for(const line of src.split('\n')){
    if(line.trim()==='' && !dd && env<=0){ if(cur){raw.push(cur);cur=null} }
    else{
      if(!cur) cur={start:pos,lines:[]};
      cur.lines.push(line); cur.end=pos+line.length;
      dd ^= (line.match(/(?<!\\)\$\$/g)||[]).length & 1;
      env += (line.match(/\\begin\{|\\\[/g)||[]).length - (line.match(/\\end\{|\\\]/g)||[]).length;
    }
    pos+=line.length+1;
  }
  if(cur) raw.push(cur);
  // A heading owns only its own line; anything under it starts a new block.
  const blocks=[];
  for(const b of raw){
    if(/^#{1,3}\s/.test(b.lines[0]) && b.lines.length>1){
      blocks.push({start:b.start,end:b.start+b.lines[0].length,lines:[b.lines[0]]});
      blocks.push({start:b.start+b.lines[0].length+1,end:b.end,lines:b.lines.slice(1)});
    } else blocks.push(b);
  }
  let n=0;
  return blocks.map(b=>{
    const src=b.lines.join('\n'); const out={start:b.start,end:b.end,src};
    let m;
    if((m=/^(#{1,3})\s+(.*)$/.exec(src))) return {...out,kind:'heading',level:m[1].length,text:m[2],prefixLen:src.length-m[2].length};
    if((m=/^([a-z]+)[:.][ \t]*(?:\[([^\]\n]*)\])?[ \t]*/i.exec(src)) && ENVS[m[1].toLowerCase()]){
      const [name,cls,numbered]=ENVS[m[1].toLowerCase()];
      return {...out,kind:'env',name,cls,num:numbered?++n:null,title:m[2]||'',prefixLen:m[0].length,text:src.slice(m[0].length)};
    }
    if(/^[-*] /.test(src)) return {...out,kind:'list',items:src.split(/\n(?=[-*] )/).map(s=>s.replace(/^[-*] /,''))};
    return {...out,kind:'para',text:src};
  });
}

/** Split text into text and math tokens with absolute positions (offset by `base`).
    Unclosed math runs to the end and is marked open: that is maths still being typed. */
function tokenize(s, base=0){
  const out=[]; let i=0, tStart=0;
  const flush=end=>{ if(end>tStart) out.push({t:'text',from:base+tStart,to:base+end,v:s.slice(tStart,end)}) };
  const push=(from,to,innerFrom,innerTo,display,open,v)=>{
    flush(from); out.push({t:'math',from:base+from,to:base+to,innerFrom:base+innerFrom,innerTo:base+innerTo,d:display,open,v}); i=to; tStart=to;
  };
  while(i<s.length){
    if(s[i]==='\\' && s[i+1]==='$'){ i+=2; continue }
    if(s.startsWith('$$',i) || s.startsWith('\\[',i)){
      const close = s[i]==='$' ? '$$' : '\\]';
      const j=s.indexOf(close,i+2);
      if(j<0) push(i,s.length,i+2,s.length,true,true,s.slice(i+2));
      else push(i,j+2,i+2,j,true,false,s.slice(i+2,j));
      continue;
    }
    if(s.startsWith('\\begin{',i)){
      const m=/^\\begin\{([^}]+)\}/.exec(s.slice(i));
      if(m){
        const endTok='\\end{'+m[1]+'}'; const j=s.indexOf(endTok,i);
        if(j<0) push(i,s.length,i,s.length,true,true,s.slice(i)+endTok);
        else push(i,j+endTok.length,i,j+endTok.length,true,false,s.slice(i,j+endTok.length));
        continue;
      }
    }
    if(s[i]==='$'){
      let j=i+1; while(j<s.length && s[j]!=='$'){ if(s[j]==='\\') j++; j++ }
      if(j>=s.length) push(i,s.length,i+1,s.length,false,true,s.slice(i+1));
      else push(i,j+1,i+1,j,false,false,s.slice(i+1,j));
      continue;
    }
    i++;
  }
  flush(s.length); return out;
}

/** All math tokens in a note, found block by block so an unclosed $ never leaks past its paragraph. */
function findMath(src){
  const out=[];
  for(const b of parseBlocks(src)) for(const t of tokenize(b.src,b.start)) if(t.t==='math') out.push(t);
  return out;
}

/** Is position `pos` inside maths? */
function inMathAt(src,pos){
  for(const b of parseBlocks(src)){
    if(pos<b.start || pos>b.end) continue;
    const toks=tokenize(src.slice(b.start,pos),b.start); const last=toks[toks.length-1];
    return !!(last && last.t==='math' && last.open);
  }
  return false;
}

/* Snippets in the spirit of Gilles Castel's UltiSnips setup. ¦ marks where the caret lands.
   mode: m = only inside maths, t = only in text. word: trigger must not follow a letter.
   sub: replacement used right after _ or ^, where padding spaces would show. */
const SNIPPETS = [
  {k:'mk', r:'$¦$', mode:'t', word:true, info:'inline maths'},
  {k:'dm', r:'$$\n¦\n$$', mode:'t', word:true, info:'display maths'},
  {k:'bb', r:'**¦**', mode:'t', word:true, info:'bold'},
  {k:'itt', r:'*¦*', mode:'t', word:true, info:'italic (backticks give `code`)'},
  {k:'ali', r:'\\begin{align*}\n¦\n\\end{align*}', mode:'t', word:true, info:'align* block (use &= and \\\\)'},
  {k:'sr', r:'^2', mode:'m', info:'squared'},
  {k:'cb', r:'^3', mode:'m', info:'cubed'},
  {k:'td', r:'^{¦}', mode:'m', info:'superscript'},
  {k:'__', r:'_{¦}', mode:'m', info:'subscript'},
  {k:'inv', r:'^{-1}', mode:'m', info:'inverse'},
  {k:'//', r:'\\frac{¦}{}', mode:'m', info:'fraction'},
  {k:'->', r:'\\to ', mode:'m', info:'→'},
  {k:'=>', r:'\\implies ', mode:'m', info:'⟹'},
  {k:'\\le >', r:'\\iff ', mode:'m', info:'⟺', show:'<=>'},
  {k:'<=', r:'\\le ', mode:'m', info:'≤'},
  {k:'>=', r:'\\ge ', mode:'m', info:'≥'},
  {k:'!=', r:'\\neq ', mode:'m', info:'≠'},
  {k:'~~', r:'\\approx ', mode:'m', info:'≈'},
  {k:'**', r:'\\cdot ', mode:'m', info:'·'},
  {k:'...', r:'\\dots ', mode:'m', info:'…'},
  {k:'||', r:'\\mid ', mode:'m', info:'∣'},
  {k:'==', r:'&= ', mode:'m', info:'aligned equals'},
  {k:'lr(', r:'\\left( ¦ \\right)', mode:'m', info:'sized ( )'},
  {k:'lr|', r:'\\left| ¦ \\right|', mode:'m', info:'sized | |'},
  {k:'ooo', r:'\\infty', mode:'m', word:true, info:'∞'},
  {k:'xx', r:'\\times ', mode:'m', word:true, info:'×'},
  {k:'sum', r:'\\sum_{¦}^{}', mode:'m', word:true, info:'sum'},
  {k:'prod', r:'\\prod_{¦}^{}', mode:'m', word:true, info:'product'},
  {k:'lim', r:'\\lim_{¦ \\to \\infty}', mode:'m', word:true, info:'limit'},
  {k:'int', r:'\\int_{¦}^{} ', mode:'m', word:true, info:'integral'},
  {k:'sq', r:'\\sqrt{¦}', mode:'m', word:true, info:'square root'},
  {k:'inn', r:'\\in ', mode:'m', word:true, info:'∈'},
  {k:'notin', r:'\\notin ', mode:'m', word:true, info:'∉'},
  {k:'cc', r:'\\subseteq ', mode:'m', word:true, info:'⊆'},
  {k:'EE', r:'\\exists ', mode:'m', word:true, info:'∃'},
  {k:'AA', r:'\\forall ', mode:'m', word:true, info:'∀'},
  {k:'RR', r:'\\R', mode:'m', word:true, info:'ℝ (also NN ZZ QQ CC)'},
  {k:'NN', r:'\\N', mode:'m', word:true, hide:true},{k:'ZZ', r:'\\Z', mode:'m', word:true, hide:true},
  {k:'QQ', r:'\\Q', mode:'m', word:true, hide:true},{k:'CC', r:'\\C', mode:'m', word:true, hide:true},
  {k:'part', r:'\\partial ', mode:'m', word:true, info:'∂'},
  {k:'ddx', r:'\\deriv{¦}{x}', mode:'m', word:true, info:'d/dx'},
  {k:'ee', r:'e^{¦}', mode:'m', word:true, info:'exponential'},
  {k:'tt', r:'\\text{ ¦ }', sub:'\\text{¦}', mode:'m', word:true, info:'text inside maths, spaced (not in _ or ^)'},
  {k:'abs', r:'\\abs{¦}', mode:'m', word:true, info:'|x|'},
  {k:'norm', r:'\\norm{¦}', mode:'m', word:true, info:'‖x‖'},
  {k:'pmat', r:'\\begin{pmatrix} ¦ \\end{pmatrix}', mode:'m', word:true, info:'matrix ( ), use & and \\\\'},
  {k:'bmat', r:'\\begin{bmatrix} ¦ \\end{bmatrix}', mode:'m', word:true, info:'matrix [ ]'},
  {k:'case', r:'\\begin{cases} ¦ \\end{cases}', mode:'m', word:true, info:'cases'},
].sort((a,b)=>b.k.length-a.k.length);

const GREEK = {a:'alpha',b:'beta',g:'gamma',G:'Gamma',d:'delta',D:'Delta',e:'varepsilon',z:'zeta',h:'eta',t:'theta',T:'Theta',
  k:'kappa',l:'lambda',L:'Lambda',m:'mu',n:'nu',x:'xi',X:'Xi',p:'pi',P:'Pi',r:'rho',s:'sigma',S:'Sigma',u:'tau',
  f:'varphi',F:'Phi',c:'chi',y:'psi',Y:'Psi',o:'omega',O:'Omega'};
const POSTFIX = {bar:'overline',hat:'hat',vec:'vec',dot:'dot',til:'tilde'};

/** Given the text before the caret, return {del, ins} to apply, or null. `ins` may contain ¦. */
function expandSnippet(before, inMath){
  const inCmd = pre => /\\[A-Za-z]*$/.test(pre);
  let m;
  if((m=/;([A-Za-z])$/.exec(before)) && GREEK[m[1]]){
    const g='\\'+GREEK[m[1]];
    return {del:2, ins: inMath ? g+' ' : '$'+g+'$'};
  }
  if(inMath){
    if((m=/(^|[^\\A-Za-z])([A-Za-z])(bar|hat|vec|dot|til)$/.exec(before)))
      return {del:1+m[3].length, ins:'\\'+POSTFIX[m[3]]+'{'+m[2]+'}'};
    if((m=/([A-Za-z])_(\d)(\d)$/.exec(before)) && !inCmd(before.slice(0,-4)))
      return {del:4, ins:m[1]+'_{'+m[2]+m[3]+'}'};
    if((m=/(^|[^\\A-Za-z])([A-Za-z])(\d)$/.exec(before)))
      return {del:2, ins:m[2]+'_'+m[3]};
  }
  for(const s of SNIPPETS){
    if(!before.endsWith(s.k)) continue;
    if((s.mode==='m') !== inMath) continue;
    const pre=before.slice(0,-s.k.length);
    if(/^[A-Za-z]/.test(s.k) && inCmd(pre)) continue;
    if(s.word && /[A-Za-z]$/.test(pre)) continue;
    return {del:s.k.length, ins: s.sub && /[_^]\{?$/.test(pre) ? s.sub : s.r};
  }
  return null;
}

/** Where ⇥ moves the caret: into the next {}, else past the next }, $ or * (closing maths or bold). */
function jumpTarget(src,pos){
  const close=src.indexOf('}',pos), nl=src.indexOf('\n',pos), d=src.slice(pos).search(/[$*]/), delim=d<0?-1:pos+d;
  if(close>=0 && (delim<0||close<delim)) return src[close+1]==='{' ? close+2 : close+1;
  if(delim>=0){ let p=delim; while(src[p]===src[delim]) p++; return p }
  return nl>=0 ? nl : src.length;
}

function titleOf(body){
  const line=(body.split('\n').find(l=>l.trim())||'').replace(/^#+\s*/,'')
    .replace(/^([a-z]+)[:.]\s*/i,(m,k)=>ENVS[k.toLowerCase()]?'':m)
    .replace(new RegExp(FORMAT,'g'),(m,b,i,c)=>b??i??c).trim();
  return line.slice(0,60) || 'Untitled';
}

/** **bold**, *italic* and `code` in a piece of prose (a text token, never maths), offset by `base`.
    Like Markdown, the markers must hug the text: "a * b * c" is not italic. */
const FORMAT=/\*\*(\S(?:.*?\S)?)\*\*|\*([^\s*](?:[^*\n]*?[^\s*])?)\*|`([^`\n]+)`/;
function formatSpans(text, base=0){
  const re=new RegExp(FORMAT,'g'), out=[]; let m;
  while((m=re.exec(text))){
    const kind = m[1]!=null ? 'b' : m[2]!=null ? 'i' : 'c', mark = kind==='b' ? 2 : 1;
    out.push({kind, from:base+m.index, to:base+m.index+m[0].length, mark});
  }
  return out;
}

/** Convert a note to a standalone LaTeX document. */
function toLatex(body, preamble){
  const prose = t => t.replace(/\*\*(.+?)\*\*/g,'\\textbf{$1}').replace(/(^|[^*])\*([^*\n]+)\*/g,'$1\\emph{$2}')
    .replace(/`([^`]+)`/g,'\\texttt{$1}').replace(/\$\$([\s\S]*?)\$\$/g,'\\[$1\\]');
  const parts = parseBlocks(body).map(b=>{
    if(b.kind==='heading') return ['\\section*','\\subsection*','\\subsubsection*'][b.level-1]+'{'+prose(b.text)+'}';
    if(b.kind==='list') return '\\begin{itemize}\n'+b.items.map(i=>'  \\item '+prose(i)).join('\n')+'\n\\end{itemize}';
    if(b.kind==='env'){ const e=LATEX_ENV[b.name]; return '\\begin{'+e+'}'+(b.title?'['+b.title+']':'')+'\n'+prose(b.text)+'\n\\end{'+e+'}' }
    return prose(b.text);
  });
  const head = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,amsthm,mathtools,cancel}
\theoremstyle{plain}
\newtheorem{theorem}{Theorem}
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem{corollary}[theorem]{Corollary}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\newtheorem{example}[theorem]{Example}
\newtheorem{question}[theorem]{Question}
\newtheorem*{solution}{Solution}
\theoremstyle{remark}
\newtheorem*{remark}{Remark}`;
  const title = titleOf(body).replace(/[#$%&_{}]/g, c => '\\'+c);
  return [head, preamble, '', '\\title{'+title+'}', '\\date{}', '\\begin{document}', '\\maketitle', '',
    parts.join('\n\n'), '', '\\end{document}', ''].join('\n');
}

/** What an exported backup adds to the notebook: notes that are new or newer (by `updated`), and the
    preamble if it is newer. Malformed entries are skipped. Reads `nb`, never changes it. */
function mergeBackup(nb, data){
  const ok=n=>n && typeof n.id==='string' && /^[A-Za-z0-9-]{1,64}$/.test(n.id) && typeof n.body==='string' && Number.isFinite(n.updated);
  const notes=[];
  for(const n of (data && Array.isArray(data.notes) ? data.notes : [])){
    if(!ok(n)) continue;
    const l=nb.notes[n.id];
    if(!l || n.updated>l.updated) notes.push({id:n.id, body:n.body, created:Number.isFinite(n.created)?n.created:n.updated, updated:n.updated});
  }
  const newer=data && typeof data.preamble==='string' && Number.isFinite(data.preambleUpdated) && data.preambleUpdated>(nb.preambleUpdated||0);
  return {notes, book: newer ? {preamble:data.preamble, preambleUpdated:data.preambleUpdated} : null};
}
