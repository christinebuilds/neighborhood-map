-- A neighbor may say that water they report looks or smells like sewage. Unverified; null when not said.
alter table public.reports add column if not exists sewage boolean;
comment on column public.reports.sewage is 'A neighbor said the water looks or smells like sewage. Unverified. Null when not said.';
grant insert (sewage) on public.reports to anon, authenticated;
create or replace view public.reports_public with (security_invoker = false) as
 SELECT id,
    created_at,
    kind,
    drain_id,
    lat,
    lon,
        CASE
            WHEN moderation = 'approved'::text THEN note
            ELSE NULL::text
        END AS note,
        CASE
            WHEN moderation = 'approved'::text THEN photo_path
            ELSE NULL::text
        END AS photo_path,
    sewage
   FROM reports
  WHERE hidden = false AND created_at > (now() - '120 days'::interval);
