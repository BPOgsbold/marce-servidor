-- Campaña de un asesor solo por un día (cuando se mueve de campaña ese día). Se corre UNA sola vez.
create table if not exists marce_campana_dia (
  fecha date not null,
  asesor text not null,
  campana text not null,
  por text,
  actualizado timestamptz default now(),
  primary key (fecha, asesor)
);
alter table marce_campana_dia enable row level security;
