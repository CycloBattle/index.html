-- =====================================================================
--  VÉLOCARDS : catalogue de départ (à lancer APRÈS schema.sql)
--  Liste indicative : vérifie et complète-la (panneau Admin ou Table Editor).
--  Rareté : common, rare, ultra, legendary, mythic
--  Règle utilisée : legendary = superstars actuelles
--                   mythic    = légendes retraitées (cartes vintage de collection)
-- =====================================================================

insert into public.riders (name, country, specialty, rarity) values
-- Légendaires (superstars en activité)
('Tadej Pogačar',        'SI', 'complet',    'legendary'),
('Jonas Vingegaard',     'DK', 'grimpeur',   'legendary'),
('Remco Evenepoel',      'BE', 'rouleur',    'legendary'),
('Mathieu van der Poel', 'NL', 'classiques', 'legendary'),
('Wout van Aert',        'BE', 'classiques', 'legendary'),

-- Ultra rares
('Primož Roglič',        'SI', 'complet',    'ultra'),
('Mads Pedersen',        'DK', 'classiques', 'ultra'),
('Jasper Philipsen',     'BE', 'sprinteur',  'ultra'),
('Tom Pidcock',          'GB', 'complet',    'ultra'),
('Julian Alaphilippe',   'FR', 'puncheur',   'ultra'),
('Biniam Girmay',        'ER', 'sprinteur',  'ultra'),
('Isaac del Toro',       'MX', 'grimpeur',   'ultra'),
('Juan Ayuso',           'ES', 'complet',    'ultra'),
('João Almeida',         'PT', 'grimpeur',   'ultra'),
('Filippo Ganna',        'IT', 'rouleur',    'ultra'),
('Jonathan Milan',       'IT', 'sprinteur',  'ultra'),
('Arnaud De Lie',        'BE', 'sprinteur',  'ultra'),
('Richard Carapaz',      'EC', 'grimpeur',   'ultra'),
('Mikel Landa',          'ES', 'grimpeur',   'ultra'),

-- Rares
('Christophe Laporte',   'FR', 'classiques', 'rare'),
('Kévin Vauquelin',      'FR', 'puncheur',   'rare'),
('Valentin Madouas',     'FR', 'puncheur',   'rare'),
('Lenny Martinez',       'FR', 'grimpeur',   'rare'),
('Romain Grégoire',      'FR', 'puncheur',   'rare'),
('Matteo Jorgenson',     'US', 'complet',    'rare'),
('Tim Wellens',          'BE', 'puncheur',   'rare'),
('Jhonatan Narváez',     'EC', 'puncheur',   'rare'),
('Carlos Rodríguez',     'ES', 'grimpeur',   'rare'),
('Adam Yates',           'GB', 'grimpeur',   'rare'),
('Simon Yates',          'GB', 'grimpeur',   'rare'),
('Enric Mas',            'ES', 'grimpeur',   'rare'),
('Santiago Buitrago',    'CO', 'grimpeur',   'rare'),
('Michael Matthews',     'AU', 'puncheur',   'rare'),
('Dylan Groenewegen',    'NL', 'sprinteur',  'rare'),
('Jasper Stuyven',       'BE', 'classiques', 'rare'),
('Neilson Powless',      'US', 'puncheur',   'rare'),
('Tim Merlier',          'BE', 'sprinteur',  'rare'),
('Olav Kooij',           'NL', 'sprinteur',  'rare'),
('Stefan Küng',          'CH', 'rouleur',    'rare'),

-- Communes
('Anthony Turgis',       'FR', 'classiques', 'common'),
('Bryan Coquard',        'FR', 'sprinteur',  'common'),
('Benoît Cosnefroy',     'FR', 'puncheur',   'common'),
('Warren Barguil',       'FR', 'grimpeur',   'common'),
('Pierre Latour',        'FR', 'rouleur',    'common'),
('Alexis Vuillermoz',    'FR', 'grimpeur',   'common'),
('Arnaud Démare',        'FR', 'sprinteur',  'common'),
('Clément Champoussin',  'FR', 'grimpeur',   'common'),
('Alexandre Delettre',   'FR', 'puncheur',   'common'),
('Axel Zingle',          'FR', 'classiques', 'common'),
('Dorian Godon',         'FR', 'puncheur',   'common'),
('Guillaume Martin',     'FR', 'grimpeur',   'common'),
('Marc Soler',           'ES', 'grimpeur',   'common'),
('Alberto Bettiol',      'IT', 'classiques', 'common'),
('Toms Skujiņš',         'LV', 'classiques', 'common'),
('Fabio Jakobsen',       'NL', 'sprinteur',  'common'),
('Phil Bauhaus',         'DE', 'sprinteur',  'common'),
('Wout Poels',           'NL', 'grimpeur',   'common'),
('Pascal Ackermann',     'DE', 'sprinteur',  'common'),
('Mike Teunissen',       'NL', 'classiques', 'common'),
('Sam Bennett',          'IE', 'sprinteur',  'common'),

-- Mythiques vintage (retraités : bonus fixe de points à chaque course)
('Eddy Merckx',          'BE', 'vintage',    'mythic'),
('Bernard Hinault',      'FR', 'vintage',    'mythic'),
('Fausto Coppi',         'IT', 'vintage',    'mythic'),
('Miguel Indurain',      'ES', 'vintage',    'mythic'),
('Marco Pantani',        'IT', 'vintage',    'mythic'),
('Jacques Anquetil',     'FR', 'vintage',    'mythic'),
('Raymond Poulidor',     'FR', 'vintage',    'mythic'),
('Laurent Fignon',       'FR', 'vintage',    'mythic'),
('Greg LeMond',          'US', 'vintage',    'mythic'),
('Sean Kelly',           'IE', 'vintage',    'mythic')
on conflict (name) do nothing;
