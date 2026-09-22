-- =========================================================
-- UP DRIVE V2
-- University of Phayao Carpooling
-- =========================================================

create extension if not exists pgcrypto;

-- =========================================================
-- DROP OLD TABLES
-- =========================================================

drop table if exists public.driver_locations cascade;
drop table if exists public.ride_routes cascade;
drop table if exists public.ride_group_members cascade;
drop table if exists public.ride_requests cascade;
drop table if exists public.ride_groups cascade;
drop table if exists public.profiles cascade;

-- =========================================================
-- PROFILES
-- =========================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,

  name text not null,

  phone text,

  role text not null
    check (role in ('passenger', 'driver')),

  vehicle_seats integer not null default 4
    check (vehicle_seats between 1 and 10),

  created_at timestamptz not null default now()
);

-- =========================================================
-- RIDE GROUPS
-- =========================================================

create table public.ride_groups (
  id uuid primary key default gen_random_uuid(),

  leader_id uuid not null
    references public.profiles(id),

  target_passengers integer not null
    check (target_passengers between 1 and 10),

  status text not null default 'forming'
    check (
      status in (
        'forming',
        'sent_to_driver',
        'accepted',
        'completed',
        'cancelled'
      )
    ),

  driver_id uuid
    references public.profiles(id),

  created_at timestamptz not null default now(),

  confirmed_at timestamptz,

  accepted_at timestamptz,

  completed_at timestamptz
);

-- =========================================================
-- RIDE REQUESTS
-- =========================================================

create table public.ride_requests (
  id uuid primary key default gen_random_uuid(),

  passenger_id uuid not null
    references public.profiles(id),

  group_id uuid
    references public.ride_groups(id)
    on delete set null,

  origin_text text not null,

  destination_text text not null,

  origin_lat double precision not null,

  origin_lng double precision not null,

  destination_lat double precision not null,

  destination_lng double precision not null,

  target_passengers integer not null
    check (target_passengers between 1 and 10),

  status text not null default 'searching'
    check (
      status in (
        'searching',
        'matched',
        'sent_to_driver',
        'accepted',
        'completed',
        'cancelled'
      )
    ),

  created_at timestamptz not null default now()
);

-- =========================================================
-- GROUP MEMBERS
-- =========================================================

create table public.ride_group_members (
  id uuid primary key default gen_random_uuid(),

  group_id uuid not null
    references public.ride_groups(id)
    on delete cascade,

  ride_request_id uuid not null
    references public.ride_requests(id)
    on delete cascade,

  passenger_id uuid not null
    references public.profiles(id)
    on delete cascade,

  party_size integer not null default 1
    check (party_size between 1 and 10),

  confirmed boolean not null default false,

  joined_at timestamptz not null default now(),

  unique(group_id, passenger_id),

  unique(group_id, ride_request_id)
);

-- =========================================================
-- ROUTES
-- =========================================================

create table public.ride_routes (
  id uuid primary key default gen_random_uuid(),

  group_id uuid not null
    references public.ride_groups(id)
    on delete cascade,

  distance_meters double precision,

  duration_seconds double precision,

  geometry jsonb,

  created_at timestamptz not null default now(),

  unique(group_id)
);

-- =========================================================
-- DRIVER GPS
-- =========================================================

create table public.driver_locations (
  id uuid primary key default gen_random_uuid(),

  driver_id uuid not null
    references public.profiles(id)
    on delete cascade,

  latitude double precision not null,

  longitude double precision not null,

  heading double precision,

  speed double precision,

  accuracy double precision,

  updated_at timestamptz not null default now(),

  unique(driver_id)
);

-- =========================================================
-- INDEXES
-- =========================================================

create index idx_ride_requests_passenger
on public.ride_requests(passenger_id);

create index idx_ride_requests_group
on public.ride_requests(group_id);

create index idx_ride_requests_status
on public.ride_requests(status);

create index idx_ride_groups_status
on public.ride_groups(status);

create index idx_ride_groups_driver
on public.ride_groups(driver_id);

create index idx_group_members_group
on public.ride_group_members(group_id);

create index idx_group_members_passenger
on public.ride_group_members(passenger_id);

create index idx_driver_locations_driver
on public.driver_locations(driver_id);

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================

alter table public.profiles enable row level security;

alter table public.ride_groups enable row level security;

alter table public.ride_requests enable row level security;

alter table public.ride_group_members enable row level security;

alter table public.ride_routes enable row level security;

alter table public.driver_locations enable row level security;

-- =========================================================
-- PROFILES
-- =========================================================

create policy "profiles_select_authenticated"
on public.profiles
for select
to authenticated
using (
  auth.uid() = id
);

-- =========================================================
-- RIDE GROUPS
-- =========================================================

create policy "groups_select_members_or_drivers"
on public.ride_groups
for select
to authenticated
using (
  auth.uid() = driver_id

  or status = 'sent_to_driver'

  or exists (
    select 1
    from public.ride_group_members m
    where m.group_id = id
      and m.passenger_id = auth.uid()
  )
);

-- =========================================================
-- RIDE REQUESTS
-- =========================================================

create policy "requests_select_owner_or_group_member"
on public.ride_requests
for select
to authenticated
using (
  passenger_id = auth.uid()

  or exists (
    select 1
    from public.ride_group_members m
    where m.ride_request_id = id
      and m.passenger_id = auth.uid()
  )

  or exists (
    select 1
    from public.ride_groups g
    where g.id = group_id
      and (
        g.status = 'sent_to_driver'
        or g.driver_id = auth.uid()
      )
  )
);

-- =========================================================
-- GROUP MEMBERS
-- =========================================================

create policy "members_select_group_users"
on public.ride_group_members
for select
to authenticated
using (
  passenger_id = auth.uid()

  or exists (
    select 1
    from public.ride_groups g
    where g.id = group_id
      and (
        g.status = 'sent_to_driver'
        or g.driver_id = auth.uid()
        or exists (
          select 1
          from public.ride_group_members m2
          where m2.group_id = g.id
            and m2.passenger_id = auth.uid()
        )
      )
  )
);

-- =========================================================
-- ROUTES
-- =========================================================

create policy "routes_select_group_users"
on public.ride_routes
for select
to authenticated
using (
  exists (
    select 1
    from public.ride_groups g
    where g.id = group_id
      and (
        g.status = 'sent_to_driver'
        or g.driver_id = auth.uid()
        or exists (
          select 1
          from public.ride_group_members m
          where m.group_id = g.id
            and m.passenger_id = auth.uid()
        )
      )
  )
);

-- =========================================================
-- DRIVER LOCATIONS
-- =========================================================

create policy "driver_locations_select_group_users"
on public.driver_locations
for select
to authenticated
using (
  driver_id = auth.uid()

  or exists (
    select 1
    from public.ride_groups g
    where g.driver_id = driver_locations.driver_id
      and (
        g.status = 'accepted'
        or g.status = 'completed'
      )
      and exists (
        select 1
        from public.ride_group_members m
        where m.group_id = g.id
          and m.passenger_id = auth.uid()
      )
  )
);

-- =========================================================
-- REALTIME
-- =========================================================

alter publication supabase_realtime
add table public.ride_groups;

alter publication supabase_realtime
add table public.ride_group_members;

alter publication supabase_realtime
add table public.ride_routes;

alter publication supabase_realtime
add table public.driver_locations;

-- =========================================================
-- REPLICA IDENTITY
-- =========================================================

alter table public.ride_groups replica identity full;

alter table public.ride_group_members replica identity full;

alter table public.ride_routes replica identity full;

alter table public.driver_locations replica identity full;