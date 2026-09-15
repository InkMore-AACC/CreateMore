'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareExit}=require('../app/core/exit-check.cjs');
test('exit flushes final keystroke before detecting unsaved changes',async()=>{let value='',saved='',asked=false;const session={};const result=await prepareExit({flush:async()=>{value='last character';},dirty:()=>value?[session]:[],active:()=>[],confirm:async({sessions})=>{asked=true;assert.deepEqual(sessions,[session]);return true;},save:async()=>{saved=value;}});assert.equal(result,true);assert.equal(asked,true);assert.equal(saved,'last character');});
test('failed flush never asks for or allows exit',async()=>{let asked=false;await assert.rejects(prepareExit({flush:async()=>{throw new Error('sync failed');},dirty:()=>[],active:()=>[],confirm:async()=>{asked=true;return true;},save:async()=>{}}),/sync failed/);assert.equal(asked,false);});
test('cancel exit preserves the working session without saving',async()=>{let saved=false;assert.equal(await prepareExit({flush:async()=>{},dirty:()=>[{}],active:()=>[],confirm:async()=>false,save:async()=>{saved=true;}}),false);assert.equal(saved,false);});
test('save failure keeps exit unauthorized',async()=>{await assert.rejects(prepareExit({flush:async()=>{},dirty:()=>[{}],active:()=>[],confirm:async()=>true,save:async()=>{throw new Error('disk full');}}),/disk full/);});
