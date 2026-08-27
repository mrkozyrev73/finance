/* Google Sheets sync through private Apps Script URL with token. */
(() => {
  const URL_KEY='income-google-sync-url';
  let syncUrl=localStorage.getItem(URL_KEY)||'';
  let pushTimer=null;

  const stamp=value=>{
    const parsed=Date.parse(value||0);
    return Number.isFinite(parsed)?parsed:0;
  };

  function localPayload(){
    const payload=buildPayload();
    payload.history=history;
    payload.historyTotals=historyTotals;
    return payload;
  }

  function applyGooglePayload(payload){
    if(!payload||!Array.isArray(payload.items))return;
    applyCloud(payload);
    if(payload.history){
      Object.keys(history).forEach(key=>delete history[key]);
      Object.assign(history,payload.history);
      localStorage.setItem('income-history-v1',JSON.stringify(history));
    }
    if(payload.historyTotals){
      Object.keys(historyTotals).forEach(key=>delete historyTotals[key]);
      Object.assign(historyTotals,payload.historyTotals);
      localStorage.setItem('income-history-totals-v1',JSON.stringify(historyTotals));
    }
    render();
  }

  async function readGoogle(){
    if(!syncUrl)return null;
    const response=await fetch(syncUrl,{method:'GET',cache:'no-store'});
    const data=await response.json();
    if(data?.ok===false)throw new Error(data.error||'Google sync error');
    return data;
  }

  async function writeGoogle(){
    if(!syncUrl){setSyncState('error','Google');return}
    setSyncState('','Сохранение');
    const response=await fetch(syncUrl,{
      method:'POST',
      headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify(localPayload())
    });
    const data=await response.json();
    if(data?.ok===false)throw new Error(data.error||'Google sync error');
    if(data?.payload)applyGooglePayload(data.payload);
    setSyncState('ok','Google');
  }

  async function connectGoogle(){
    if(!syncUrl){setSyncState('error','Google');return}
    setSyncState('','Загрузка');
    const remote=await readGoogle();
    const local=localPayload();
    const hasRemote=Array.isArray(remote?.items)&&remote.items.length;
    const localModified=Math.max(
      stamp(local.financeUpdatedAt),
      stamp(local.categoriesUpdatedAt),
      ...(local.items||[]).map(item=>stamp(item.updatedAt)),
      ...(local.deletedItems||[]).map(item=>stamp(item.updatedAt))
    );
    if(hasRemote){
      if(localModified>stamp(remote.updatedAt)){
        await writeGoogle();
      }else{
        applyGooglePayload(remote);
        setSyncState('ok','Google');
      }
      return;
    }
    if((local.items||[]).length||Object.keys(local.history||{}).length)await writeGoogle();
    else setSyncState('ok','Google');
  }

  function scheduleGoogleSync(){
    clearTimeout(pushTimer);
    if(!syncUrl){setSyncState('error','Google');return}
    setSyncState('','Сохранение');
    pushTimer=setTimeout(()=>writeGoogle().catch(showGoogleError),700);
  }

  function showGoogleError(error){
    console.error(error);
    setSyncState('error',navigator.onLine?'Ошибка Google':'Офлайн');
    toast('Google Таблица не синхронизировалась');
  }

  function openGoogleSettings(){
    openUtility('Google Таблица',`
      <p class="sync-status">Вставьте адрес веб-приложения Apps Script вместе с секретным token. Сама таблица остаётся закрытой.</p>
      <label>Адрес синхронизации<input id="googleSyncUrl" type="url" value="${escapeHtml(syncUrl)}" placeholder="https://script.google.com/macros/s/.../exec?token=..."></label>
      <div class="utility-actions">
        <button class="utility-primary" id="saveGoogleSync">Сохранить</button>
        <button class="utility-secondary" id="syncGoogleNow">Синхронизировать сейчас</button>
        <button class="utility-secondary" id="clearGoogleSync">Отключить</button>
      </div>
      <p class="sync-status" id="googleSyncStatus"></p>`);
    $('saveGoogleSync').onclick=async()=>{
      const value=$('googleSyncUrl').value.trim();
      if(!value){$('googleSyncStatus').textContent='Вставьте адрес Apps Script с token.';return}
      syncUrl=value;
      localStorage.setItem(URL_KEY,value);
      $('googleSyncStatus').textContent='Подключаем…';
      try{await connectGoogle();closeUtility();toast('Google Таблица подключена')}catch(error){$('googleSyncStatus').textContent=error.message||'Не удалось подключить Google'}
    };
    $('syncGoogleNow').onclick=()=>writeGoogle().then(()=>toast('Данные отправлены в Google')).catch(error=>$('googleSyncStatus').textContent=error.message||'Ошибка Google');
    $('clearGoogleSync').onclick=()=>{syncUrl='';localStorage.removeItem(URL_KEY);setSyncState('error','Google');closeUtility();toast('Google отключён')};
  }

  if(!document.getElementById('googleSettings')){
    const button=document.createElement('button');
    button.id='googleSettings';
    button.hidden=true;
    button.onclick=openGoogleSettings;
    document.body.append(button);
  }

  window.openGoogleSettings=openGoogleSettings;
  window.scheduleCloudSync=scheduleGoogleSync;
  window.addEventListener('online',()=>connectGoogle().catch(showGoogleError));
  window.addEventListener('offline',()=>setSyncState('error','Офлайн'));
  connectGoogle().catch(showGoogleError);
})();
