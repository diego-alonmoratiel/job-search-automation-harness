# Job-search automation harness

Capa de orquestacion que envuelve al repo `ai-job-search` y lo hace correr
desatendido en la Raspberry Pi, con el usuario aprobando por Telegram.

El repo `ai-job-search` es la metodologia (prompts + CLIs de portales). Este
harness es la fontaneria: ejecuta, enruta modelos, guarda estado, avisa y
sobrevive reinicios. Todo en Python 3 estandar, sin dependencias.

## Arquitectura

```
Telegram <-> tg-bridge <-> jobctl <-> opencode run --command <cmd> --agent harness
                                 \-> state.json   (ofertas, candidaturas, offset)
                                 \-> routes.conf  (tarea -> modelo)
```

- `bin/jobctl`     CLI principal: `daily`, `apply`, `score`, `fill`, `submit`, `verify`,
  `retarget`, `say`, `status`, ...
- `bin/tg-bridge`  long polling de Telegram; solo acepta al id del propietario.
  Enruta: comandos, URLs (retarget/apply) y lenguaje natural (say).
- `lib/harness.py` config, estado con lock, API de Telegram, runner de opencode,
  runner del navegador y construccion del shortlist desde `seen_jobs.json`.
- `browser/`       `fill.ts` (Playwright + DOM): rellena formularios, sube PDFs,
  rellena login/registro con `account_email`/`account_password`, detecta el codigo
  de verificacion y captura; envia solo con `--submit`.
- `config/routes.conf`     tarea -> modelo (una linea por tarea).
- `config/harness.env`     secretos (token, owner id). No se commitea.
- `config/answers.json`    banco de respuestas de formularios (valores especiales
  `@ask` y `@start_date_monday`). No se commitea. Hay una plantilla en
  `config/answers.example.json`.
- `agents/*.md`            agentes y comandos de opencode que se instalan en el repo
  (`harness`, `general-purpose` y el comando `chat`).
- `systemd/*`              bridge, Xvfb, timer diario y chequeo de FS.

## Flujo

1. `job-daily.timer` dispara `jobctl daily` (12:00).
2. `daily` corre `/scrape` y `/rank` con opencode, lee `seen_jobs.json`,
   construye el shortlist (status `ranked`, sin veto de ubicacion/idioma,
   excluyendo lo ya enviado y lo que esta en el tracker) y lo manda por Telegram.
3. El usuario responde con numeros, ej. `1 3`.
4. `tg-bridge` lanza `jobctl apply` por cada numero: corre `/apply`, recoge los
   PDFs nuevos y los manda por Telegram.
5. `jobctl fill <n>` rellena el formulario con Playwright (DOM), sube CV/carta,
   manda una captura por Telegram y espera.
6. El usuario responde `ok` y solo entonces `jobctl submit` envia. Con `no` cancela.

## Modelos

Reparto en `config/routes.conf`:

| Tarea | Modelo |
| --- | --- |
| scrape, rank, apply | `opencode-go/deepseek-v4.1-flash` |
| review (subagente) | `opencode-go/deepseek-v4-pro` |
| fallback (fallo del proveedor) | `opencode-go/deepseek-v4-flash` |

`harness.py` detecta fallos de proveedor (401/429/quota/red) y reintenta una vez
con el modelo `fallback`.

## Instalacion en la Pi

```bash
# desde el PC de desarrollo
rsync -a --exclude state/ harness/ pi@your-pi:~/job-harness/
scp ~/.local/share/opencode/auth.json pi@your-pi:~/.local/share/opencode/auth.json
ssh pi@your-pi 'cd ~/job-harness && ./install.sh'
```

Luego edita `~/job-harness/config/harness.env` (token y owner id) y:

```bash
systemctl --user restart job-tg.service
```

## Guardas

- Fallo de proveedor -> reintento con modelo de respaldo + aviso por Telegram.
- FS raiz en solo lectura -> `job-fscheck.timer` avisa cada 15 min.
- El bridge ignora mensajes de ids que no sean el propietario.
- El texto de ofertas y portales se trata como dato no confiable, nunca como
  instrucciones.
