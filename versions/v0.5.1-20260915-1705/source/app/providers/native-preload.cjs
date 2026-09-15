'use strict';
const {contextBridge,ipcRenderer}=require('electron');
// No filesystem, provider or arbitrary IPC capability is exposed to the remote frontend.
contextBridge.exposeInMainWorld('createMoreNative',Object.freeze({sync:()=>ipcRenderer.send('createmore:native-sync')}));
