-- Asesores de Marce: cada asesor entra con su cédula.
-- Corre esto UNA vez en Supabase → SQL Editor → New query → Run.

create table if not exists asesores (
  cedula text primary key,
  nombre text not null,
  campana text,
  activo boolean not null default true,
  creado timestamptz default now(),
  actualizado timestamptz default now()
);
alter table asesores enable row level security;

-- Lista inicial (empleados.xlsx). Si una cédula ya existe, actualiza nombre y campaña.
insert into asesores (cedula, nombre, campana) values
  ('39004221', 'Maira Alexandra Gamarra Polo', 'Recuperaciones Hogar'),
  ('1017173567', 'Jennifer Ballesteros Gonzalez', 'Recuperaciones Hogar'),
  ('1025668001', 'Jhon Lenier Aluma Mosquera', 'Claro Masivo Personas'),
  ('1070808600', 'Carlos Daniel Pestana', 'Recuperaciones Hogar'),
  ('1090523238', 'Slendy Juliana Ramírez Delgado', 'Claro Masivo Personas'),
  ('1020461743', 'Andres Santiago Soto Mejia', 'Recuperaciones Hogar'),
  ('43365487', 'Lina Margod Betancur Restrepo', 'Recuperaciones Hogar'),
  ('1000539785', 'Cristian Camilo Arias Ramirez', 'Claro Masivo Personas'),
  ('1033747292', 'Gina Zulley Manjarres Espinel', 'Claro Masivo Personas'),
  ('1052069720', 'Esther Marina Gonzalez Osuna', 'Claro Masivo Personas'),
  ('1152188924', 'July Marcela Mosquera Moreno', 'Claro Hogar'),
  ('1040872331', 'Brian Salomón Aristizabal Gonzalez', 'Recuperaciones Hogar'),
  ('1017246367', 'Julian Sebastian Salazar Marin', 'Claro Hogar'),
  ('1017226355', 'Karen Johana Cordoba Valoyes', 'Claro Hogar'),
  ('1000763336', 'Michel Molina Giraldo', 'Claro Hogar'),
  ('1001227044', 'Daniel Castaño Merida', 'Claro Hogar'),
  ('1042421260', 'Daniela Carolina Gomez Siza', 'Claro Hogar'),
  ('1018457613', 'Julian David Gutierrez Garcia', 'Claro Hogar'),
  ('43635396', 'Leonor Eliana Jaramillo Henao', 'Claro Hogar'),
  ('1037625169', 'Luisa Fernanda Jaramillo Tamayo', 'Claro Hogar'),
  ('1007443224', 'Gian Marco Miranda Perez', 'Claro Hogar'),
  ('1026158054', 'Katherine Peña Bustamante', 'Claro Hogar'),
  ('1214729564', 'Julieth Eliana Vargas Tuberquia', 'Claro Hogar'),
  ('1041610696', 'Elkin Mauricio Londoño Granada', 'Claro Masivo Personas'),
  ('1000190047', 'Carlos Andrés Siza Noreña', 'Claro Masivo Personas'),
  ('1017267503', 'Juan José Correa López', 'Claro Masivo Personas'),
  ('1193234093', 'Juan Pablo Vinasco García', 'Claro Masivo Personas'),
  ('1152450026', 'Alejandro Ossa Rodriguez', 'Claro Masivo Personas'),
  ('1037617646', 'Quelly Tatiana Guevara Zapata', 'Claro Masivo Personas'),
  ('1214736433', 'Valentina Mesa Gonzalez', 'Claro Masivo Personas'),
  ('1040757853', 'Valentina Lopez Quinchia', 'Claro Masivo Personas'),
  ('1006238856', 'Cristian Ferney Baquero Garcia', 'Claro Masivo Personas'),
  ('1152472956', 'Cristian Alejandro Donoso Fonseca', 'Claro Hogar'),
  ('1002619153', 'Daniel Mateo Giraldo Salazar', 'Claro Hogar'),
  ('1013341760', 'Miguel Angel Quintero Zapata', 'Claro Hogar'),
  ('1026160862', 'Maicol Esteban Tovar Diaz', 'Claro Hogar'),
  ('1110599313', 'Heidy Dahiana Cortes Patiño', 'Claro Hogar'),
  ('44006082', 'Viviana Alejandra Salazar Restrepo', 'Claro Hogar'),
  ('1077225789', 'Hellen Faryna Ospina Farfan', 'Claro Hogar'),
  ('1020109110', 'Maria Alejandra Fernandez Tejada', 'Claro Hogar'),
  ('1028018185', 'Deiby Yesith Barrera Ortega', 'Claro Hogar'),
  ('1017232893', 'Lina Marcela Lopera Monsalve', 'Claro Hogar')
on conflict (cedula) do update set nombre = excluded.nombre, campana = excluded.campana, actualizado = now();
