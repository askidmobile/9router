import fs from 'node:fs';
import vm from 'node:vm';
import { it,expect,vi } from 'vitest';
const source=fs.readFileSync(new URL('../../src/app/layout.js',import.meta.url),'utf8');
const script=[...source.matchAll(/__html:\s*`([^`]+)`/g)].map(match=>match[1]).find(script=>script.includes('d.fonts'));
it('does not reveal text ligatures before CSS registration or after an empty font result',async()=>{
 let ready;const add=vi.fn(),load=vi.fn(async()=>[]);
 const document={readyState:'loading',fonts:{load},documentElement:{classList:{add}},addEventListener:(event,callback)=>{expect(event).toBe('DOMContentLoaded');ready=callback;}};
 vm.runInNewContext(script,{document,setTimeout:vi.fn()});expect(load).not.toHaveBeenCalled();
 ready();await Promise.resolve();await Promise.resolve();expect(add).not.toHaveBeenCalled();
 load.mockResolvedValue([{}]);ready();await Promise.resolve();await Promise.resolve();expect(add).toHaveBeenCalledWith('fonts-loaded');
});
it('ships the compact font as a local asset',()=>{
 const font=fs.readFileSync(new URL('../../public/fonts/material-symbols-outlined-v377.woff2',import.meta.url));
 expect(font.subarray(0,4).toString()).toBe('wOF2');expect(font.length).toBeLessThan(350000);
 expect(source).toContain('rel="preload"');expect(source).not.toContain('material-symbols/outlined.css');
});
