-- «Мои доходы»: закрытое семейное пространство Supabase.
-- Запустите целиком в Supabase → SQL Editor один раз.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Моя семья',
  invite_code text not null unique default upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 10)),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.app_state (
  household_id uuid primary key references public.households(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create index if not exists household_members_user_idx on public.household_members(user_id);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.app_state enable row level security;

revoke all on public.households, public.household_members, public.app_state from anon;
revoke all on public.households, public.household_members, public.app_state from authenticated;
grant select on public.households, public.household_members, public.app_state to authenticated;
grant insert, update on public.app_state to authenticated;

create or replace function public.is_household_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1 from public.household_members m
    where m.household_id = target and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_household_member(uuid) from public, anon;
grant execute on function public.is_household_member(uuid) to authenticated;

drop policy if exists "members read households" on public.households;
create policy "members read households" on public.households for select to authenticated
using ((select public.is_household_member(id)));

drop policy if exists "members read memberships" on public.household_members;
create policy "members read memberships" on public.household_members for select to authenticated
using ((select public.is_household_member(household_id)));

drop policy if exists "members read state" on public.app_state;
create policy "members read state" on public.app_state for select to authenticated
using ((select public.is_household_member(household_id)));

drop policy if exists "members create state" on public.app_state;
create policy "members create state" on public.app_state for insert to authenticated
with check ((select public.is_household_member(household_id)) and updated_by = (select auth.uid()));

drop policy if exists "members update state" on public.app_state;
create policy "members update state" on public.app_state for update to authenticated
using ((select public.is_household_member(household_id)))
with check ((select public.is_household_member(household_id)) and updated_by = (select auth.uid()));

create or replace function public.create_household(p_name text default 'Моя семья')
returns table(household_id uuid, invite_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare new_id uuid; new_code text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.household_members where user_id = auth.uid()) then
    raise exception 'User already belongs to a household';
  end if;
  insert into public.households(name, created_by)
  values(coalesce(nullif(trim(p_name),''),'Моя семья'), auth.uid())
  returning id, invite_code into new_id, new_code;
  insert into public.household_members(household_id,user_id,role) values(new_id,auth.uid(),'owner');
  insert into public.app_state(household_id,payload,revision,updated_by) values(new_id,'{}'::jsonb,0,auth.uid());
  return query select new_id,new_code;
end;
$$;

create or replace function public.join_household(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.household_members where user_id = auth.uid()) then
    raise exception 'User already belongs to a household';
  end if;
  select id into target from public.households where invite_code = upper(trim(p_invite_code));
  if target is null then raise exception 'Invite code not found'; end if;
  insert into public.household_members(household_id,user_id,role) values(target,auth.uid(),'member');
  return target;
end;
$$;

create or replace function public.save_app_state(p_household_id uuid, p_payload jsonb, p_expected_revision bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare current_row public.app_state%rowtype;
begin
  select * into current_row from public.app_state where household_id = p_household_id for update;
  if not found then raise exception 'Household state not found'; end if;
  if current_row.revision <> p_expected_revision then
    return jsonb_build_object('ok',false,'conflict',true,'revision',current_row.revision,'payload',current_row.payload);
  end if;
  update public.app_state set payload=p_payload,revision=revision+1,updated_by=(select auth.uid()),updated_at=now()
  where household_id=p_household_id;
  return jsonb_build_object('ok',true,'revision',current_row.revision+1,'payload',p_payload);
end;
$$;

revoke all on function public.create_household(text), public.join_household(text), public.save_app_state(uuid,jsonb,bigint) from public, anon;
grant execute on function public.create_household(text), public.join_household(text), public.save_app_state(uuid,jsonb,bigint) to authenticated;

-- Для двух телефонов достаточно Postgres Changes; таблица маленькая.
do $$ begin
  alter publication supabase_realtime add table public.app_state;
exception when duplicate_object then null;
end $$;
