import { getAdapter } from '../driver.js';
import { getProviderAlias, resolveProviderId } from '@/shared/constants/providers';
import { PROVIDER_MODELS } from '@/shared/constants/models';

export async function setProviderModelSelection(providerAlias, action) {
  const alias = getProviderAlias(resolveProviderId(providerAlias));
  const keys = new Set([providerAlias, alias, resolveProviderId(providerAlias)]);
  const db = await getAdapter();
  let count = 0;
  db.transaction(() => {
    const ids = new Set((PROVIDER_MODELS[alias] || []).map(model => model.id));
    for (const row of db.all("SELECT key,value FROM kv WHERE scope='customModels'")) {
      const model = JSON.parse(row.value);
      if (!keys.has(model.providerAlias)) continue;
      ids.add(model.id);
      if (action === 'clear' && model.catalogOnly !== true) {
        db.run("UPDATE kv SET value=? WHERE scope='customModels' AND key=?", [JSON.stringify({...model,catalogOnly:true}), row.key]);
        count++;
      }
    }
    for (const row of db.all("SELECT value FROM kv WHERE scope='modelAliases'")) {
      const target = JSON.parse(row.value);
      if (typeof target !== 'string') continue;
      const slash = target.indexOf('/');
      if (slash > 0 && keys.has(target.slice(0, slash))) ids.add(target.slice(slash + 1));
    }
    for (const row of db.all('SELECT id,provider,data FROM providerConnections')) {
      if (!keys.has(row.provider)) continue;
      const data = JSON.parse(row.data), providerSpecificData = {...data.providerSpecificData};
      if (action === 'clear') providerSpecificData.enabledModels = [];
      else delete providerSpecificData.enabledModels;
      db.run('UPDATE providerConnections SET data=?,updatedAt=? WHERE id=?',[JSON.stringify({...data,providerSpecificData}),new Date().toISOString(),row.id]);
    }
    if (action === 'clear') {
      const previous = db.get("SELECT value FROM kv WHERE scope='disabledModels' AND key=?",[alias]);
      const disabled = new Set(previous ? JSON.parse(previous.value) : []);
      for (const id of ids) disabled.add(id);
      db.run("INSERT INTO kv(scope,key,value) VALUES('disabledModels',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value",[alias,JSON.stringify([...disabled])]);
    }
  });
  return { count };
}
