import { sanitizeEvidenceSnapshot, type EvidenceSnapshot } from "@/lib/session-evidence";

export type SessionLogArchiveState = {logs:EvidenceSnapshot[];storage:"loading"|"saved"|"saving"|"memory"|"clear_failed"};
type Storage = {read:()=>Promise<unknown>;mutate:(log:EvidenceSnapshot|null,clearRequestedAt?:number)=>Promise<unknown>};

function latestTwo(value:unknown):EvidenceSnapshot[] {
  if (!Array.isArray(value)) return [];
  const unique=new Map<number,EvidenceSnapshot>();
  for (const item of value) {
    const log=sanitizeEvidenceSnapshot(item);
    if (log) unique.set(log.startedAt,log);
  }
  return [...unique.values()].sort((a,b)=>b.startedAt-a.startedAt).slice(0,2);
}

type ArchiveRecord = {version:1;logs:EvidenceSnapshot[];clearedAt:number};
function readRecord(value:unknown):ArchiveRecord {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return {version:1,logs:[],clearedAt:0};
  const record=value as Record<string,unknown>;
  const clearedAt=typeof record.clearedAt === "number" && Number.isFinite(record.clearedAt) && record.clearedAt >= 0 && record.clearedAt <= 8.64e15 ? record.clearedAt : 0;
  return {version:1,logs:latestTwo(record.logs).filter(log=>(log.endedAt ?? 0)>clearedAt),clearedAt};
}

/** Pure transaction update; the shared clear cutoff also covers delayed tabs. */
export function updateSessionLogArchive(value:unknown, snapshot:unknown|null, at=Date.now()):ArchiveRecord {
  const record=readRecord(value);
  if (snapshot === null) {
    const clearedAt=Math.max(record.clearedAt,at);
    return {version:1,logs:record.logs.filter(log=>(log.endedAt ?? 0)>clearedAt),clearedAt};
  }
  const log=sanitizeEvidenceSnapshot(snapshot);
  return log && (log.endedAt ?? 0)>record.clearedAt ? {...record,logs:latestTwo([...record.logs,log])} : record;
}

/** Separate database: never touches video-library data or preferences. */
export const browserSessionLogStorage:Storage = {
  async read() { return databaseOperation("readonly"); },
  async mutate(log,clearRequestedAt) { return databaseOperation("readwrite",log,clearRequestedAt); },
};

function databaseOperation(mode:IDBTransactionMode, log?:EvidenceSnapshot|null, clearRequestedAt?:number):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    if (typeof indexedDB === "undefined") {reject(new Error("Storage unavailable"));return;}
    let abandoned=false;
    const opening=indexedDB.open("visual-assistant-session-logs",1);
    opening.onupgradeneeded=()=>opening.result.createObjectStore("archive");
    opening.onerror=()=>reject(new Error("Storage unavailable"));
    opening.onblocked=()=>{abandoned=true;reject(new Error("Storage unavailable"));};
    opening.onsuccess=()=>{
      const db=opening.result;
      if (abandoned) {db.close();return;}
      try {
        const tx=db.transaction("archive",mode), store=tx.objectStore("archive");
        // Same-store readwrite transactions serialize across tabs. Never write a
        // tab's cached history: append only this completed snapshot to fresh data.
        const request=store.get("latest");
        let canonical:ArchiveRecord={version:1,logs:[],clearedAt:0};
        request.onsuccess=()=>{
          const stored=request.result;
          canonical=readRecord(stored);
          if (mode === "readwrite") {
            canonical=updateSessionLogArchive(stored,log ?? null,clearRequestedAt);
            store.put(canonical,"latest");
          }
        };
        tx.oncomplete=()=>{
          db.close();
          resolve(canonical);
        };
        tx.onabort=tx.onerror=()=>{db.close();reject(new Error("Storage unavailable"));};
      } catch {db.close();reject(new Error("Storage unavailable"));}
    };
  });
}

/** Serialize mutations; an epoch prevents late loads/writes reviving cleared logs. */
export class SessionLogArchive {
  private logs:EvidenceSnapshot[]=[];
  private neverPersisted:EvidenceSnapshot[]=[];
  private storage:SessionLogArchiveState["storage"]="loading";
  private epoch=0;
  private pending=Promise.resolve();
  constructor(private persistence:Storage=browserSessionLogStorage, private changed:()=>void=()=>{}) {}
  state():SessionLogArchiveState {return {logs:latestTwo(this.logs),storage:this.storage};}
  private acceptCanonical(value:unknown) {
    const canonical=Array.isArray(value) ? {logs:latestTwo(value),clearedAt:0} : readRecord(value);
    this.neverPersisted=this.neverPersisted.filter(log=>(log.endedAt ?? 0)>canonical.clearedAt);
    this.logs=latestTwo([...canonical.logs,...this.neverPersisted]);
    this.neverPersisted=this.neverPersisted.filter(log=>this.logs.some(retained=>retained.startedAt === log.startedAt));
    this.storage=this.neverPersisted.length ? "memory" : "saved";
  }
  private queue(work:()=>Promise<void>):Promise<void> {
    this.pending=this.pending.then(work).catch(()=>{this.storage="memory";this.changed();});
    return this.pending;
  }
  load() {
    const epoch=this.epoch;
    return this.queue(async()=>{
      try {
        const stored=await this.persistence.read();
        if (epoch !== this.epoch) return;
        this.acceptCanonical(stored);
      } catch {if (epoch !== this.epoch) return;this.storage="memory";}
      this.changed();
    });
  }
  save(value:unknown) {
    const log=sanitizeEvidenceSnapshot(value);
    if (!log) return Promise.resolve();
    this.logs=latestTwo([...this.logs,log]);this.storage="saving";this.changed();
    const epoch=this.epoch;
    return this.queue(async()=>{
      if (epoch !== this.epoch) return;
      try {
        const canonical=await this.persistence.mutate(log);
        if (epoch === this.epoch) {
          this.neverPersisted=this.neverPersisted.filter(item=>item.startedAt !== log.startedAt);
          this.acceptCanonical(canonical);
        }
      }
      catch {if (epoch === this.epoch) {
        this.neverPersisted=latestTwo([...this.neverPersisted,log]);
        this.logs=latestTwo([...this.logs,...this.neverPersisted]);this.storage="memory";
      }}
      if (epoch === this.epoch) this.changed();
    });
  }
  clear() {
    const requestedAt=Date.now();
    const epoch=++this.epoch;
    this.logs=[];this.neverPersisted=[];this.storage="saving";this.changed();
    return this.queue(async()=>{
      try {
        const canonical=await this.persistence.mutate(null,requestedAt);
        if (epoch === this.epoch) this.acceptCanonical(canonical);
      }
      catch {if (epoch === this.epoch) this.storage="clear_failed";}
      if (epoch === this.epoch) this.changed();
    });
  }
}
