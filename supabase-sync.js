/* Supabase Auth + shared household state. No private/service keys belong here. */
(() => {
  const CONFIG_KEY='income-supabase-config-v1';
  const DEFAULT_CONFIG={url:'https://gftgurqxibkcueimsquz.supabase.co',key:'sb_publishable_O9mp1Y-ujrJQP6o6JM9WMg_Pj8dP5JW'};
  const HOUSEHOLD_KEY='income-supabase-household-v1';
  const REVISION_KEY='income-supabase-revision-v1';
  let client=null,session=null,householdId=localStorage.getItem(HOUSEHOLD_KEY)||'',revision=Number(localStorage.getItem(REVISION_KEY)||0),channel=null,saving=false,pushTimer=null;

  const config=()=>{try{return JSON.parse(localStorage.getItem(CONFIG_KEY)||'null')||DEFAULT_CONFIG}catch{return DEFAULT_CONFIG}};
  const stamp=value=>{const n=Date.parse(value||0);return Number.isFinite(n)?n:0};
  const newer=(a,b)=>stamp(a?.updatedAt)>=stamp(b?.updatedAt)?a:b;

  function mergePayload(cloud={},local={}){
    const deleted=new Map();
    [...(cloud.deletedItems||[]),...(local.deletedItems||[])].forEach(x=>{const id=String(x.id),old=deleted.get(id);if(!old||stamp(x.updatedAt)>=stamp(old.updatedAt))deleted.set(id,x)});
    const mergedItems=new Map();
    [...(cloud.items||[]),...(local.items||[])].forEach(x=>{const id=String(x.id),old=mergedItems.get(id);if(!old||stamp(x.updatedAt)>=stamp(old.updatedAt))mergedItems.set(id,x)});
    deleted.forEach((entry,id)=>{const item=mergedItems.get(id);if(!item||stamp(entry.updatedAt)>=stamp(item.updatedAt))mergedItems.delete(id)});
    const financeSource=stamp(local.financeUpdatedAt)>=stamp(cloud.financeUpdatedAt)?local:cloud;
    const categorySource=stamp(local.categoriesUpdatedAt)>=stamp(cloud.categoriesUpdatedAt)?local:cloud;
    const activityMap=new Map();
    [...(cloud.activity||[]),...(local.activity||[])].forEach(x=>activityMap.set(String(x.id),x));
    return {
      version:6,updatedAt:new Date().toISOString(),items:[...mergedItems.values()],deletedItems:[...deleted.values()],
      finance:financeSource.finance||local.finance||cloud.finance||{},financeUpdatedAt:financeSource.financeUpdatedAt||local.financeUpdatedAt||cloud.financeUpdatedAt,
      categories:categorySource.categories||local.categories||cloud.categories||[],categoriesUpdatedAt:categorySource.categoriesUpdatedAt||local.categoriesUpdatedAt||cloud.categoriesUpdatedAt,
      activity:[...activityMap.values()].sort((a,b)=>stamp(a.at)-stamp(b.at)).slice(-250),
      history:cloud.history||local.history||{},historyTotals:cloud.historyTotals||local.historyTotals||{}
    };
  }

  function localPayload(){
    const payload=buildPayload();
    payload.history=history;payload.historyTotals=historyTotals;
    return payload;
  }

  function applyPayload(payload){
    if(!payload||!Array.isArray(payload.items))return;
    applyCloud(payload);
    if(payload.history){Object.keys(history).forEach(k=>delete history[k]);Object.assign(history,payload.history);localStorage.setItem('income-history-v1',JSON.stringify(history))}
    if(payload.historyTotals){Object.keys(historyTotals).forEach(k=>delete historyTotals[k]);Object.assign(historyTotals,payload.historyTotals);localStorage.setItem('income-history-totals-v1',JSON.stringify(historyTotals))}
    render();
  }

  async function initializeClient(){
    const cfg=config();
    if(!cfg?.url||!cfg?.key||!window.supabase?.createClient){setSyncState('error','Настроить');return false}
    client=window.supabase.createClient(cfg.url,cfg.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const result=await client.auth.getSession();session=result.data.session;
    client.auth.onAuthStateChange((_event,next)=>{session=next;if(next)connect().catch(showError);else{householdId='';setSyncState('error','Войти')}});
    if(!session){
      setSyncState('error','Войти');
      const onboardingKey='income-supabase-onboarding-shown-v1';
      if(location.protocol==='https:'&&!localStorage.getItem(onboardingKey)){
        localStorage.setItem(onboardingKey,'1');
        setTimeout(openSupabaseSettings,320);
      }
      return false;
    }
    await connect();return true;
  }

  async function findHousehold(){
    const {data,error}=await client.from('household_members').select('household_id,role,households(name,invite_code)').eq('user_id',session.user.id).maybeSingle();
    if(error)throw error;
    householdId=data?.household_id||'';
    if(householdId)localStorage.setItem(HOUSEHOLD_KEY,householdId);else localStorage.removeItem(HOUSEHOLD_KEY);
    return data;
  }

  async function connect(){
    if(!session)return;
    setSyncState('','Загрузка');
    const membership=await findHousehold();
    if(!membership){setSyncState('error','Создать семью');return}
    const {data,error}=await client.from('app_state').select('payload,revision,updated_at').eq('household_id',householdId).single();
    if(error)throw error;
    revision=Number(data.revision||0);localStorage.setItem(REVISION_KEY,String(revision));
    const remote=data.payload||{};
    const local=localPayload();
    if(Array.isArray(remote.items)&&remote.items.length){
      const localModified=Math.max(stamp(local.financeUpdatedAt),stamp(local.categoriesUpdatedAt),...(local.items||[]).map(x=>stamp(x.updatedAt)),...(local.deletedItems||[]).map(x=>stamp(x.updatedAt)));
      if(localModified>stamp(remote.updatedAt)){applyPayload(mergePayload(remote,local));await saveNow()}
      else applyPayload(remote);
    }
    else if(local.items?.length||Object.keys(local.history||{}).length||Object.keys(local.historyTotals||{}).length){await saveNow()}
    subscribe();setSyncState('ok','Сохранено');
  }

  function subscribe(){
    if(channel)client.removeChannel(channel);
    channel=client.channel(`income-state-${householdId}`).on('postgres_changes',{event:'UPDATE',schema:'public',table:'app_state',filter:`household_id=eq.${householdId}`},payload=>{
      const row=payload.new;if(saving||Number(row.revision)<=revision)return;
      revision=Number(row.revision);localStorage.setItem(REVISION_KEY,String(revision));applyPayload(mergePayload(row.payload||{},localPayload()));setSyncState('ok','Обновлено');
    }).subscribe();
  }

  async function saveNow(attempt=0){
    if(!client||!session||!householdId)return;
    saving=true;setSyncState('','Сохранение');
    try{
      const {data,error}=await client.rpc('save_app_state',{p_household_id:householdId,p_payload:localPayload(),p_expected_revision:revision});
      if(error)throw error;
      if(data?.conflict&&attempt<2){revision=Number(data.revision);applyPayload(mergePayload(data.payload||{},localPayload()));return await saveNow(attempt+1)}
      if(!data?.ok)throw new Error('Не удалось сохранить изменения');
      revision=Number(data.revision);localStorage.setItem(REVISION_KEY,String(revision));setSyncState('ok','Сохранено');
    }finally{saving=false}
  }

  function scheduleSupabase(){
    clearTimeout(pushTimer);
    if(!client||!session||!householdId){setSyncState('error',navigator.onLine?'Войти':'Офлайн');return}
    setSyncState('','Сохранение');pushTimer=setTimeout(()=>saveNow().catch(showError),700);
  }

  function showError(error){console.error(error);setSyncState('error',navigator.onLine?'Ошибка':'Офлайн');toast('Не удалось синхронизировать данные')}

  function installSettingsButton(){
    if(!document.getElementById('supabaseSettings')){
      const hidden=document.createElement('button');hidden.id='supabaseSettings';hidden.hidden=true;document.body.append(hidden);hidden.onclick=openSupabaseSettings;
    }
  }

  async function openSupabaseSettings(){
    const cfg=config();
    if(!cfg?.url||!cfg?.key){
      openUtility('Подключить Supabase',`<p class="sync-status">Создайте приватный проект Supabase и вставьте два публичных параметра из Project Settings → API.</p><label>Project URL<input id="sbUrl" type="url" placeholder="https://…supabase.co"></label><label>Publishable key<input id="sbKey" autocomplete="off" placeholder="sb_publishable_…"></label><div class="utility-actions"><button class="utility-primary" id="saveSupabaseConfig">Сохранить</button></div>`);
      $('saveSupabaseConfig').onclick=()=>{const url=$('sbUrl').value.trim(),key=$('sbKey').value.trim();if(!url||!key)return;localStorage.setItem(CONFIG_KEY,JSON.stringify({url,key}));closeUtility();location.reload()};return;
    }
    if(!client)await initializeClient();
    if(!session){
      openUtility('Вход в приложение',`<p class="sync-status">На почту придёт безопасная ссылка для входа. Пароль не требуется.</p><label>Email<input id="sbEmail" type="email" autocomplete="email" placeholder="name@gmail.com"></label><div class="utility-actions"><button class="utility-primary" id="sendMagicLink">Получить ссылку</button><button class="utility-secondary" id="resetSupabaseConfig">Изменить подключение</button></div><p class="sync-status" id="sbAuthStatus"></p>`);
      $('sendMagicLink').onclick=async()=>{const email=$('sbEmail').value.trim();if(!email)return;$('sbAuthStatus').textContent='Отправляем…';const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.href.split('#')[0]}});$('sbAuthStatus').textContent=error?'Не удалось отправить: '+error.message:'Письмо отправлено. Откройте ссылку на этом устройстве.'};
      $('resetSupabaseConfig').onclick=()=>{localStorage.removeItem(CONFIG_KEY);location.reload()};return;
    }
    const membership=await findHousehold();
    if(!membership){
      openUtility('Семейный доступ',`<p class="sync-status">Создайте новое семейное пространство на первом телефоне. На втором — введите код приглашения.</p><label>Название<input id="householdName" value="Моя семья"></label><div class="utility-actions"><button class="utility-primary" id="createHousehold">Создать пространство</button></div><label style="margin-top:18px">Код приглашения<input id="inviteCode" autocapitalize="characters" placeholder="XXXXXXXXXX"></label><div class="utility-actions"><button class="utility-secondary" id="joinHousehold">Присоединиться</button></div><p class="sync-status" id="householdStatus"></p>`);
      $('createHousehold').onclick=async()=>{const {data,error}=await client.rpc('create_household',{p_name:$('householdName').value.trim()||'Моя семья'});if(error){$('householdStatus').textContent=error.message;return}householdId=data?.[0]?.household_id||'';localStorage.setItem(HOUSEHOLD_KEY,householdId);closeUtility();await connect();openSupabaseSettings()};
      $('joinHousehold').onclick=async()=>{const {data,error}=await client.rpc('join_household',{p_invite_code:$('inviteCode').value.trim()});if(error){$('householdStatus').textContent=error.message;return}householdId=data;localStorage.setItem(HOUSEHOLD_KEY,householdId);closeUtility();await connect()};return;
    }
    const household=membership.households||{};
    openUtility('Supabase',`<div class="settings-status"><span class="settings-status-dot"></span><span><b>${escapeHtml(household.name||'Семейное пространство')}</b><small>${escapeHtml(session.user.email||'')} · синхронизация включена</small></span></div><label>Код для второго телефона<input value="${escapeHtml(household.invite_code||'')}" readonly></label><div class="utility-actions"><button class="utility-primary" id="syncSupabaseNow">Синхронизировать сейчас</button><button class="utility-secondary" id="signOutSupabase">Выйти</button><button class="utility-secondary" id="resetSupabaseConfig">Изменить подключение</button></div>`);
    $('syncSupabaseNow').onclick=()=>saveNow().then(()=>toast('Синхронизация завершена')).catch(showError);
    $('signOutSupabase').onclick=async()=>{await client.auth.signOut();closeUtility();location.reload()};
    $('resetSupabaseConfig').onclick=()=>{localStorage.removeItem(CONFIG_KEY);closeUtility();location.reload()};
  }

  window.openSupabaseSettings=openSupabaseSettings;
  window.scheduleCloudSync=scheduleSupabase;
  window.addEventListener('online',()=>initializeClient().catch(showError));
  window.addEventListener('offline',()=>setSyncState('error','Офлайн'));
  installSettingsButton();
  localStorage.removeItem('income-google-sync-url');
  initializeClient().catch(showError);
})();
