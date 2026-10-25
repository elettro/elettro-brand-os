const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const ts=require('typescript');
const file=path.resolve(__dirname,'../apps/web/lib/client-scope.ts');
const out=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
const module_={exports:{}};
vm.runInNewContext(out.outputText,{module:module_,exports:module_.exports,URLSearchParams});
const {scopeRead,thumbnailPathAllowed}=module_.exports;
const mergeBrandTags=(...a)=>JSON.parse(JSON.stringify(module_.exports.mergeBrandTags(...a)));
const B=['solarmeister','neckermann-strom'];

test('a client cannot widen the brand list or turn off the shared flag',()=>{
  const r=scopeRead('content-pool','?brands=stashbox,elettro&shared=1',B);
  assert.equal(r.ok,true);
  const p=new URLSearchParams(r.search);
  assert.equal(p.get('brands'),'solarmeister,neckermann-strom');
  assert.equal(p.get('shared'),null);
});
test('the assets list adds the shared library, content pool does not',()=>{
  assert.equal(new URLSearchParams(scopeRead('assets','',B).search).get('shared'),'1');
  assert.equal(new URLSearchParams(scopeRead('content-pool','',B).search).get('shared'),null);
});
test('asset by id keeps the id and is scoped',()=>{
  const p=new URLSearchParams(scopeRead('assets','?id=abc',B).search);
  assert.equal(p.get('id'),'abc'); assert.equal(p.get('brands'),'solarmeister,neckermann-strom');
});
test('registry lookups and other brands metadata options are refused',()=>{
  assert.equal(scopeRead('assets','?dropboxFileId=id:abcdefgh1',B).ok,false);
  assert.equal(scopeRead('assets','?metadataOptions=1&brandSlug=stashbox',B).ok,false);
  assert.equal(scopeRead('assets','?metadataOptions=1&brandSlug=solarmeister',B).ok,true);
  assert.equal(scopeRead('assets','?metadataOptions=1&brandSlug=creative-assets',B).ok,true);
});
test('no brands means no access',()=>assert.equal(scopeRead('assets','',[]).ok,false));
test('thumbnails only from own brand folders and the shared library',()=>{
  const root='/1---elettro-brand-os/';
  assert.equal(thumbnailPathAllowed(root+'brands/solarmeister/a.jpg',B),true);
  assert.equal(thumbnailPathAllowed(root+'brands/Neckermann-Strom/a.jpg',B),true);
  assert.equal(thumbnailPathAllowed(root+'creative-assets/stock-videos/a.mp4',B),true);
  assert.equal(thumbnailPathAllowed(root+'brands/creative-assets/a.mp4',B),true);
  assert.equal(thumbnailPathAllowed(root+'brands/stashbox/a.jpg',B),false);
  assert.equal(thumbnailPathAllowed(root+'brands/solarmeister/../stashbox/a.jpg',B),false);
  assert.equal(thumbnailPathAllowed(root+'brands/solarmeister-other/a.jpg',B),false);
  assert.equal(thumbnailPathAllowed('',B),false);
});
test('brand tags: a client changes only their own brands',()=>{
  assert.deepEqual(mergeBrandTags(['stashbox','solarmeister'],['neckermann-strom'],B).sort(),['neckermann-strom','stashbox']);
  assert.deepEqual(mergeBrandTags(['stashbox'],['stashbox','elettro','solarmeister'],B).sort(),['solarmeister','stashbox']);
  assert.deepEqual(mergeBrandTags(['solarmeister','neckermann-strom'],[],B),[]);
  assert.deepEqual(mergeBrandTags([],['solarmeister','solarmeister'],B),['solarmeister']);
});
