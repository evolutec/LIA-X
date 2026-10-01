--
-- PostgreSQL database dump
--

\restrict 6UiAxLQ3V8PR1Ky4hNax9iO6EaLcG5XmOFOrtJVGgs6o51mvbZk1FcoNkNHwE7t

-- Dumped from database version 16.15 (Debian 16.15-1.pgdg12+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: chunks; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    ordinal integer NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    embedding public.vector(768),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.chunks OWNER TO lia;

--
-- Name: collections_backup_005; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.collections_backup_005 (
    id uuid,
    name text,
    description text,
    created_at timestamp with time zone
);


ALTER TABLE public.collections_backup_005 OWNER TO lia;

--
-- Name: conversation_folders; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.conversation_folders (
    conversation_id uuid NOT NULL,
    folder_id uuid NOT NULL
);


ALTER TABLE public.conversation_folders OWNER TO lia;

--
-- Name: conversations; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text DEFAULT 'Nouvelle conversation'::text NOT NULL,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    workspace_id uuid
);


ALTER TABLE public.conversations OWNER TO lia;

--
-- Name: documents_backup_005; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.documents_backup_005 (
    id uuid,
    collection_id uuid,
    source_path text,
    title text,
    content_hash text,
    created_at timestamp with time zone,
    ingest_status text,
    total_chunks integer,
    done_chunks integer,
    error_detail text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);


ALTER TABLE public.documents_backup_005 OWNER TO lia;

--
-- Name: files; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folder_id uuid NOT NULL,
    source_path text,
    title text,
    content_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ingest_status text DEFAULT 'ready'::text NOT NULL,
    total_chunks integer DEFAULT 0 NOT NULL,
    done_chunks integer DEFAULT 0 NOT NULL,
    error_detail text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);


ALTER TABLE public.files OWNER TO lia;

--
-- Name: folders; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.folders OWNER TO lia;

--
-- Name: messages; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    reasoning text,
    model text,
    error text,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


ALTER TABLE public.messages OWNER TO lia;

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.schema_migrations OWNER TO lia;

--
-- Name: workspace_folders; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.workspace_folders (
    workspace_id uuid NOT NULL,
    folder_id uuid NOT NULL
);


ALTER TABLE public.workspace_folders OWNER TO lia;

--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: lia
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.workspaces OWNER TO lia;

--
-- Data for Name: chunks; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.chunks (id, file_id, ordinal, content, metadata, embedding, created_at) FROM stdin;
b7de942f-6e07-470a-9373-0565fa31defc	eedd30b7-24e3-4a3e-a8b9-3f6bc6b610dd	0	2ima0S Installer	{"chars": 16, "ordinal": 0}	[0.0282697,-0.02036683,0.02701014,-0.0555809,-0.01104864,0.02008689,-0.01825177,0.00253117,-0.01112219,-0.06418397,0.01023751,0.11260623,-0.10034071,0.04487639,-0.01621075,-0.04165921,-0.02789277,0.03237461,0.02434286,0.04448251,0.01859602,-0.00233446,-0.04919278,-0.02755871,0.01253263,-0.04625814,0.00163015,0.01515801,0.0627142,-0.00482041,-0.03671799,-0.00730642,0.01877845,0.06983164,-0.04549423,0.01964555,-0.03078923,-0.09211029,-0.02004621,-0.05443199,0.06440614,-0.00172741,0.02090626,0.06161798,-0.00718878,0.03286221,-0.00527337,0.03175203,-0.04948765,0.04428285,-0.02663467,0.02390187,-0.00222735,0.02316852,0.00218362,-0.01912495,-0.02621119,-0.07819206,0.0533907,-0.02011842,-0.02671835,-0.00930225,-0.00557605,0.00218529,0.01917242,-0.01512869,-0.02662529,-0.0033482,0.03116126,0.03340758,-0.04055593,0.00372132,-0.01321457,0.00044681,-0.00678616,-0.01012529,0.00659344,0.01120354,-0.04114896,-0.00457389,0.00506547,0.01748113,-0.02351254,0.00226284,-0.03063598,-0.00803041,0.00229859,0.05340162,-0.05582563,0.03429377,-0.0148555,-0.00568832,-0.04397569,0.0016749,0.0180705,0.03390846,0.0399479,0.06565595,-0.06206908,0.01376768,-0.01965401,0.05000823,-0.01604108,-0.08236451,0.00499367,0.02423556,0.03055598,-0.02579978,0.02855645,0.02964107,-0.08004202,-0.01687506,-0.02683625,-0.01809914,-0.02892848,0.02704665,0.01703384,-0.04172508,-0.00952055,0.01011651,0.00072308,-0.02784831,-0.00707476,0.0018291,0.0320383,0.01358151,-0.00554293,-0.01616967,-0.02551863,0.00620592,-0.03325963,-0.02025299,-0.00949632,-0.01668065,0.00205994,0.03351871,0.04395131,-0.03935101,0.00035194,-0.1068859,0.09278521,0.05829473,0.02351508,0.01012275,-0.03745461,0.05640647,0.0083804,0.09024223,-0.0592212,0.02140808,-0.02989027,-0.00646361,-0.06659792,0.07790794,-0.02317966,-0.02223222,-0.08431186,-0.03589132,0.06782991,0.01777603,0.0727414,0.05284221,-0.02942828,-0.00320798,-0.02114679,0.03391131,0.04988565,0.01298591,-0.06411153,-0.00693303,0.00142654,-0.04306155,-0.04561127,-0.04219638,0.02353241,-0.01923685,-0.01220716,0.10264502,-0.02962891,0.01184519,0.0022916,0.02613214,0.01443368,0.01932905,-0.01119709,-0.041292,0.06620905,0.06939705,-0.04733467,-0.03139041,0.01035793,0.0058797,0.09604461,0.04695177,-0.03058503,-0.04357815,-0.02643639,-0.00149482,0.09127352,-0.06130487,0.00160792,-0.04861631,0.01781849,0.04087799,0.01352686,0.01219599,-0.05778984,0.03015058,-0.02818465,0.00821862,-0.01633762,-0.01809523,0.01771367,0.01004166,0.0666195,-0.06679145,0.0024466,0.0025987,0.04684664,0.04592117,0.0515127,0.0232487,-0.00934514,-0.04584102,0.0250951,-0.00030707,-0.03162441,0.0623678,-0.01806015,0.12713274,-0.00302015,-0.0366771,0.00848323,-0.01298806,0.02306487,-0.0033425,-0.05362668,-0.01354489,-0.03455378,0.00438875,-0.00933983,-0.02571307,0.03989674,0.03295783,0.00082151,0.08182885,0.03718927,-0.03562743,-0.0797637,0.00014656,0.0065463,-0.00704424,-0.00205862,0.04749906,0.05030326,0.02419883,0.00600296,0.00107986,0.0289914,0.02228056,-0.0292507,0.06513053,0.03279851,-0.00958139,0.00211201,-0.01573016,0.01153095,0.03594848,0.01564476,-0.0287615,0.02737193,-0.00014799,-0.01276128,0.03238271,0.08103432,0.05387844,-0.04925298,0.06459788,-0.06367012,-0.03734149,-0.05086615,-0.01889684,-0.00869859,0.02050024,0.00811207,0.01909134,0.00370974,-0.05547465,-0.02068003,0.003569,0.03178958,0.00403173,-0.02306785,-0.12209108,-0.06298879,-0.01449569,0.02621849,-0.01378991,-0.01132846,0.00588381,-0.00490027,-0.0516391,-0.06529849,0.04691132,0.03695177,0.00987987,0.01152617,-0.02101955,0.01598837,-0.01266412,0.00852896,0.01653178,-0.00805438,-0.06527239,-0.03233284,-0.01490461,0.00946623,0.04316499,0.03892951,0.02010676,-0.04126336,0.00339665,-0.04272227,-0.05471643,-0.05553536,-0.05943665,0.00848857,-0.00459841,-0.00014099,-0.03479345,-0.00506501,-0.00863463,0.07347322,-0.04858477,-0.0163641,0.01064887,-0.0260896,0.01005907,-0.02510331,0.04449179,0.05120698,0.03506158,-0.0034251,-0.04472315,-0.07976367,-0.03143718,0.02732846,0.03723364,0.02132835,0.04828847,0.04405556,-0.02237619,0.02789389,0.04157311,-0.02627705,0.02116196,0.04541988,-0.03362825,-0.05303606,0.0378615,-0.03333841,0.02608838,-0.06236506,-0.03421792,-0.05463131,-0.0263058,-0.02137785,-0.03555482,-0.02473269,0.02178371,-0.00236755,0.07377913,-0.05760975,-0.02384546,-0.03126487,-0.02314046,-0.03868421,-0.04054763,-0.00619671,-0.01432861,-0.01294766,0.02576739,0.04325406,0.02847777,0.02572818,-0.01581396,-0.00345542,-0.04479241,-0.02341042,-0.03207018,0.02748581,-0.02628593,0.00376363,-0.00926915,0.06517775,0.03274381,0.02062324,0.03535681,-0.04064136,0.00299424,-0.03539303,-0.01236158,-0.00462198,0.0399021,-0.00332861,-0.00874273,-0.05836798,-0.01947495,0.00773878,0.0884142,-0.00359018,-0.00145914,0.02344928,0.00536309,-0.02648751,0.01735061,-0.07947508,-0.00879919,-0.00387519,-0.02587697,0.00729114,0.01380255,-0.05442803,-0.07169151,0.09674326,-0.01441105,0.04099796,-0.00314527,0.01525757,0.04027047,0.00238583,0.04029151,-0.01907082,0.02999861,0.10129054,-0.01242249,-0.00597659,-0.01487712,0.02869365,0.00724862,0.06901982,0.01391627,-0.02117425,-0.02040035,-0.07288646,-0.01933039,0.05872513,0.00413457,-0.01193473,0.00755007,-0.00716734,-0.04119125,0.00336963,-0.02447688,-0.04403586,0.01749035,0.00631792,-0.00318149,0.00521986,0.05317865,0.03982873,-0.04168452,0.02906666,0.03877192,-0.01222378,-0.04028163,0.02815687,0.03522066,0.01851369,-0.04018337,0.03088201,0.06117275,0.02337548,0.01587608,-0.02118297,-0.0195234,0.03874948,0.04556942,-0.00317366,0.02524747,0.01755663,0.01453636,0.02784673,0.00643586,-0.00958679,0.07710464,-0.00129912,0.00527602,-0.02825618,-0.0458345,-0.0216359,-0.01928619,-0.00301999,0.05172624,-0.0470974,0.01167386,0.02077171,-0.00864484,0.03152694,-0.03228,-0.005664,-0.03441694,-0.00076952,-0.02938265,-0.02729722,-0.00821787,0.04987997,-0.07058933,-0.0035272,-0.01296824,-0.00395042,-0.00462223,-0.04734014,0.02401495,-0.02742449,0.07508092,0.06213341,-0.00136613,-0.01235682,-0.06991901,0.0185707,0.04965501,-0.01685079,0.02916342,0.00057563,0.04983938,-0.05758042,0.00765322,0.01493086,0.01626511,0.03042463,0.01016071,0.03549843,-0.02585608,0.01102282,0.00278774,0.04470387,-0.05561711,-0.00880523,-0.02853638,0.0559503,-0.03401044,0.00762566,0.01543519,0.04158486,0.00506141,0.08195404,0.01521879,-0.02731214,-0.00834023,-0.03601758,0.01050828,0.02075415,-0.05961443,-0.00310648,-0.01293885,-0.0126636,0.03472446,-0.00280983,-0.05359953,0.01439993,-0.0133735,-0.00513755,-0.04353306,-0.05233452,-0.00647144,-0.00202154,0.04190472,0.04425826,-0.03222914,0.00837219,0.05164898,-0.01649812,0.01709162,-0.04380293,-0.04288963,-0.00062332,0.03173341,-0.00673446,-0.05338191,-0.05094826,0.0221232,0.02301405,0.00031574,0.00435664,-0.05628089,-0.04398343,0.04327066,0.08879388,-0.00997829,0.03135528,-0.05828619,0.02932852,0.0326692,0.05783598,0.02640295,-0.00307893,0.01909999,-0.00544038,-0.01819567,0.04418654,0.01996999,-0.0088954,-0.02396516,0.00105488,0.00531719,-0.02938818,0.01108375,0.03708228,0.01130781,-0.02792043,-0.0174029,-0.00910341,0.02246487,-0.01549061,0.01766031,-0.05089112,-0.00927941,0.0452576,0.03343859,-0.00347739,-0.02636639,-0.00852366,-0.02505602,-0.03133301,-0.06260521,-0.02368193,-0.03359759,-0.00312541,-0.02173642,-0.00924499,0.00084056,-0.02875961,-0.02553616,0.02439113,-0.02321529,-0.00512394,-0.01626134,0.05502293,0.00932058,-0.01828808,-0.02228309,0.06349134,-0.03447824,0.05041128,-0.01407843,0.01154808,-0.0035798,0.01843169,0.06734016,-0.00993653,-0.00280855,-0.02140244,-0.0362891,0.01018152,0.0346904,0.01169663,-0.01222738,-0.00262516,0.00538203,0.01900369,-0.06772707,0.0028726,0.00910004,-0.08495568,0.03847924,-0.03363869,0.08096129,-0.00226794,-0.02118551,-0.00464946,0.05939161,-0.00675547,0.02677298,0.011029,-0.01962266,0.03862945,0.02578981,0.02074246,0.04614237,0.00894384,-0.03914405,0.00269324,0.00410902,-0.03321234,-0.04458804,-0.03931148,0.0048797,-0.05967025,0.00031143,-0.01725723,-0.00946359,-0.00611538,0.02936083,-0.00610131,-0.02181417,-0.01860678,-0.00099973,0.03797363,0.00958814,-0.01947461,0.00855873,-0.04611158,-0.02613284,0.00804313,-0.01781305,-0.02580805,0.00022463,0.00483889,-0.00304538,-0.05211679,-0.05086328,-0.05501338,-0.00608809,-0.04920072,0.00531377,0.00543918,0.01362765,0.01180865,0.1216477,0.04198814,0.02645801,0.01394187,-0.01552949,-0.00093316,0.02919357,0.00830038,-0.03817223,-0.04739475,-0.09168524,0.02394759,-0.00880462,-0.05811211,0.04270572,-0.00206163,-0.01968716,0.00728902,-0.03838651,-0.01703117,0.03991792,-0.01412472,0.07990624,-0.00173647,-0.04106633,0.0219006,0.01972804,0.00250049,-0.01561825,0.01064794,-0.00296501,-0.02442821,0.01551098,0.02296596,-0.03583154,0.01499517,0.04263932,0.06609579,0.00361521,0.0006137,0.01059262,0.01217629,-0.05574819,0.01101026,0.00968326,0.01389851,-0.05677546,-0.03552354,-0.00667968]	2026-09-30 04:18:28.401661+00
\.


--
-- Data for Name: collections_backup_005; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.collections_backup_005 (id, name, description, created_at) FROM stdin;
36523c6d-60f8-4917-8869-5a4f638ac25e	1	\N	2026-09-30 04:17:48.735119+00
\.


--
-- Data for Name: conversation_folders; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.conversation_folders (conversation_id, folder_id) FROM stdin;
\.


--
-- Data for Name: conversations; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.conversations (id, title, model, created_at, updated_at, archived, workspace_id) FROM stdin;
b207eeb1-ed13-48aa-a790-d36ec68da322	Nouvelle conversation	\N	2026-09-30 04:17:15.025003+00	2026-09-30 04:17:15.025003+00	f	4e495927-3ec5-446c-8d7e-d459fad027eb
84f99d16-e096-4b02-a061-e13cd4f97058	Nouvelle conversation	\N	2026-09-30 04:17:19.660501+00	2026-09-30 04:17:19.660501+00	f	4e495927-3ec5-446c-8d7e-d459fad027eb
\.


--
-- Data for Name: documents_backup_005; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.documents_backup_005 (id, collection_id, source_path, title, content_hash, created_at, ingest_status, total_chunks, done_chunks, error_detail, started_at, finished_at) FROM stdin;
eedd30b7-24e3-4a3e-a8b9-3f6bc6b610dd	36523c6d-60f8-4917-8869-5a4f638ac25e	Capture d'├®cran 2026-01-07 115021.png	Capture d'├®cran 2026-01-07 115021	801274d1189c8cc8eeac4a0ab4334bd86da4eee9db30d2f0a28703524f516a40	2026-09-30 04:18:07.981309+00	ready	1	1	\N	2026-09-30 04:18:07.985+00	2026-09-30 04:18:28.421467+00
\.


--
-- Data for Name: files; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.files (id, folder_id, source_path, title, content_hash, created_at, ingest_status, total_chunks, done_chunks, error_detail, started_at, finished_at) FROM stdin;
eedd30b7-24e3-4a3e-a8b9-3f6bc6b610dd	36523c6d-60f8-4917-8869-5a4f638ac25e	Capture d'├®cran 2026-01-07 115021.png	Capture d'├®cran 2026-01-07 115021	801274d1189c8cc8eeac4a0ab4334bd86da4eee9db30d2f0a28703524f516a40	2026-09-30 04:18:07.981309+00	ready	1	1	\N	2026-09-30 04:18:07.985+00	2026-09-30 04:18:28.421467+00
\.


--
-- Data for Name: folders; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.folders (id, name, description, created_at) FROM stdin;
36523c6d-60f8-4917-8869-5a4f638ac25e	1	\N	2026-09-30 04:17:48.735119+00
817105a5-b74d-4dfe-bfc1-4fee973a85b4	2	\N	2026-09-30 06:28:40.226568+00
\.


--
-- Data for Name: messages; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.messages (id, conversation_id, role, content, reasoning, model, error, "position", created_at) FROM stdin;
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.schema_migrations (version, applied_at) FROM stdin;
001_initial	2026-09-29 09:27:09.813062+00
002_async_ingest	2026-09-29 12:37:44.420745+00
003_conversation_collections	2026-09-29 14:15:21.986562+00
004_workspaces	2026-09-29 15:03:43.005034+00
005_folders	2026-09-30 06:09:09.807347+00
\.


--
-- Data for Name: workspace_folders; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.workspace_folders (workspace_id, folder_id) FROM stdin;
\.


--
-- Data for Name: workspaces; Type: TABLE DATA; Schema: public; Owner: lia
--

COPY public.workspaces (id, name, description, created_at) FROM stdin;
4e495927-3ec5-446c-8d7e-d459fad027eb	1	\N	2026-09-30 04:17:14.979847+00
\.


--
-- Name: chunks chunks_document_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_document_id_ordinal_key UNIQUE (file_id, ordinal);


--
-- Name: chunks chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_pkey PRIMARY KEY (id);


--
-- Name: folders collections_name_key; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT collections_name_key UNIQUE (name);


--
-- Name: folders collections_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);


--
-- Name: conversation_folders conversation_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.conversation_folders
    ADD CONSTRAINT conversation_folders_pkey PRIMARY KEY (conversation_id, folder_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: files documents_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: workspace_folders workspace_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.workspace_folders
    ADD CONSTRAINT workspace_folders_pkey PRIMARY KEY (workspace_id, folder_id);


--
-- Name: workspaces workspaces_name_key; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_name_key UNIQUE (name);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: chunks_document_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX chunks_document_idx ON public.chunks USING btree (file_id);


--
-- Name: chunks_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX chunks_embedding_hnsw_idx ON public.chunks USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: chunks_file_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX chunks_file_idx ON public.chunks USING btree (file_id);


--
-- Name: conversation_folders_folder_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX conversation_folders_folder_idx ON public.conversation_folders USING btree (folder_id);


--
-- Name: conversations_updated_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX conversations_updated_idx ON public.conversations USING btree (updated_at DESC);


--
-- Name: conversations_workspace_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX conversations_workspace_idx ON public.conversations USING btree (workspace_id);


--
-- Name: files_folder_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX files_folder_idx ON public.files USING btree (folder_id);


--
-- Name: files_ingest_pending_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX files_ingest_pending_idx ON public.files USING btree (started_at) WHERE (ingest_status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: messages_conversation_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX messages_conversation_idx ON public.messages USING btree (conversation_id, created_at);


--
-- Name: messages_position_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE UNIQUE INDEX messages_position_idx ON public.messages USING btree (conversation_id, "position");


--
-- Name: workspace_folders_folder_idx; Type: INDEX; Schema: public; Owner: lia
--

CREATE INDEX workspace_folders_folder_idx ON public.workspace_folders USING btree (folder_id);


--
-- Name: chunks chunks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_document_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: conversation_folders conversation_collections_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.conversation_folders
    ADD CONSTRAINT conversation_collections_collection_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;


--
-- Name: conversation_folders conversation_collections_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.conversation_folders
    ADD CONSTRAINT conversation_collections_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: files documents_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT documents_collection_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: workspace_folders workspace_collections_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.workspace_folders
    ADD CONSTRAINT workspace_collections_collection_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;


--
-- Name: workspace_folders workspace_collections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: lia
--

ALTER TABLE ONLY public.workspace_folders
    ADD CONSTRAINT workspace_collections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 6UiAxLQ3V8PR1Ky4hNax9iO6EaLcG5XmOFOrtJVGgs6o51mvbZk1FcoNkNHwE7t

