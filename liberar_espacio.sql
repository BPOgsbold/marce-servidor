-- LIBERAR ESPACIO EN SUPABASE (embudo OCM)
-- Conserva completos ESTE MES y el MES ANTERIOR. Los días más viejos quedan solo con sus valores
-- (resumen: embudo, horas, tipificaciones, asesores, interesados/ventas en Marce). Se borra la lista de celulares.
-- Correr en Supabase > SQL Editor, UN PASO A LA VEZ.

-- PASO 1 · Ver cuánto pesa cada tabla (antes)
select relname as tabla, pg_size_pretty(pg_total_relation_size(relid)) as tamano
from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 10;

-- PASO 2 · Revisar qué días se van a compactar y cuáles aún NO tienen resumen
-- (los que salen "sin_resumen" no se tocan: abre el Embudo en "Todo" para que se calculen y repite)
select count(*) filter (where resumen is not null) as con_resumen,
       count(*) filter (where resumen is null)     as sin_resumen
from marce_ocm_dia
where dia < (date_trunc('month', now() at time zone 'America/Bogota') - interval '1 month')::date;

-- PASO 3 · Compactar (solo días con resumen, de antes del mes anterior)
update marce_ocm_dia
set filas = '[]'::jsonb,
    marcados = null,
    cubo = case when resumen ? 'tips' then '[]'::jsonb else cubo end,
    resumen = resumen || '{"compacto": true}'::jsonb
where dia < (date_trunc('month', now() at time zone 'America/Bogota') - interval '1 month')::date
  and resumen is not null
  and coalesce((resumen->>'compacto')::boolean, false) = false;

-- PASO 4 · Devolver el espacio al disco (córrelo SOLO, sin nada más en el editor).
-- Bloquea la tabla unos segundos/minutos: hazlo cuando no estén cargando OCM.
vacuum full marce_ocm_dia;

-- PASO 5 · Volver a correr el PASO 1 para ver el tamaño después.
