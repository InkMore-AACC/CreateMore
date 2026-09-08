'use strict';
const node=(class_type,inputs)=>({class_type,inputs});
const param=(id,nodeId,input,value,extra={})=>({id,label:id,source:'parameter',nodeId,input,default:value,...extra});
const cameraLabels={'front view':'正面 · 0°','front-right quarter view':'右前方 · 45°','right side view':'右侧 · 90°','back-right quarter view':'右后方 · 135°','back view':'背面 · 180°','back-left quarter view':'左后方 · 225°','left side view':'左侧 · 270°','front-left quarter view':'左前方 · 315°','low-angle shot':'仰拍 · −30°','eye-level shot':'平视 · 0°','elevated shot':'轻俯拍 · 30°','high-angle shot':'高角度俯拍 · 60°','close-up':'特写','medium shot':'中景','wide shot':'远景'};
function speechRecipes(registry){
  const def=registry.CreateMoreQwenTTS;if(!def)return [];
  const models=def.input.required.model[0];
  return [['design','VoiceDesign','voice_design','音色设计'],['emotion','CustomVoice','custom_voice','情绪配音'],['clone','Base','voice_clone','音色克隆']].flatMap(([id,flavor,mode,label])=>{
    const model=models.find(m=>m.includes(flavor));if(!model)return [];
    const api={'1':node('CreateMoreQwenTTS',{model,mode,text:'今天的风很轻，阳光正好。',instruction:mode==='voice_clone'?'':'温暖自然，略带笑意。',speaker:'Vivian',language:'Chinese',seed:42,max_new_tokens:2048,reference_text:''}),'2':node('SaveAudio',{audio:['1',0],filename_prefix:'CreateMore/speech-'+id})};
    const inputs=[{id:'prompt',label:'朗读文本',source:'prompt',nodeId:'1',input:'text',required:true},param('model','1','model',model,{label:'本地模型',options:models.filter(m=>m.includes(flavor))}),param('language','1','language','Chinese',{label:'语言',options:def.input.required.language[0]}),param('seed','1','seed',42,{label:'随机种子',type:'integer',min:0,max:2147483647}),param('max_new_tokens','1','max_new_tokens',2048,{label:'最长语音令牌',type:'integer',min:32,max:4096})];
    if(mode==='voice_clone'){
      api['3']=node('LoadAudio',{audio:'example.wav'});api['1'].inputs.reference_audio=['3',0];
      inputs.push({id:'audio',label:'参考音色（1–60秒）',source:'reference',nodeId:'3',input:'audio',mediaType:'audio',required:true},param('reference_text','1','reference_text','',{label:'参考录音原文（推荐填写）',type:'string'}));
    }else inputs.push(param('instruction','1','instruction',api['1'].inputs.instruction,{label:mode==='voice_design'?'音色与情绪描述':'情绪与说话方式',type:'string'}));
    if(mode==='custom_voice')inputs.push(param('speaker','1','speaker','Vivian',{label:'预设音色',options:def.input.required.speaker[0]}));
    return [{id:'audio-qwen-'+id,label:'语音 · '+label,kind:'audio',api,mapping:{inputs,outputs:[{id:'audio',nodeId:'2',key:'audio',type:'audio'}]},note:mode==='voice_clone'?'克隆你有权使用的参考声音；跟随参考表达，不支持独立的情绪指令。':'Qwen3 TTS 本地语音；音色、表达与逐字准确度需按实际输出试听。'}];
  });
}
function imageRecipe(id,angle=false,grid=false,masked=false){
  const api={
    '1':node('LoadImage',{image:'example.png'}),
    '2':node('ImageScaleToTotalPixels',{image:['1',0],upscale_method:'lanczos',megapixels:1,resolution_steps:16}),
    '3':node('UNETLoader',{unet_name:'qwen_image_edit_2511_fp8mixed.safetensors',weight_dtype:'default'}),
    '4':node('LoraLoaderModelOnly',{model:['3',0],lora_name:'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors',strength_model:1}),
    '5':node('ModelSamplingAuraFlow',{model:['4',0],shift:3.1}),
    '6':node('CFGNorm',{model:['5',0],strength:1,pre_cfg:false}),
    '7':node('CLIPLoader',{clip_name:'qwen_2.5_vl_7b_fp8_scaled.safetensors',type:'qwen_image',device:'default'}),
    '8':node('VAELoader',{vae_name:'qwen_image_vae.safetensors'}),
    '9':node('TextEncodeQwenImageEditPlus',{clip:['7',0],prompt:'Preserve the subject identity and composition. Improve natural fine detail.',vae:['8',0],image1:['2',0]}),
    '10':node('TextEncodeQwenImageEditPlus',{clip:['7',0],prompt:'',vae:['8',0],image1:['2',0]}),
    '11':node('FluxKontextMultiReferenceLatentMethod',{conditioning:['9',0],reference_latents_method:'index'}),
    '12':node('FluxKontextMultiReferenceLatentMethod',{conditioning:['10',0],reference_latents_method:'index'}),
    '13':node('VAEEncode',{pixels:['2',0],vae:['8',0]}),
    '14':node('KSampler',{model:['6',0],seed:42,steps:4,cfg:1,sampler_name:'euler',scheduler:'simple',positive:['11',0],negative:['12',0],latent_image:['13',0],denoise:1}),
    '15':node('VAEDecode',{samples:['14',0],vae:['8',0]}),
    '16':node('SaveImage',{images:['15',0],filename_prefix:'CreateMore/'+id}),
  };
  const inputs=[{id:'image',label:'原始参考图',source:'reference',nodeId:'1',input:'image',required:true,mediaType:'image'}, {id:'prompt',label:'修改说明',source:'prompt',nodeId:'9',input:'prompt',required:true},param('seed','14','seed',42,{type:'integer',min:0,max:Number.MAX_SAFE_INTEGER}),param('megapixels','2','megapixels',1,{label:'生成百万像素',type:'number',min:0.1,max:2}),param('steps','14','steps',4,{label:'采样步数',type:'integer',min:4,max:12})];
  if(angle||grid){
    api['17']=node('LoraLoaderModelOnly',{model:['3',0],lora_name:'qwen-image-edit-2511-multiple-angles-lora.safetensors',strength_model:1});api['4'].inputs.model=['17',0];
    api['18']=node('CreateMoreCameraPrompt',{azimuth:'front-right quarter view',elevation:'eye-level shot',distance:'medium shot',extra:''});api['9'].inputs.prompt=['18',0];inputs[1]={...inputs[1],nodeId:'18',input:'extra'};
    if(!grid)inputs.push(param('azimuth','18','azimuth','front-right quarter view',{label:'环绕机位',options:['front view','front-right quarter view','right side view','back-right quarter view','back view','back-left quarter view','left side view','front-left quarter view']}),param('elevation','18','elevation','eye-level shot',{label:'俯仰机位',options:['low-angle shot','eye-level shot','elevated shot','high-angle shot']}),param('distance','18','distance','medium shot',{label:'景别',options:['close-up','medium shot','wide shot']}));
  }
  if(grid){
    // Nine real sampling branches, shared model and image encoding; compose a real grid.
    const views=[['front view','eye-level shot','medium shot'],['front-right quarter view','eye-level shot','medium shot'],['right side view','eye-level shot','medium shot'],['front-left quarter view','eye-level shot','medium shot'],['front view','low-angle shot','medium shot'],['front view','high-angle shot','medium shot'],['front view','eye-level shot','close-up'],['front view','eye-level shot','wide shot'],['back view','eye-level shot','medium shot']];
    api['18'].inputs.azimuth=views[0][0];let batch=['15',0];
    api['19']=node('PrimitiveStringMultiline',{value:''});inputs[1]={...inputs[1],nodeId:'19',input:'value'};api['18'].inputs.extra=['19',0];
    for(let i=1;i<9;i++){
      const n=20+i*10,ref=(offset)=>[String(n+offset),0];
      api[n]=node('CreateMoreCameraPrompt',{azimuth:views[i][0],elevation:views[i][1],distance:views[i][2],extra:['19',0]});
      api[n+1]=structuredClone(api['9']);api[n+1].inputs.prompt=ref(0);
      api[n+2]=node('FluxKontextMultiReferenceLatentMethod',{conditioning:ref(1),reference_latents_method:'index'});
      api[n+3]=structuredClone(api['14']);api[n+3].inputs.positive=ref(2);
      api[n+4]=node('VAEDecode',{samples:ref(3),vae:['8',0]});
      api[n+5]=node('ImageBatch',{image1:batch,image2:ref(4)});batch=ref(5);
    }
    api['113']=node('ImageScale',{image:['15',0],upscale_method:'lanczos',width:512,height:0,crop:'disabled'});api['114']=node('GetImageSize',{image:['113',0]});
    api['110']=node('ImageGrid',{images:batch,columns:3,cell_width:['114',0],cell_height:['114',1],padding:0});api['16'].inputs.images=['110',0];
    // One seed/step widget fans out to every sampler; no hidden stale branch settings.
    api['111']=node('PrimitiveInt',{value:42});api['112']=node('PrimitiveInt',{value:4});
    for(const entry of Object.values(api))if(entry.class_type==='KSampler'){entry.inputs.seed=['111',0];entry.inputs.steps=['112',0];}
    inputs.find(i=>i.id==='seed').nodeId='111';inputs.find(i=>i.id==='seed').input='value';inputs.find(i=>i.id==='steps').nodeId='112';inputs.find(i=>i.id==='steps').input='value';
  }
  if(masked){
    api['20']=node('LoadImage',{image:'guide.png'});api['9'].inputs.image2=['20',0];api['10'].inputs.image2=['20',0];
    api['21']=node('LoadImage',{image:'mask.png'});api['22']=node('GetImageSize',{image:['1',0]});
    api['23']=node('ImageScale',{image:['21',0],upscale_method:'nearest-exact',width:['22',0],height:['22',1],crop:'disabled'});
    api['24']=node('ImageToMask',{image:['23',0],channel:'red'});
    api['25']=node('ImageScale',{image:['15',0],upscale_method:'lanczos',width:['22',0],height:['22',1],crop:'disabled'});
    api['27']=node('SetLatentNoiseMask',{samples:['13',0],mask:['24',0]});api['14'].inputs.latent_image=['27',0];
    api['28']=node('GrowMask',{mask:['24',0],expand:-8,tapered_corners:true});
    api['29']=node('MaskToImage',{mask:['28',0]});api['30']=node('ImageBlur',{image:['29',0],blur_radius:8,sigma:4});
    api['31']=node('ImageToMask',{image:['30',0],channel:'red'});api['32']=node('MaskComposite',{destination:['24',0],source:['31',0],x:0,y:0,operation:'multiply'});
    api['26']=node('ImageCompositeMasked',{destination:['1',0],source:['25',0],x:0,y:0,resize_source:false,mask:['32',0]});api['16'].inputs.images=['26',0];
    inputs.push({id:'edit_guide',label:'标注说明图',source:'reference',nodeId:'20',input:'image',required:true,mediaType:'image',index:1},{id:'edit_mask',label:'可修改区域（白色）',source:'reference',nodeId:'21',input:'image',required:true,mediaType:'image',index:2});
  }
  if(id.endsWith('portrait')){api['14'].inputs.denoise=0.35;inputs.push(param('denoise','14','denoise',0.35,{label:'质感调整强度',type:'number',min:0.1,max:0.65}));}
  for(const input of inputs)if(['azimuth','elevation','distance'].includes(input.id))input.optionLabels=Object.fromEntries(input.options.map(v=>[v,cameraLabels[v]]));
  // Qwen's reference encoder normalizes to ~1 MP. Smaller output latents changed
  // framing in real tests, so the shipped recipe keeps the corresponding scale.
  return {id,kind:'image',api,mapping:{inputs:inputs.filter(i=>i.id!=='megapixels'),outputs:[{id:'image',nodeId:'16',key:'images',type:'image'}]}};
}
module.exports={speechRecipes,imageRecipe};
