# grnbck Properties – Desktop Database (Tauri + React + Supabase)

A cross‑platform desktop app (Windows/macOS) for recording and analysing London property deals for **grnbck**.

This template uses:
- **Tauri v2** (desktop shell) citeturn0search0turn0search22
- **React + Vite + TypeScript** (modern UI)
- **Supabase (hosted Postgres)** for shared, multi‑user data across computers citeturn0search4turn0search17

> Why Supabase: you said data must be accessible from different computers/users. That requires a shared backend (cloud or on‑prem). Supabase is the quickest solid option.

---

## 1) Create the Supabase database

### 1.1 Create a new Supabase project
In the Supabase dashboard:
- Create a project
- Enable **Email** auth (default)

### 1.2 Run this SQL in the Supabase SQL editor

```sql
-- Enable UUID generation if not already
create extension if not exists pgcrypto;

create table if not exists public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references public.organisations(id) on delete restrict,
  role text not null default 'member',
  created_at timestamptz not null default now()
);

create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  address text not null,
  borough text,
  area text,
  selling_agent text,
  listing_url text,

  in_spv boolean not null default false,

  sqm numeric,
  price_gbp numeric, -- purchase price (excluding fees)
  taxes_and_fees_gbp numeric, -- stamp duty + legal + other fees
  opex_per_sqm_gbp_per_year numeric, -- maintenance/ops per sqm per year
  annual_rent_gbp numeric -- gross annual rent
);

create index if not exists idx_properties_org on public.properties(org_id);
create index if not exists idx_profiles_org on public.profiles(org_id);

-- Updated_at trigger
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_properties_updated_at on public.properties;
create trigger trg_properties_updated_at
before update on public.properties
for each row execute procedure public.set_updated_at();

-- Row Level Security
alter table public.organisations enable row level security;
alter table public.profiles enable row level security;
alter table public.properties enable row level security;

-- Organisations:
-- Users can read the organisation they belong to
drop policy if exists "org_read_own" on public.organisations;
create policy "org_read_own"
on public.organisations
for select
to authenticated
using (
  id = (select org_id from public.profiles where id = auth.uid())
);

-- Profiles:
-- Users can read their own profile
drop policy if exists "profiles_read_own" on public.profiles;
create policy "profiles_read_own"
on public.profiles
for select
to authenticated
using (id = auth.uid());

-- Properties:
-- Users can CRUD properties for their org
drop policy if exists "properties_select_own_org" on public.properties;
create policy "properties_select_own_org"
on public.properties
for select
to authenticated
using (
  org_id = (select org_id from public.profiles where id = auth.uid())
);

drop policy if exists "properties_insert_own_org" on public.properties;
create policy "properties_insert_own_org"
on public.properties
for insert
to authenticated
with check (
  org_id = (select org_id from public.profiles where id = auth.uid())
  and created_by = auth.uid()
);

drop policy if exists "properties_update_own_org" on public.properties;
create policy "properties_update_own_org"
on public.properties
for update
to authenticated
using (
  org_id = (select org_id from public.profiles where id = auth.uid())
)
with check (
  org_id = (select org_id from public.profiles where id = auth.uid())
);

drop policy if exists "properties_delete_own_org" on public.properties;
create policy "properties_delete_own_org"
on public.properties
for delete
to authenticated
using (
  org_id = (select org_id from public.profiles where id = auth.uid())
);
```

### 1.3 Create your organisation row
In **Table Editor → organisations** create:
- `name = grnbck`

Copy the generated `id` (UUID). You will use it for profiles.

### 1.4 Create user profiles
When a user signs up in the app, go to **Table Editor → profiles** and add a row:
- `id` = that user’s `auth.users.id`
- `org_id` = your `organisations.id` for grnbck

> The app intentionally doesn’t auto‑assign orgs because that typically needs an admin flow or a server-side service key.

---

## 2) Configure the app

Create a file `.env` in the project root:

```bash
VITE_SUPABASE_URL="https://YOURPROJECT.supabase.co"
VITE_SUPABASE_ANON_KEY="YOUR_ANON_KEY"
```

Supabase URLs/anon keys are expected to be used on the client; security comes from **RLS policies**. citeturn0search10turn0search17

---

## 3) Run locally (dev)

### Prereqs
Follow the official Tauri prerequisites for your OS (Rust, platform toolchains). citeturn0search12turn0search14

### Install + run

```bash
npm install
npm run tauri dev
```

---

## 4) Build installers

```bash
npm run tauri build
```

Tauri will output platform installers/bundles in `src-tauri/target/release/bundle/`.

---

## What’s in the app
- Email/password login
- Properties table view with search + sort
- Add/Edit/Delete property records
- Automatic yield calculation:

`yield = (annual_rent - opex_per_sqm*sqm) / (price + taxes_and_fees)`

(If any inputs are missing, yield is left blank.)

---

## Next upgrades (easy add-ons)
- Attachments (store PDFs/photos in Supabase Storage)
- Deal stages (screening → offer → acquired → sold)
- Cashflow modelling (IRR, DSCR, financing terms)
- Import/export CSV

