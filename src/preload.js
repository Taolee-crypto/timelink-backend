const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tlAPI', {
  parseTLFile:    (fp)    => ipcRenderer.invoke('parse-tl-file', fp),
  decryptStream:  (opts)  => ipcRenderer.invoke('decrypt-stream', opts),
  tlTick:         (opts)  => ipcRenderer.invoke('tl-tick', opts),
  openFileDialog: ()      => ipcRenderer.invoke('open-file-dialog'),
  storeGet:       (k)     => ipcRenderer.invoke('store-get', k),
  storeSet:       (k,v)   => ipcRenderer.invoke('store-set', k, v),
  onTLFileOpen:   (cb)    => ipcRenderer.on('tl-file-open', (_e, fp) => cb(fp)),
});
