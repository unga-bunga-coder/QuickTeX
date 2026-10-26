/* =====================================================================
   STORE: notes on this device, in IndexedDB. No DOM, no editor.
   Database "pockettex": store "notes" holds Note by id, store "meta" holds
   preamble, preambleUpdated, last (open note id) and v (set once migrated).
   ===================================================================== */
"use strict";
const Store = {
  db:null,
  onError(){},   // the app shows a status when a write fails
  req(r){ return new Promise((ok,bad)=>{ r.onsuccess=()=>ok(r.result); r.onerror=()=>bad(r.error) }) },
  tx(names, fill){
    return new Promise((ok,bad)=>{
      const t=this.db.transaction(names,'readwrite'); fill(t);
      t.oncomplete=()=>ok(); t.onerror=t.onabort=()=>bad(t.error);
    }).catch(e=>this.onError(e));
  },

  /** Opens the database and returns the notebook. The first run copies notes over from localStorage. */
  async open(){
    const r=indexedDB.open('pockettex',1);
    r.onupgradeneeded=()=>{ r.result.createObjectStore('notes',{keyPath:'id'}); r.result.createObjectStore('meta') };
    this.db=await this.req(r);
    const t=this.db.transaction(['notes','meta']), meta=t.objectStore('meta');
    const [notes,keys,vals]=await Promise.all([this.req(t.objectStore('notes').getAll()), this.req(meta.getAllKeys()), this.req(meta.getAll())]);
    const m=Object.fromEntries(keys.map((k,i)=>[k,vals[i]]));
    const nb={notes:Object.fromEntries(notes.map(n=>[n.id,n])), preamble:m.preamble, preambleUpdated:m.preambleUpdated, last:m.last};
    if(m.v) return nb;

    // First run. The old localStorage copy is left in place as a backup; the "v" flag stops a second migration.
    let old=null; try{ old=JSON.parse(localStorage.getItem('pockettex.v1')||'null') }catch{}
    if(old && old.notes && typeof old.notes==='object'){
      for(const [id,n] of Object.entries(old.notes)) if(n && typeof n.body==='string') nb.notes[id]={id, body:n.body, created:n.created||n.updated||0, updated:n.updated||0};
      Object.assign(nb,{preamble:old.preamble, preambleUpdated:old.preambleUpdated, last:old.last});
    }
    await this.tx(['notes','meta'],t=>{
      for(const n of Object.values(nb.notes)) t.objectStore('notes').put(n);
      const meta=t.objectStore('meta');
      for(const k of ['preamble','preambleUpdated','last']) if(nb[k]!=null) meta.put(nb[k],k);
      meta.put(1,'v');
    });
    try{ navigator.storage.persist().catch(()=>{}) }catch{}
    return nb;
  },
  putNote(n){ return this.tx(['notes'],t=>t.objectStore('notes').put(n)) },
  deleteNote(id){ return this.tx(['notes'],t=>t.objectStore('notes').delete(id)) },
  /** @param {Object} kv  e.g. {last:id} or {preamble, preambleUpdated} */
  setMeta(kv){ return this.tx(['meta'],t=>{ for(const [k,v] of Object.entries(kv)) t.objectStore('meta').put(v,k) }) }
};
