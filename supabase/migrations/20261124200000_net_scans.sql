-- Network Scanner uploads (approved by Sonor 2026-11-24: the one exception to the scanner's local-only rule).
-- ONE master table keyed by project_id; each project sees its own history through a filtered view.
-- Scans the scanner could not match to a project (by the connected Wi-Fi SSID against Network Map's saved Wi-Fi)
-- land as 'unassigned' for the office to attach. The office reviews, applies (fills MACs / serials in Network Map)
-- and net_scan_apply() writes the revision note into Network Map's revision history (sonor_revisions, app 'network-map').
create table if not exists public.net_scans (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references public.projects(id) on delete set null,
  status        text not null default 'pending' check (status in ('unassigned', 'pending', 'applied', 'dismissed')),
  matched_by    text check (matched_by in ('ssid', 'picked', 'office')),
  ssid          text,
  scanned_by    text default public.sonor_who(),
  scanned_at    timestamptz not null default now(),
  agent         text,                 -- 'tablet' | 'pi:<hostname>' | 'laptop:<hostname>'
  app_version   text,
  subnets       text[] not null default '{}',
  device_count  int not null default 0,
  label         text,
  netinfo       jsonb,                -- network at a glance: WAN / ISP, gateway, DNS, DHCP, flags, speed
  devices       jsonb not null default '[]'::jsonb check (jsonb_typeof(devices) = 'array'),
  check_result  jsonb,                -- scanner's comparison with the plan at upload time
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  applied       jsonb,                -- what the office applied (fields filled per device)
  revision_id   uuid references public.sonor_revisions(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint net_scans_unassigned_has_no_project check (status <> 'unassigned' or project_id is null)
);
create index if not exists net_scans_project_idx on public.net_scans (project_id, scanned_at desc);
create index if not exists net_scans_status_idx on public.net_scans (status, scanned_at desc);

alter table public.net_scans enable row level security;
-- same gate as network_configs: signed-in, then the restrictive Sonor-member and demo rules
create policy net_scans_sel on public.net_scans for select to authenticated using (true);
create policy net_scans_ins on public.net_scans for insert to authenticated with check (true);
create policy net_scans_upd on public.net_scans for update to authenticated using (true) with check (true);
create policy net_scans_sonor_member on public.net_scans as restrictive for all to authenticated using ((select public.sonor_member())) with check ((select public.sonor_member()));
create policy net_scans_sonor_demo on public.net_scans as restrictive for select to authenticated using ((not (select public.sonor_is_demo())) or (project_id::text = any ((select public.sonor_demo_pids())::text[])));
create policy net_scans_sonor_demo_ins on public.net_scans as restrictive for insert to authenticated with check (not (select public.sonor_is_demo()));
create policy net_scans_sonor_demo_upd on public.net_scans as restrictive for update to authenticated using (not (select public.sonor_is_demo()));
grant select, insert, update on public.net_scans to authenticated;

-- Per-project history (newest first) with the project name, and the office's Unassigned list.
create or replace view public.v_net_scans with (security_invoker = true) as
  select s.id, s.project_id, p.ref as project_ref, p.name as project_name, s.status, s.matched_by, s.ssid, s.scanned_by, s.scanned_at,
         s.agent, s.app_version, s.subnets, s.device_count, s.label, s.reviewed_by, s.reviewed_at, s.review_note, s.revision_id,
         s.netinfo -> 'wan' ->> 'ip' as wan_ip, s.netinfo -> 'wan' ->> 'isp' as isp, jsonb_array_length(coalesce(s.netinfo -> 'flags', '[]'::jsonb)) as flag_count
  from public.net_scans s left join public.projects p on p.id = s.project_id;
grant select on public.v_net_scans to authenticated;

-- Office: attach an unassigned scan to a project.
create or replace function public.net_scan_assign(p_scan uuid, p_project uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update net_scans set project_id = p_project, status = 'pending', matched_by = 'office' where id = p_scan and status in ('unassigned', 'pending');
  if not found then raise exception 'Scan % is not waiting for a project', p_scan; end if;
end $$;

-- Office: mark a reviewed scan applied (the page has already written Network Map's config with its updated_at guard)
-- and record the revision note in Network Map's history: who scanned, who reviewed, what changed.
create or replace function public.net_scan_apply(p_scan uuid, p_applied jsonb, p_note text default null, p_app_version text default null)
returns uuid language plpgsql security invoker set search_path = public as $$
declare s net_scans; who text := coalesce(sonor_who(), 'office'); r sonor_revisions; msg text;
begin
  select * into s from net_scans where id = p_scan for update;
  if s.id is null then raise exception 'No scan %', p_scan; end if;
  if s.project_id is null then raise exception 'Attach the scan to a project first'; end if;
  if s.status = 'applied' then return s.revision_id; end if;
  msg := format('Network scan %s by %s (%s devices%s) reviewed by %s. %s',
    to_char(s.scanned_at at time zone 'Europe/London', 'DD Mon YYYY HH24:MI'), coalesce(s.scanned_by, 'unknown'), s.device_count,
    case when s.ssid is not null then ', Wi-Fi ' || s.ssid else '' end, who,
    coalesce(nullif(trim(p_note), ''), coalesce(p_applied ->> 'summary', 'No changes applied.')));
  r := sonor_issue_revision(p_project_id => s.project_id, p_app_key => 'network-map', p_doc_ref => 'network-plan', p_series => 'P',
    p_display_label => null, p_note => msg, p_sources => jsonb_build_array(jsonb_build_object('kind', 'net_scan', 'id', s.id, 'at', s.scanned_at)),
    p_app_version => p_app_version, p_issued_by => who, p_metadata => jsonb_build_object('net_scan', s.id, 'applied', p_applied));
  update net_scans set status = 'applied', reviewed_by = who, reviewed_at = now(), review_note = p_note, applied = p_applied, revision_id = r.id where id = p_scan;
  return r.id;
end $$;

create or replace function public.net_scan_dismiss(p_scan uuid, p_note text default null)
returns void language sql security invoker set search_path = public as $$
  update net_scans set status = 'dismissed', reviewed_by = coalesce(sonor_who(), 'office'), reviewed_at = now(), review_note = p_note where id = p_scan and status <> 'applied';
$$;
grant execute on function public.net_scan_assign(uuid, uuid), public.net_scan_apply(uuid, jsonb, text, text), public.net_scan_dismiss(uuid, text) to authenticated;
