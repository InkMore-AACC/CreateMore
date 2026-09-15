'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {imageRecipe,speechRecipes}=require('../app/providers/specialized-recipes.cjs');
const {validateBundle,bindInputs}=require('../app/providers/workflows.cjs');
test('authored GUI retains converted widget slots before subsequent parameters',()=>{
  const {authoredGui}=require('../app/providers/recipes.cjs');
  const gui=authoredGui({'1':{class_type:'Size',inputs:{}},'2':{class_type:'Grid',inputs:{width:['1',0],padding:0}}},{Size:{output:['INT']},Grid:{input:{required:{width:['INT',{default:512}],padding:['INT',{default:4}]}},output:['IMAGE']}});
  assert.deepEqual(gui.nodes[1].widgets_values,[512,0]);assert.deepEqual(gui.nodes[1].inputs[0].widget,{name:'width'});
});
test('dedicated image recipes have complete binding targets',()=>{
  for(const args of [['portrait'],['angles',true],['grid',true,true],['mark',false,false,true]]){
    const recipe=imageRecipe(...args);assert.equal(validateBundle(recipe),recipe);
    for(const entry of Object.values(recipe.api))for(const val of Object.values(entry.inputs))if(Array.isArray(val))assert.ok(recipe.api[val[0]],'link target exists');
  }
});
test('nine-grid has nine samplers and a shared seed/step binding',()=>{
  const recipe=imageRecipe('grid',true,true),samplers=Object.values(recipe.api).filter(n=>n.class_type==='KSampler');assert.equal(samplers.length,9);
  for(const node of samplers){assert.deepEqual(node.inputs.seed,['111',0]);assert.deepEqual(node.inputs.steps,['112',0]);}
  assert.equal(recipe.api['110'].class_type,'ImageGrid');assert.equal(recipe.api['110'].inputs.columns,3);
  assert.equal(recipe.api['16'].inputs.images[0],'110');
});
test('local marked edit keeps original and separate guide/mask inputs',()=>{
  const recipe=imageRecipe('mark',false,false,true);const api=bindInputs(recipe,{prompt:'Replace flower only',references:[{inputId:'edit_mask',path:'m',type:'image'},{inputId:'image',path:'o',type:'image'},{inputId:'edit_guide',path:'g',type:'image'}]},[{name:'mask.png',type:'image'},{name:'original.png',type:'image'},{name:'guide.png',type:'image'}]);
  assert.equal(api['1'].inputs.image,'original.png');assert.equal(api['20'].inputs.image,'guide.png');assert.equal(api['21'].inputs.image,'mask.png');assert.deepEqual(api['26'].inputs.destination,['1',0]);assert.deepEqual(api['16'].inputs.images,['26',0]);
});
test('speech only exposes supported models and separates clone from emotional instruction',()=>{
  const registry={CreateMoreQwenTTS:{input:{required:{model:[['Qwen3/VoiceDesign','Qwen3/Base','Qwen3/CustomVoice']],language:[['Chinese']],speaker:[['Vivian']]}}}};
  const recipes=speechRecipes(registry);assert.equal(recipes.length,3);
  for(const recipe of recipes)validateBundle(recipe);
  const clone=recipes.find(r=>r.id.endsWith('clone'));assert.equal(clone.api['1'].inputs.instruction,'');assert.ok(!clone.mapping.inputs.some(i=>i.id==='instruction'));assert.ok(clone.mapping.inputs.some(i=>i.source==='reference'&&i.mediaType==='audio'));
  assert.equal(speechRecipes({}).length,0);
});
