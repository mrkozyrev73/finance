/* «Мои доходы» — слой данных Supabase (замена Google Sheets).
   Модель: всё состояние приложения хранится как единый JSON payload в таблице
   public.app_state (одна строка на household), под защитой RLS. Локальный localStorage
   используется только как кеш/офлайн-буфер, источник истины — Supabase.
   Вход: только по паролю (никаких magic link). service_role во фронте нет —
   только публичный publishable/anon-ключ. */
(() => {
  const CONFIG_KEY='income-supabase-config-v1';
  const HOUSEHOLD_KEY='income-supabase-household-v1';
  const REVISION_KEY='income-supabase-revision-v1';
  const LAST_ERROR_KEY='income-supabase-last-error';
  // Публичные параметры проекта (можно переопределить в настройках приложения).
  const DEFAULT_CONFIG={
    url:'https://gftgurqxibkcueimsquz.supabase.co',
    key:'sb_publishable_O9mp1Y-ujrJQP6o6JM9WMg_Pj8dP5JW'
  };

  let client=null,session=null;
  let householdId=localStorage.getItem(HOUSEHOLD_KEY)||'';
  let revision=Number(localStorage.getItem(REVISION_KEY)||0);
  let channel=null,saving=false,pushTimer=null,connecting=null;

  const config=()=>{try{return JSON.parse(localStorage.getItem(CONFIG_KEY)||'null')||DEFAULT_CONFIG}catch{return DEFAULT_CONFIG}};
  const stamp=value=>{const n=Date.parse(value||0);return Number.isFinite(n)?n:0};

  /* ---------- payload <-> приложение ---------- */
  function localPayload(){
    const payload=buildPayload();
    payload.history=history;
    payload.historyTotals=historyTotals;
    return payload;
  }

  function applyPayload(payload){
    if(!payload||!Array.isArray(payload.items))return;
    applyCloud({
      ...payload,
      finance:payload.finance||{},
      deletedItems:payload.deletedItems||[],
      activity:payload.activity||[]
    });
    if(payload.history){
      Object.keys(history).forEach(k=>delete history[k]);
      Object.assign(history,payload.history);
      localStorage.setItem('income-history-v1',JSON.stringify(history));
    }
    if(payload.historyTotals){
      Object.keys(historyTotals).forEach(k=>delete historyTotals[k]);
      Object.assign(historyTotals,payload.historyTotals);
      localStorage.setItem('income-history-totals-v1',JSON.stringify(historyTotals));
    }
    render();
  }

  function mergePayload(cloud={},local={}){
    const deleted=new Map();
    [...(cloud.deletedItems||[]),...(local.deletedItems||[])].forEach(x=>{const id=String(x.id),old=deleted.get(id);if(!old||stamp(x.updatedAt)>=stamp(old.updatedAt))deleted.set(id,x)});
    const items=new Map();
    [...(cloud.items||[]),...(local.items||[])].forEach(x=>{const id=String(x.id),old=items.get(id);if(!old||stamp(x.updatedAt)>=stamp(old.updatedAt))items.set(id,x)});
    deleted.forEach((entry,id)=>{const item=items.get(id);if(!item||stamp(entry.updatedAt)>=stamp(item.updatedAt))items.delete(id)});
    const financeSrc=stamp(local.financeUpdatedAt)>=stamp(cloud.financeUpdatedAt)?local:cloud;
    const catSrc=stamp(local.categoriesUpdatedAt)>=stamp(cloud.categoriesUpdatedAt)?local:cloud;
    const activity=new Map();
    [...(cloud.activity||[]),...(local.activity||[])].forEach(x=>activity.set(String(x.id),x));
    return {
      version:6,updatedAt:new Date().toISOString(),
      items:[...items.values()],deletedItems:[...deleted.values()],
      finance:financeSrc.finance||local.finance||cloud.finance||{},financeUpdatedAt:financeSrc.financeUpdatedAt||local.financeUpdatedAt||cloud.financeUpdatedAt,
      categories:catSrc.categories||local.categories||cloud.categories||[],categoriesUpdatedAt:catSrc.categoriesUpdatedAt||local.categoriesUpdatedAt||cloud.categoriesUpdatedAt,
      activity:[...activity.values()].sort((a,b)=>stamp(a.at)-stamp(b.at)).slice(-250),
      history:cloud.history||local.history||{},historyTotals:cloud.historyTotals||local.historyTotals||{}
    };
  }
  /* ---------- ошибки (никогда не трём локальные данные) ---------- */
  function showError(error){
    console.error('[supabase]',error);
    localStorage.setItem(LAST_ERROR_KEY,String(error?.message||error||'Ошибка'));
    setSyncState('error',navigator.onLine?'Ошибка':'Офлайн');
  }

  /* ---------- клиент и авторизация ---------- */
  async function initializeClient(){
    const cfg=config();
    if(!cfg?.url||!cfg?.key){setSyncState('error','Настроить');return false}
    if(!window.supabase?.createClient){setSyncState('error','Обновить');return false}
    if(!client){
      client=window.supabase.createClient(cfg.url,cfg.key,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
      });
      client.auth.onAuthStateChange((_event,next)=>{
        session=next||null;
        if(session)connect().catch(showError);
        else{householdId='';setSyncState('error','Войти')}
      });
    }
    const {data}=await client.auth.getSession();
    session=data.session||null;
    if(!session){setSyncState('error','Войти');return false}
    await connect();
    return true;
  }

  async function findHousehold(){
    const {data,error}=await client.from('household_members')
      .select('household_id,role,households(name,invite_code)')
      .eq('user_id',session.user.id).maybeSingle();
    if(error)throw error;
    householdId=data?.household_id||'';
    if(householdId)localStorage.setItem(HOUSEHOLD_KEY,householdId);else localStorage.removeItem(HOUSEHOLD_KEY);
    return data;
  }

  // Создаётся молча при первом входе; терпит гонку (второй параллельный вызов).
  async function ensureHousehold(){
    let membership=await findHousehold();
    if(membership&&householdId)return membership;
    try{
      const {data,error}=await client.rpc('create_household',{p_name:'Семья'});
      if(error)throw error;
      householdId=data?.[0]?.household_id||'';
    }catch(error){
      membership=await findHousehold();
      if(membership&&householdId)return membership;
      throw error;
    }
    if(householdId)localStorage.setItem(HOUSEHOLD_KEY,householdId);
    return {household_id:householdId};
  }

  /* ---------- загрузка/слияние/подписка ---------- */
  function connect(){
    if(connecting)return connecting;
    connecting=doConnect().catch(error=>{showError(error);throw error}).finally(()=>{connecting=null});
    return connecting;
  }
  async function doConnect(){
    if(!session)return;
    setSyncState('','Загрузка');
    await ensureHousehold();
    if(!householdId){setSyncState('error','Ошибка');return}
    const {data,error}=await client.from('app_state')
      .select('payload,revision,updated_at').eq('household_id',householdId).maybeSingle();
    if(error)throw error;
    revision=Number(data?.revision||0);localStorage.setItem(REVISION_KEY,String(revision));
    const remote=data?.payload||{};
    const hasRemote=Array.isArray(remote.items)||Boolean(remote.finance)||Boolean(remote.history)||Boolean(remote.historyTotals);
    if(hasRemote){
      // Supabase — источник истины: при каждом подключении сначала принимаем весь payload сервера.
      applyPayload(remote);
    }else{
      applyPayload({version:6,updatedAt:new Date().toISOString(),items:[],deletedItems:[],finance:{},categories:categories||[],activity:[],history:{},historyTotals:{}});
      await saveNow();
    }
    subscribe();
    localStorage.removeItem(LAST_ERROR_KEY);
    setSyncState('ok','Синхронизировано');
  }

  function subscribe(){
    if(channel)client.removeChannel(channel);
    channel=client.channel(`app_state:${householdId}`)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'app_state',filter:`household_id=eq.${householdId}`},payload=>{
        const row=payload.new;
        if(saving||Number(row.revision)<=revision)return;
        revision=Number(row.revision);localStorage.setItem(REVISION_KEY,String(revision));
        // Новая серверная ревизия уже содержит полное состояние приложения.
        applyPayload(row.payload||{});
        setSyncState('ok','Обновлено');
      }).subscribe();
  }

  async function saveNow(attempt=0){
    if(!client||!session||!householdId)return;
    saving=true;setSyncState('','Сохранение');
    try{
      const {data,error}=await client.rpc('save_app_state',{
        p_household_id:householdId,p_payload:localPayload(),p_expected_revision:revision
      });
      if(error)throw error;
      if(data?.conflict&&attempt<2){
        revision=Number(data.revision);
        applyPayload(mergePayload(data.payload||{},localPayload()));
        return await saveNow(attempt+1);
      }
      if(!data?.ok)throw new Error('Не удалось сохранить изменения');
      revision=Number(data.revision);localStorage.setItem(REVISION_KEY,String(revision));
      localStorage.removeItem(LAST_ERROR_KEY);
      setSyncState('ok','Синхронизировано');
    }catch(error){
      showError(error);toast('Не удалось синхронизировать данные');
    }finally{saving=false}
  }

  // Вызывается приложением после каждого изменения (persist).
  function scheduleSupabase(){
    clearTimeout(pushTimer);
    if(!client||!session||!householdId){setSyncState('error',navigator.onLine?'Войти':'Офлайн');return}
    setSyncState('','Сохранение');
    pushTimer=setTimeout(()=>saveNow(),700);
  }

  /* ---------- экран входа / статуса (внутри Настроек) ---------- */
  const authMessage=error=>{const m=String(error?.message||'');
    if(/invalid login/i.test(m))return'Неверный email или пароль.';
    if(/already registered/i.test(m))return'Аккаунт с таким email уже есть — введите правильный пароль.';
    if(/password/i.test(m))return'Пароль должен быть не короче 8 символов.';
    if(/rate|too many/i.test(m))return'Слишком много попыток, подождите минуту.';
    return m||'Не удалось войти.'};

  async function openSupabaseSettings(){
    if(!client)await initializeClient();
    if(!client){openUtility('Синхронизация','<p class="sync-status">Не удалось подключиться к серверу. Проверьте интернет и обновите страницу.</p>');return}

    if(!session){
      openUtility('Вход',`<p class="sync-status">Войдите одним и тем же аккаунтом на обоих телефонах — доходы синхронизируются автоматически. Если аккаунта ещё нет, он создастся сам.</p><label>Email<input id="sbEmail" type="email" autocomplete="email" autocapitalize="off" placeholder="name@mail.com"></label><label>Пароль<input id="sbPassword" type="password" autocomplete="current-password" placeholder="Не менее 8 символов"></label><div class="utility-actions"><button class="utility-primary" id="sbGo">Войти</button></div><p class="sync-status" id="sbAuthStatus"></p>`);
      const go=async()=>{
        const email=$('sbEmail').value.trim(),password=$('sbPassword').value,status=$('sbAuthStatus');
        if(!email||password.length<8){status.textContent='Введите email и пароль не короче 8 символов.';return}
        $('sbGo').disabled=true;status.textContent='Входим…';
        try{
          const signIn=await client.auth.signInWithPassword({email,password});
          if(signIn.error){
            if(/invalid login/i.test(String(signIn.error.message))){
              status.textContent='Создаём аккаунт…';
              const signUp=await client.auth.signUp({email,password});
              if(signUp.error){status.textContent=authMessage(signUp.error);$('sbGo').disabled=false;return}
              if(!signUp.data.session){
                status.textContent='Аккаунт создан, входим…';
                const secondSignIn=await client.auth.signInWithPassword({email,password});
                if(secondSignIn.error){status.textContent=authMessage(secondSignIn.error);$('sbGo').disabled=false;return}
              }
            }else{status.textContent=authMessage(signIn.error);$('sbGo').disabled=false;return}
          }
          session=(await client.auth.getSession()).data.session||session;
          closeUtility();toast('Синхронизация включена');
          await connect();
          openSupabaseSettings();
        }catch(error){showError(error);status.textContent='Ошибка сети. Попробуйте ещё раз.';$('sbGo').disabled=false}
      };
      $('sbGo').onclick=go;
      $('sbPassword').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
      $('sbEmail').addEventListener('keydown',e=>{if(e.key==='Enter')$('sbPassword').focus()});
      setTimeout(()=>$('sbEmail')?.focus(),120);
      return;
    }

    openUtility('Синхронизация',`<div class="settings-status"><span class="settings-status-dot"></span><span><b>Синхронизация включена</b><small>${escapeHtml(session.user.email||'')}</small></span></div><p class="sync-status" id="sbSyncStatus">Тот же email и пароль работают на любом другом телефоне — данные общие. Доступ защищён на сервере (RLS), посторонние ваши записи не видят.</p><div class="utility-actions"><button type="button" class="utility-primary" id="sbSyncNow">Обновить сейчас</button><button type="button" class="utility-secondary" id="sbSignOut">Выйти</button></div>`);
    $('sbSyncNow').onclick=async()=>{const button=$('sbSyncNow'),status=$('sbSyncStatus');button.disabled=true;button.textContent='Загружаем…';status.textContent='Получаем все данные из Supabase…';try{await connect();status.textContent='Все данные загружены из Supabase.';button.textContent='Готово';toast('Данные загружены')}catch(error){showError(error);status.textContent='Не удалось загрузить данные. Проверьте подключение и настройки Supabase.';button.disabled=false;button.textContent='Повторить'}};
    $('sbSignOut').onclick=async()=>{await client.auth.signOut();closeUtility();location.reload()};
  }

  /* ---------- регистрация в приложении ---------- */
  if(!document.getElementById('supabaseSettings')){
    const button=document.createElement('button');
    button.id='supabaseSettings';button.hidden=true;button.onclick=openSupabaseSettings;
    document.body.append(button);
  }
  window.openSupabaseSettings=openSupabaseSettings;
  window.scheduleCloudSync=scheduleSupabase;
  window.addEventListener('online',()=>initializeClient().catch(showError));
  window.addEventListener('offline',()=>setSyncState('error','Офлайн'));
  const syncPill=document.getElementById('syncPill');
  if(syncPill)syncPill.onclick=()=>{if(session&&typeof openSettings==='function')openSettings();else openSupabaseSettings()};
  // остатки Google-конфига больше не нужны
  localStorage.removeItem('income-google-sync-url');
  localStorage.removeItem('income-google-sync-last-error');
  initializeClient().catch(showError);
})();
