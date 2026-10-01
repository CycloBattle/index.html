-- =====================================================================
--  VÉLOCARDS : schéma Supabase
--  À coller en entier dans Supabase > SQL Editor > New query > Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------

create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  username          text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  coins             integer not null default 500 check (coins >= 0),
  points_total      integer not null default 0,
  is_admin          boolean not null default false,
  last_seen_messages timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- Catalogue des cartes (un coureur = une carte, avec une rareté fixe)
create table public.riders (
  id        serial primary key,
  name      text not null unique,
  country   text not null default '',            -- code pays à 2 lettres (FR, BE...)
  specialty text not null default 'complet'
            check (specialty in ('sprinteur','grimpeur','rouleur','puncheur','classiques','complet','vintage')),
  rarity    text not null
            check (rarity in ('common','rare','ultra','legendary','mythic')),
  image_url text
);

-- Exemplaires possédés par les joueurs
create table public.user_cards (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  rider_id    integer not null references public.riders(id),
  acquired_at timestamptz not null default now()
);
create index on public.user_cards(owner_id);
create index on public.user_cards(rider_id);

create table public.races (
  id       serial primary key,
  name     text not null,
  category text not null default '',
  start_at timestamptz not null,
  status   text not null default 'upcoming' check (status in ('upcoming','finished')),
  unique (name, start_at)
);

-- Classement réel saisi par l'admin (position 1 à 20)
create table public.race_results (
  race_id  integer not null references public.races(id) on delete cascade,
  pos      integer not null check (pos between 1 and 20),
  rider_id integer not null references public.riders(id),
  primary key (race_id, pos),
  unique (race_id, rider_id)
);

create table public.lineups (
  id               uuid primary key default gen_random_uuid(),
  race_id          integer not null references public.races(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  captain_rider_id integer references public.riders(id),
  points           integer not null default 0,
  coins_earned     integer not null default 0,
  updated_at       timestamptz not null default now(),
  unique (race_id, user_id)
);

create table public.lineup_cards (
  lineup_id    uuid not null references public.lineups(id) on delete cascade,
  user_card_id uuid references public.user_cards(id) on delete set null,
  rider_id     integer not null references public.riders(id),
  unique (lineup_id, rider_id)
);

create table public.listings (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid not null references public.user_cards(id) on delete cascade,
  seller_id  uuid not null references public.profiles(id) on delete cascade,
  price      integer not null check (price > 0),
  status     text not null default 'active' check (status in ('active','sold','cancelled')),
  sold_to    uuid references public.profiles(id),
  sold_price integer,
  created_at timestamptz not null default now()
);
create unique index one_active_listing_per_card on public.listings(card_id) where status = 'active';

create table public.offers (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  buyer_id   uuid not null references public.profiles(id) on delete cascade,
  amount     integer not null check (amount > 0),
  status     text not null default 'pending' check (status in ('pending','accepted','refused','cancelled')),
  created_at timestamptz not null default now()
);
create unique index one_pending_offer_per_buyer on public.offers(listing_id, buyer_id) where status = 'pending';

-- user_id NULL = annonce pour tous les joueurs
create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade,
  kind       text not null default 'news' check (kind in ('news','trade','system')),
  title      text not null,
  body       text not null default '',
  created_at timestamptz not null default now()
);
create index on public.messages(user_id, created_at desc);

-- ---------------------------------------------------------------------
-- FONCTIONS UTILITAIRES (barèmes : à ajuster pour équilibrer l'économie)
-- ---------------------------------------------------------------------

-- Valeur de base d'une carte (sert au recyclage et au prix conseillé)
create function public.rarity_value(r text) returns integer
language sql immutable as $$
  select case r when 'common' then 20 when 'rare' then 60 when 'ultra' then 200
                when 'legendary' then 600 when 'mythic' then 1500 else 0 end;
$$;

-- Multiplicateur de points selon la rareté
create function public.rarity_mult(r text) returns numeric
language sql immutable as $$
  select case r when 'common' then 1 when 'rare' then 1.25 when 'ultra' then 1.6
                when 'legendary' then 2 when 'mythic' then 2.5 else 1 end;
$$;

-- Points de base selon la place réelle (top 20)
create function public.position_points(p integer) returns integer
language sql immutable as $$
  select (array[100,80,65,55,48,42,37,33,29,26,23,20,17,14,11,9,7,5,3,2])[p];
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------
-- CRÉATION DU PROFIL À L'INSCRIPTION
-- ---------------------------------------------------------------------

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(new.raw_user_meta_data->>'username'));
  insert into public.messages (user_id, kind, title, body)
  values (new.id, 'system', 'Bienvenue sur Vélocards !',
          'Tu démarres avec 500 pièces : ouvre tes premiers boosters, puis compose ton équipe de 8 avant chaque course.');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- SÉCURITÉ (RLS) : personne ne peut écrire directement, sauf l'admin
-- sur le catalogue et les courses. Tout le reste passe par les
-- fonctions ci-dessous.
-- ---------------------------------------------------------------------

alter table public.profiles     enable row level security;
alter table public.riders       enable row level security;
alter table public.user_cards   enable row level security;
alter table public.races        enable row level security;
alter table public.race_results enable row level security;
alter table public.lineups      enable row level security;
alter table public.lineup_cards enable row level security;
alter table public.listings     enable row level security;
alter table public.offers       enable row level security;
alter table public.messages     enable row level security;

create policy "profil perso"       on public.profiles for select to authenticated using (id = auth.uid());
create policy "riders lecture"     on public.riders for select to authenticated using (true);
create policy "riders admin"       on public.riders for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "courses lecture"    on public.races for select to authenticated using (true);
create policy "courses admin"      on public.races for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "resultats lecture"  on public.race_results for select to authenticated using (true);
-- Les collections sont publiques (vitrine des profils)
create policy "cartes lecture"     on public.user_cards for select to authenticated using (true);
-- Une équipe n'est visible des autres qu'une fois la course partie
create policy "equipes lecture"    on public.lineups for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.races r where r.id = race_id and r.start_at <= now()));
create policy "equipes cartes"     on public.lineup_cards for select to authenticated
  using (exists (select 1 from public.lineups l where l.id = lineup_id));
create policy "annonces lecture"   on public.listings for select to authenticated using (true);
create policy "offres lecture"     on public.offers for select to authenticated
  using (buyer_id = auth.uid()
         or exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid()));
create policy "messages lecture"   on public.messages for select to authenticated
  using (user_id = auth.uid() or user_id is null);

-- Profils publics (sans les pièces)
create view public.public_profiles as
select p.id, p.username, p.points_total, p.created_at,
       (select count(*) from public.user_cards c where c.owner_id = p.id) as card_count
from public.profiles p;

revoke all on all tables in schema public from anon;
revoke insert, update, delete on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.riders, public.races to authenticated;

-- ---------------------------------------------------------------------
-- FONCTIONS DE JEU (exécutées côté serveur = pas de triche possible)
-- ---------------------------------------------------------------------

-- Ouverture d'un booster : paiement + tirage + ajout des cartes
create function public.open_booster(p_type text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_price integer;
  v_rar text[];
  v_w numeric[];
  v_out jsonb := '[]'::jsonb;
  v_rider public.riders;
  v_card uuid;
  v_roll numeric; v_acc numeric; v_pick text; i integer; j integer;
begin
  if v_uid is null then raise exception 'Non connecté'; end if;

  -- Probabilités en % pour chaque carte du booster (5 cartes par booster)
  case p_type
    when 'bronze' then v_price := 100; v_rar := array['common','rare'];                       v_w := array[92, 8];
    when 'silver' then v_price := 300; v_rar := array['common','rare','ultra'];               v_w := array[68, 26, 6];
    when 'gold'   then v_price := 800; v_rar := array['rare','ultra','legendary','mythic'];   v_w := array[75, 22, 2.5, 0.5];
    else raise exception 'Booster inconnu';
  end case;

  update public.profiles set coins = coins - v_price where id = v_uid and coins >= v_price;
  if not found then raise exception 'Pas assez de pièces'; end if;

  for i in 1..5 loop
    v_roll := random() * 100; v_acc := 0; v_pick := v_rar[array_length(v_rar, 1)];
    for j in 1..array_length(v_rar, 1) loop
      v_acc := v_acc + v_w[j];
      if v_roll < v_acc then v_pick := v_rar[j]; exit; end if;
    end loop;

    select * into v_rider from public.riders where rarity = v_pick order by random() limit 1;
    if not found then  -- pas encore de carte de cette rareté : on prend une autre rareté du booster
      select * into v_rider from public.riders where rarity = any (v_rar) order by random() limit 1;
    end if;
    if not found then raise exception 'Catalogue vide : ajoute des coureurs'; end if;

    insert into public.user_cards (owner_id, rider_id) values (v_uid, v_rider.id) returning id into v_card;
    v_out := v_out || jsonb_build_object(
      'card_id', v_card, 'rider_id', v_rider.id, 'name', v_rider.name,
      'country', v_rider.country, 'specialty', v_rider.specialty, 'rarity', v_rider.rarity);
  end loop;
  return v_out;
end $$;

-- Recyclage des doublons (12 % de la valeur de base, on garde toujours 1 exemplaire)
create function public.recycle_cards(p_card_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_total integer := 0;
  r record;
begin
  if v_uid is null then raise exception 'Non connecté'; end if;
  if p_card_ids is null or array_length(p_card_ids, 1) is null then raise exception 'Aucune carte choisie'; end if;

  if (select count(*) from public.user_cards where id = any (p_card_ids) and owner_id = v_uid)
       <> array_length(p_card_ids, 1) then
    raise exception 'Carte invalide';
  end if;
  if exists (select 1 from public.listings where card_id = any (p_card_ids) and status = 'active') then
    raise exception 'Une des cartes est en vente : retire l''annonce d''abord';
  end if;
  if exists (select 1 from public.lineup_cards lc
             join public.lineups l on l.id = lc.lineup_id
             join public.races ra on ra.id = l.race_id
             where lc.user_card_id = any (p_card_ids) and ra.status = 'upcoming') then
    raise exception 'Une des cartes est engagée dans une équipe';
  end if;

  for r in
    select uc.rider_id, rd.rarity, count(*) as sel,
           (select count(*) from public.user_cards x where x.owner_id = v_uid and x.rider_id = uc.rider_id) as owned
    from public.user_cards uc join public.riders rd on rd.id = uc.rider_id
    where uc.id = any (p_card_ids)
    group by uc.rider_id, rd.rarity
  loop
    if r.sel > r.owned - 1 then raise exception 'Seuls les doublons peuvent être recyclés'; end if;
    v_total := v_total + r.sel * floor(public.rarity_value(r.rarity) * 0.12)::integer;
  end loop;

  delete from public.user_cards where id = any (p_card_ids) and owner_id = v_uid;
  update public.profiles set coins = coins + v_total where id = v_uid;
  return v_total;
end $$;

-- Composition d'équipe : 8 cartes, 1 capitaine, ouverte de J-5 jusqu'au départ
create function public.save_lineup(p_race_id integer, p_card_ids uuid[], p_captain_rider integer) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_race public.races;
  v_lineup uuid;
begin
  if v_uid is null then raise exception 'Non connecté'; end if;
  select * into v_race from public.races where id = p_race_id;
  if not found then raise exception 'Course introuvable'; end if;
  if v_race.status <> 'upcoming' or now() >= v_race.start_at then raise exception 'Équipes verrouillées : la course a démarré'; end if;
  if now() < v_race.start_at - interval '5 days' then raise exception 'Les équipes ouvrent 5 jours avant la course'; end if;

  if p_card_ids is null or array_length(p_card_ids, 1) <> 8 then raise exception 'Il faut exactement 8 cartes'; end if;
  if (select count(distinct x) from unnest(p_card_ids) x) <> 8 then raise exception 'Cartes en double'; end if;
  if (select count(*) from public.user_cards where id = any (p_card_ids) and owner_id = v_uid) <> 8 then
    raise exception 'Une des cartes ne t''appartient pas';
  end if;
  if (select count(distinct rider_id) from public.user_cards where id = any (p_card_ids)) <> 8 then
    raise exception 'Un même coureur ne peut être aligné qu''une fois';
  end if;
  if exists (select 1 from public.listings where card_id = any (p_card_ids) and status = 'active') then
    raise exception 'Une des cartes est en vente';
  end if;
  if not exists (select 1 from public.user_cards where id = any (p_card_ids) and rider_id = p_captain_rider) then
    raise exception 'Le capitaine doit faire partie des 8 coureurs';
  end if;

  insert into public.lineups (race_id, user_id, captain_rider_id)
  values (p_race_id, v_uid, p_captain_rider)
  on conflict (race_id, user_id) do update set captain_rider_id = excluded.captain_rider_id, updated_at = now()
  returning id into v_lineup;

  delete from public.lineup_cards where lineup_id = v_lineup;
  insert into public.lineup_cards (lineup_id, user_card_id, rider_id)
  select v_lineup, uc.id, uc.rider_id from public.user_cards uc where uc.id = any (p_card_ids);
end $$;

-- Mise en vente
create function public.create_listing(p_card_id uuid, p_price integer) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Non connecté'; end if;
  if p_price is null or p_price < 1 or p_price > 1000000 then raise exception 'Prix invalide'; end if;
  if not exists (select 1 from public.user_cards where id = p_card_id and owner_id = v_uid) then
    raise exception 'Cette carte ne t''appartient pas';
  end if;
  if exists (select 1 from public.lineup_cards lc
             join public.lineups l on l.id = lc.lineup_id
             join public.races ra on ra.id = l.race_id
             where lc.user_card_id = p_card_id and ra.status = 'upcoming') then
    raise exception 'Carte engagée dans une équipe : retire-la de ton équipe avant de la vendre';
  end if;
  insert into public.listings (card_id, seller_id, price) values (p_card_id, v_uid, p_price);
end $$;

create function public.cancel_listing(p_listing_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  update public.listings set status = 'cancelled' where id = p_listing_id and seller_id = v_uid and status = 'active';
  if not found then raise exception 'Annonce introuvable'; end if;
  update public.offers set status = 'refused' where listing_id = p_listing_id and status = 'pending';
end $$;

-- Vente atomique (interne, non appelable depuis le navigateur)
create function public._execute_sale(p_listing uuid, p_buyer uuid, p_amount integer) returns void
language plpgsql security definer set search_path = public as $$
declare
  l public.listings;
  v_name text;
  v_buyer text;
begin
  select * into l from public.listings where id = p_listing and status = 'active' for update;
  if not found then raise exception 'Annonce indisponible'; end if;
  if l.seller_id = p_buyer then raise exception 'Tu ne peux pas acheter ta propre carte'; end if;

  update public.profiles set coins = coins - p_amount where id = p_buyer and coins >= p_amount;
  if not found then raise exception 'Solde insuffisant'; end if;
  update public.profiles set coins = coins + p_amount where id = l.seller_id;

  update public.user_cards set owner_id = p_buyer where id = l.card_id and owner_id = l.seller_id;
  if not found then raise exception 'Carte introuvable'; end if;

  update public.listings set status = 'sold', sold_to = p_buyer, sold_price = p_amount where id = p_listing;
  update public.offers set status = 'refused' where listing_id = p_listing and status = 'pending';

  select rd.name into v_name from public.user_cards uc join public.riders rd on rd.id = uc.rider_id where uc.id = l.card_id;
  select username into v_buyer from public.profiles where id = p_buyer;
  insert into public.messages (user_id, kind, title, body) values
    (l.seller_id, 'trade', 'Carte vendue', v_name || ' a été vendue à ' || v_buyer || ' pour ' || p_amount || ' pièces.'),
    (p_buyer,     'trade', 'Carte achetée', 'Tu as acheté ' || v_name || ' pour ' || p_amount || ' pièces.');
end $$;
revoke execute on function public._execute_sale(uuid, uuid, integer) from public, anon, authenticated;

create function public.buy_listing(p_listing_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_price integer;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  select price into v_price from public.listings where id = p_listing_id and status = 'active';
  if not found then raise exception 'Annonce indisponible'; end if;
  perform public._execute_sale(p_listing_id, auth.uid(), v_price);
end $$;

create function public.make_offer(p_listing_id uuid, p_amount integer) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  l public.listings;
  v_name text; v_user text;
begin
  if v_uid is null then raise exception 'Non connecté'; end if;
  select * into l from public.listings where id = p_listing_id and status = 'active';
  if not found then raise exception 'Annonce indisponible'; end if;
  if l.seller_id = v_uid then raise exception 'C''est ta propre annonce'; end if;
  if p_amount is null or p_amount < 1 then raise exception 'Montant invalide'; end if;
  if p_amount >= l.price then raise exception 'Ton offre doit être inférieure au prix : achète directement'; end if;
  if (select coins from public.profiles where id = v_uid) < p_amount then raise exception 'Solde insuffisant'; end if;

  insert into public.offers (listing_id, buyer_id, amount) values (p_listing_id, v_uid, p_amount)
  on conflict (listing_id, buyer_id) where status = 'pending' do update set amount = excluded.amount, created_at = now();

  select rd.name into v_name from public.user_cards uc join public.riders rd on rd.id = uc.rider_id where uc.id = l.card_id;
  select username into v_user from public.profiles where id = v_uid;
  insert into public.messages (user_id, kind, title, body)
  values (l.seller_id, 'trade', 'Nouvelle offre', v_user || ' propose ' || p_amount || ' pièces pour ' || v_name || ' (annoncé ' || l.price || ').');
end $$;

create function public.respond_offer(p_offer_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  o public.offers;
  l public.listings;
  v_name text;
begin
  select * into o from public.offers where id = p_offer_id and status = 'pending' for update;
  if not found then raise exception 'Offre introuvable'; end if;
  select * into l from public.listings where id = o.listing_id;
  if l.seller_id <> v_uid then raise exception 'Cette offre ne te concerne pas'; end if;
  select rd.name into v_name from public.user_cards uc join public.riders rd on rd.id = uc.rider_id where uc.id = l.card_id;

  if p_accept then
    update public.offers set status = 'accepted' where id = o.id;
    perform public._execute_sale(l.id, o.buyer_id, o.amount);
  else
    update public.offers set status = 'refused' where id = o.id;
    insert into public.messages (user_id, kind, title, body)
    values (o.buyer_id, 'trade', 'Offre refusée', 'Ton offre de ' || o.amount || ' pièces pour ' || v_name || ' a été refusée.');
  end if;
end $$;

create function public.cancel_offer(p_offer_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.offers set status = 'cancelled' where id = p_offer_id and buyer_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Offre introuvable'; end if;
end $$;

create function public.mark_messages_seen() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen_messages = now() where id = auth.uid();
$$;

-- Classement d'une course terminée
create function public.race_ranking(p_race_id integer)
returns table (username text, points integer, coins_earned integer)
language sql stable security definer set search_path = public as $$
  select p.username, l.points, l.coins_earned
  from public.lineups l
  join public.profiles p on p.id = l.user_id
  join public.races r on r.id = l.race_id
  where l.race_id = p_race_id and r.status = 'finished'
  order by l.points desc, p.username;
$$;

-- ---------------------------------------------------------------------
-- ADMIN : validation des résultats d'une course
--   p_results = [{"pos":1,"rider_id":12}, {"pos":2,"rider_id":7}, ...]
--   Points par carte = points de la place x multiplicateur de rareté
--   Capitaine x1,5. Carte mythique (coureur retraité) = bonus fixe de 30.
--   1 point = 1 pièce.
-- ---------------------------------------------------------------------
create function public.validate_race(p_race_id integer, p_results jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_name text;
  item jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé à l''admin'; end if;
  select status, name into v_status, v_name from public.races where id = p_race_id for update;
  if not found then raise exception 'Course introuvable'; end if;
  if v_status <> 'upcoming' then raise exception 'Course déjà validée'; end if;
  if jsonb_array_length(p_results) = 0 then raise exception 'Aucun résultat saisi'; end if;

  delete from public.race_results where race_id = p_race_id;
  for item in select * from jsonb_array_elements(p_results) loop
    insert into public.race_results (race_id, pos, rider_id)
    values (p_race_id, (item->>'pos')::integer, (item->>'rider_id')::integer);
  end loop;

  update public.lineups l
  set points = s.pts, coins_earned = s.pts
  from (
    select lc.lineup_id,
           coalesce(sum(floor(
             case when rd.rarity = 'mythic' then 30 else coalesce(public.position_points(rr.pos), 0) end
             * public.rarity_mult(rd.rarity)
             * case when rd.id = ln.captain_rider_id then 1.5 else 1 end
           )), 0)::integer as pts
    from public.lineup_cards lc
    join public.lineups ln on ln.id = lc.lineup_id
    join public.riders rd on rd.id = lc.rider_id
    left join public.race_results rr on rr.race_id = ln.race_id and rr.rider_id = lc.rider_id
    where ln.race_id = p_race_id
    group by lc.lineup_id
  ) s
  where l.id = s.lineup_id;

  update public.profiles p
  set coins = p.coins + l.coins_earned, points_total = p.points_total + l.points
  from public.lineups l
  where l.race_id = p_race_id and l.user_id = p.id;

  insert into public.messages (user_id, kind, title, body)
  select l.user_id, 'news', 'Résultats : ' || v_name,
         'Ton équipe a marqué ' || l.points || ' points (+' || l.coins_earned || ' pièces).'
  from public.lineups l where l.race_id = p_race_id;

  update public.races set status = 'finished' where id = p_race_id;
end $$;

create function public.post_news(p_title text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''admin'; end if;
  insert into public.messages (user_id, kind, title, body) values (null, 'news', p_title, coalesce(p_body, ''));
end $$;

-- Droits d'exécution : uniquement pour les joueurs connectés
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public._execute_sale(uuid, uuid, integer) from authenticated;
