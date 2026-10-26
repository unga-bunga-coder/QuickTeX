/* =====================================================================
   STORE: notes on this device, in IndexedDB. No DOM, no editor.
   Database "quicktex": store "notes" holds Note by id, store "meta" holds
   preamble, preambleUpdated, last (open note id) and v (set on first run).
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

  /** Opens the database and returns the notebook. */
  async open(){
    const r=indexedDB.open('quicktex',1);
    r.onupgradeneeded=()=>{ r.result.createObjectStore('notes',{keyPath:'id'}); r.result.createObjectStore('meta') };
    this.db=await this.req(r);
    const t=this.db.transaction(['notes','meta']), meta=t.objectStore('meta');
    const [notes,keys,vals]=await Promise.all([this.req(t.objectStore('notes').getAll()), this.req(meta.getAllKeys()), this.req(meta.getAll())]);
    const m=Object.fromEntries(keys.map((k,i)=>[k,vals[i]]));
    const nb={notes:Object.fromEntries(notes.map(n=>[n.id,n])), preamble:m.preamble, preambleUpdated:m.preambleUpdated, last:m.last};
    if(m.v) return nb;

    // First run: ask the browser not to evict our storage.
    await this.setMeta({v:1});
    try{ navigator.storage.persist().catch(()=>{}) }catch{}
    return nb;
  },
  putNote(n){ return this.tx(['notes'],t=>t.objectStore('notes').put(n)) },
  deleteNote(id){ return this.tx(['notes'],t=>t.objectStore('notes').delete(id)) },
  /** @param {Object} kv  e.g. {last:id} or {preamble, preambleUpdated} */
  setMeta(kv){ return this.tx(['meta'],t=>{ for(const [k,v] of Object.entries(kv)) t.objectStore('meta').put(v,k) }) }
};
