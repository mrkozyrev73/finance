/* Google Sheets sync through private Apps Script URL with token. */
(() => {
  const URL_KEY='income-google-sync-url';
  const LAST_ERROR_KEY='income-google-sync-last-error';
  const DEFAULT_SYNC_URL='https://script.google.com/macros/s/AKfycbzBXlkqbd2v7ZkJdWMVgx6-l3GjvAyNeBk8NSXDL3D7EWo25s18RZ-m1hTa0TuPhotb/exec?token=ba276cd4-fd9c-44cf-8446-13685ebacc47669ea6f4ae1e4b5fa03ee2a72916c680';
  let syncUrl=localStorage.getItem(URL_KEY)||DEFAULT_SYNC_URL;
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
    applyCloud({
      ...payload,
      finance:payload.finance||{},
      deletedItems:payload.deletedItems||[],
      activity:payload.activity||[]
    });
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
    const text=await response.text();
    const data=JSON.parse(text);
    if(data?.ok===false)throw new Error(data.error||'Google sync error');
    return data;
  }

  async function writeGoogle(){
    if(!syncUrl){setSyncState('error','Google');return}
    setSyncState('','Сохранение');
    const response=await fetch(syncUrl,{
      method:'POST',
      body:JSON.stringify(localPayload())
    });
    const text=await response.text();
    if(text.trim().startsWith('<'))throw new Error('Google вернул страницу вместо ответа. Проверьте развертывание Apps Script.');
    const data=JSON.parse(text);
    if(data?.ok===false)throw new Error(data.error||'Google sync error');
    if(data?.payload)applyGooglePayload(data.payload);
    localStorage.removeItem(LAST_ERROR_KEY);
    setSyncState('ok','Google');
  }

  async function connectGoogle(){
    if(!syncUrl){setSyncState('error','Google');return}
    setSyncState('','Загрузка');
    const remote=await readGoogle();
    const hasRemote=Array.isArray(remote?.items);
    if(hasRemote){
      applyGooglePayload(remote);
      localStorage.removeItem(LAST_ERROR_KEY);
      setSyncState('ok','Google');
      return;
    }
    throw new Error('Google не вернул данные таблицы');
  }

  function scheduleGoogleSync(){
    clearTimeout(pushTimer);
    if(!syncUrl){setSyncState('error','Google');return}
    setSyncState('','Сохранение');
    pushTimer=setTimeout(()=>writeGoogle().catch(showGoogleError),700);
  }

  function showGoogleError(error){
    console.error(error);
    localStorage.setItem(LAST_ERROR_KEY,error?.message||'Ошибка Google');
    setSyncState('error',navigator.onLine?'Ошибка Google':'Офлайн');
    toast('Google Таблица не синхронизировалась');
  }

  function openGoogleSettings(){
    openUtility('Google Таблица',`
      <p class="sync-status">Вставьте адрес веб-приложения Apps Script вместе с секретным token. Сама таблица остаётся закрытой.</p>
      <label>Адрес синхронизации<input id="googleSyncUrl" type="url" value="${escapeHtml(syncUrl)}" placeholder="https://script.google.com/macros/s/.../exec?token=..."></label>
      <div class="utility-actions">
        <button class="utility-primary" id="saveGoogleSync">Сохранить</button>
        <button class="utility-secondary" id="syncGoogleNow">Загрузить из Google</button>
        <button class="utility-secondary" id="clearGoogleSync">Отключить</button>
      </div>
      <p class="sync-status" id="googleSyncStatus">${escapeHtml(localStorage.getItem(LAST_ERROR_KEY)||'')}</p>`);
    $('saveGoogleSync').onclick=async()=>{
      const value=$('googleSyncUrl').value.trim();
      if(!value){$('googleSyncStatus').textContent='Вставьте адрес Apps Script с token.';return}
      syncUrl=value;
      localStorage.setItem(URL_KEY,value);
      $('googleSyncStatus').textContent='Подключаем…';
      try{await connectGoogle();closeUtility()}catch(error){localStorage.setItem(LAST_ERROR_KEY,error.message||'Не удалось подключить Google');$('googleSyncStatus').textContent=error.message||'Не удалось подключить Google'}
    };
    $('syncGoogleNow').onclick=()=>connectGoogle().then(()=>{$('googleSyncStatus').textContent='Загружено из Google'}).catch(error=>{localStorage.setItem(LAST_ERROR_KEY,error.message||'Ошибка Google');$('googleSyncStatus').textContent=error.message||'Ошибка Google'});
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
