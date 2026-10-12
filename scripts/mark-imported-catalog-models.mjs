// One-time, reversible classification of the earlier bulk catalog registrations.
// BASELINE_DB must name the backup from before those imports. Dry run by default.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB_PATH || '/app/data/db/data.sqlite');
if (!process.env.BASELINE_DB) throw new Error('BASELINE_DB is required');
if (db.prepare("SELECT 1 FROM kv WHERE scope='migrations' AND key='catalog-selection-v1'").get()) {
 console.log(JSON.stringify({status:'already applied'}));process.exit(0);
}
const baseline = new DatabaseSync(process.env.BASELINE_DB, {readOnly:true});
const aliases = {req:'req',requesty:'req',apinex:'apinex',cheaper:'cheaper'};
const nodeAliases = new Map(baseline.prepare('SELECT id,data FROM providerNodes').all().map(row=>[row.id,JSON.parse(row.data).prefix]));
const normalize = alias => aliases[alias] || aliases[nodeAliases.get(alias)] || alias;
const read = (database,scope) => database.prepare('SELECT key,value FROM kv WHERE scope=?').all(scope).map(row=>({...row,value:JSON.parse(row.value)}));
const preserved = new Set(read(baseline,'customModels').map(row=>`${normalize(row.value.providerAlias)}/${row.value.id}`));
const keepReference = reference => {
 if(typeof reference!=='string'||!reference.includes('/'))return;
 const slash=reference.indexOf('/');preserved.add(`${normalize(reference.slice(0,slash))}/${reference.slice(slash+1)}`);
};
for(const row of read(db,'modelAliases'))keepReference(row.value);
for(const row of db.prepare('SELECT models FROM combos').all())for(const member of JSON.parse(row.models)||[])keepReference(typeof member==='string'?member:member.model||member.id);
for(const row of read(db,'modelCaps')){
 if(Object.values(row.value.manualSources||{}).some(source=>source.source==='manual')){
  const bar=row.key.indexOf('|');preserved.add(`${normalize(row.key.slice(0,bar))}/${row.key.slice(bar+1)}`);
 }
}
const candidates=read(db,'customModels').filter(row=>{
 const model=row.value;
 if(!['req','apinex','cheaper'].includes(model.providerAlias)||model.catalogOnly===true)return false;
 if(preserved.has(`${model.providerAlias}/${model.id}`))return false;
 // Display-name edits and extra user configuration are positive evidence of selection.
 return (!model.name||model.name===model.id)&&!model.caps&&!model.transport;
});
const counts=candidates.reduce((result,row)=>(result[row.value.providerAlias]=(result[row.value.providerAlias]||0)+1,result),{});
let backup;
if(process.env.APPLY==='1'&&candidates.length){
 backup=`/app/data/db/backups/pre-catalog-selection-${Date.now()}.sqlite`;
 db.exec(`VACUUM INTO '${backup}'`);
 const set=db.prepare("UPDATE kv SET value=? WHERE scope='customModels' AND key=?");
 db.exec('BEGIN IMMEDIATE');
 try {for(const row of candidates)set.run(JSON.stringify({...row.value,catalogOnly:true}),row.key);db.prepare("INSERT INTO kv(scope,key,value) VALUES('migrations','catalog-selection-v1',?)").run(JSON.stringify({appliedAt:new Date().toISOString(),counts}));db.exec('COMMIT');}
 catch(error){db.exec('ROLLBACK');throw error;}
}
console.log(JSON.stringify({applied:process.env.APPLY==='1',counts,preservedReferences:preserved.size,backup,quickCheck:db.prepare('PRAGMA quick_check').get().quick_check}));
