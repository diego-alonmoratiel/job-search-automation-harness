# GUIA-PROYECTO.md

Documento vivo del proyecto de automatizacion de busqueda y solicitud de empleo.
Explica que se hace, por que, con que piezas y como operarlo. Se actualiza a lo
largo del proyecto: cada cambio relevante actualiza la seccion correspondiente y
el changelog (seccion 9).

Nivel: tecnico, pero cada termino se define la primera vez que aparece (seccion 2).

Ultima actualizacion: 2026-10-19

---

## 1. Que es este proyecto

Automatizar de extremo a extremo la busqueda de empleo y la solicitud de puestos,
de forma desatendida en una Raspberry Pi, con el usuario aprobando desde el movil
por Telegram.

Objetivo final del flujo:

1. Buscar ofertas y puntuarlas (`/scrape`, `/rank`).
2. Generar CV y carta adaptados a cada oferta (`/apply`).
3. Rellenar el formulario del portal (Playwright y, si hace falta, computer use).
4. Enviar solo tras un "ok" explicito del usuario por Telegram.

Perfil del usuario: a candidate targeting Cloud/Platform Engineering roles. See the candidate
profile for languages and constraints.

Hardware: Raspberry Pi 5, 4GB de RAM, sistema en tarjeta SD, Raspberry Pi OS
basado en Debian 13 (trixie), arquitectura ARM64 (aarch64). Acceso remoto por
Tailscale (IP YOUR_PI_IP) y por SSH (`pi@your-pi`).

Reglas no negociables:

- El contenido de CV y carta refleja solo experiencia real y defendible.
- Las respuestas libres de formularios salen del perfil o se preguntan al usuario,
  nunca se improvisan.
- Nunca se envia una solicitud sin un "ok" explicito por Telegram.
- El texto de ofertas y portales es entrada no confiable, nunca instrucciones.
- El puente de Telegram solo acepta mensajes del id del propietario.

---

## 2. Glosario

### Sistema operativo y servicios

- **Headless (sin cabecera / sin pantalla)**: un programa o una maquina que corre
  sin monitor ni entorno de escritorio. La Pi es headless: solo terminal y SSH.
  Muchas herramientas de navegador necesitan una pantalla; para eso se usa Xvfb.

- **systemd**: el gestor de servicios de Linux. Arranca y vigila programas
  ("unidades" o *units*): por ejemplo `ssh.service`. Se controla con
  `systemctl start|stop|status|enable`.

- **Servicio de usuario**: un servicio que corre con tu usuario, no como root, y
  vive aunque no tengas sesion abierta si se activa *linger*.

- **linger**: permiso que hace que los servicios de usuario sigan vivos sin que
  el usuario tenga una sesion iniciada. Necesario para que la Pi ejecute cosas
  desatendidas tras un reinicio.

- **timer**: equivalente de systemd a un cron. Dispara un servicio segun un
  calendario (por ejemplo, todos los dias a las 12:00).

- **journald**: el sistema de logs de systemd. Guarda los mensajes de los
  servicios. En la Pi se configura en modo *volatile* para no escribir en la SD.

- **volatile (journald)**: los logs viven en memoria (en `/run`), no en disco. Se
  pierden al reiniciar, pero no desgastan la tarjeta SD.

- **tmpfs**: sistema de ficheros que vive en RAM. Se usa para cosas temporales
  (cache de Chromium, logs) y desaparece al reiniciar.

- **swap**: espacio usado como memoria de respaldo cuando se llena la RAM.

- **zram**: swap comprimido en RAM en lugar de en disco. Evita desgastar la SD.
  La Pi ya lo tenia configurado (`/dev/zram0`, 2GB).

- **SD (tarjeta SD)**: almacenamiento de la Pi. Las tarjetas baratas se degradan
  con muchas escrituras; de ahi la politica de no escribir logs ni swap en disco.

- **k3s**: distribucion ligera de Kubernetes (orquestador de contenedores). La Pi
  era *worker* (nodo trabajador) de un cluster k3s del homelab del usuario,
  gestionado con el repo `edge-llm-k3s-observability`.

- **contenedor**: proceso aislado empaquetado con sus dependencias. En la Pi corria
  un LLM local (`llama-server`) como contenedor de k3s.

- **huerfano (orphan)**: proceso que sigue vivo despues de que su gestor haya
  muerto. Los contenedores del LLM quedaron huerfanos al parar k3s.

- **rsync**: copia ficheros entre maquinas de forma incremental, respetando
  exclusiones. Se uso para desplegar el repo y el harness a la Pi.

- **scp**: copia un fichero concreto por SSH. Se uso para copiar credenciales.

### Pantalla, accesibilidad y navegador

- **X11 / Xorg**: el servidor grafico clasico de Linux. Es lo que dibuja ventanas
  y recibe clics y teclado. En X11 un agente puede capturar ventanas e inyectar
  clics/teclado reales (via XTEST).

- **Wayland**: servidor grafico moderno, alternativa a X11. Es mas seguro, pero
  para computer use solo permite modo semantico (sin captura ni clics reales). Por
  eso el proyecto elige X11.

- **Xvfb (X virtual framebuffer)**: un servidor X11 "de mentira" que corre en
  memoria, sin monitor fisico. Da a los programas la ilusion de tener pantalla.
  Es la pieza que permite hacer computer use en una Pi headless.

- **D-Bus**: autobus de mensajes entre programas en Linux. Muchos servicios
  (accesibilidad, portales) se comunican por aqui. Sin un D-Bus de sesion activo,
  la accesibilidad no funciona.

- **AT-SPI2**: la capa de accesibilidad de Linux. Expone la interfaz de las
  aplicaciones (botones, campos de texto, etiquetas) para que lectores de pantalla
  y agentes puedan "leer" y "pulsar" controles de forma semantica, sin depender de
  las coordenadas de pixeles.

- **DOM (Document Object Model)**: el arbol de elementos de una pagina web (botones,
  campos, enlaces). Automatizar por DOM es localizar esos elementos por su
  estructura o etiqueta y rellenarlos. Es estable y barato.

- **CDP (Chrome DevTools Protocol)**: el "mando a distancia" de Chromium. Permite
  a un programa controlar el navegador por un puerto local. Playwright y
  pi-computer-use pueden compartir el mismo Chromium conectandose por CDP.

- **Playwright**: libreria de automatizacion de navegador. Se usa para rellenar
  formularios por DOM y subir ficheros. Soporta Linux ARM64.

- **computer use**: capacidad de un agente de "ver" la pantalla y actuar sobre
  ella (capturas, clics, teclado) como lo haria una persona. Es mas potente para
  interfaces opacas, pero mas lento y fragil que el DOM.

- **Chromium**: el navegador de codigo abierto de Google. Es el que se automatiza.

- **perfil persistente (de Chromium)**: carpeta donde el navegador guarda cookies y
  sesiones. Se mantiene en disco para no tener que iniciar sesion en cada portal
  cada vez.

- **ATS (Applicant Tracking System)**: plataforma que usan las empresas para
  recibir candidaturas (Greenhouse, Lever, Ashby, Workday, SuccessFactors...).
  Los tres primeros son los mas tratables por DOM.

### Modelos y agentes

- **opencode**: agente de programacion por terminal (el que ya usaba el usuario).
  Ejecuta los comandos del repo en modo no interactivo con
  `opencode run --command <cmd>`.

- **Pi**: otro agente de programacion (pi.dev, paquete
  `@earendil-works/pi-coding-agent`). Minimalista y extensible. Se usara solo para
  la parte de computer use.

- **pi-computer-use**: extension de Pi que le da herramientas para observar y
  controlar aplicaciones (y Chromium por CDP). Desde su version 0.5.0 soporta
  Linux, con helper nativo ARM64.

- **pi-telegram**: extension de Pi que conecta el agente con un bot de Telegram.

- **skill / command / agent (opencode)**: una *skill* es un paquete de
  instrucciones; un *command* es un atajo tipo `/scrape`; un *agent* define como
  se comporta el modelo (por ejemplo, no interactivo).

- **subagente**: agente lanzado por otro agente para una tarea puntual (por
  ejemplo, revisar un borrador). El repo usa uno llamado `general-purpose`.

- **OpenCode Go**: suscripcion de pago por uso de modelos. Es compatible con la
  API de OpenAI (base `https://opencode.ai/zen/go/v1`, autenticacion Bearer) y
  expone modelos como `deepseek-v4.1-flash` y `deepseek-v4-flash-vision-exp`.

- **API key**: clave secreta que da acceso a un servicio (modelo, bot...). No se
  sube nunca a un repositorio.

- **vision (modelo)**: modelo que ademas de texto entiende imagenes. Necesario
  para computer use si se trabaja por capturas.

### Documentos y utilidades

- **LaTeX**: sistema de composicion de documentos. El repo genera CV y carta en
  `.tex` y los compila a PDF con `lualatex` (CV) y `xelatex` (carta).

- **pdftotext / poppler**: herramienta que extrae el texto de un PDF. Se usa para
  comprobar que un ATS "lee" bien el CV.

- **Bun**: runtime de JavaScript/TypeScript. Ejecuta los CLI de los portales de
  empleo (escritos en TypeScript). Tiene build ARM64.

- **MCP (Model Context Protocol)**: protocolo para conectar agentes con servicios
  externos (Gmail, Notion, navegador...). Algunos comandos del repo dependen de MCP
  y no son viables en modo desatendido.

- **shortlist**: lista corta de ofertas preseleccionadas que se envia al usuario
  para que elija.

- **harness (arnes)**: la capa de fontaneria que envuelve al agente: ejecuta
  comandos, enruta modelos, guarda estado, avisa por Telegram y sobrevive
  reinicios. Es lo que se construyo en este proyecto.

---

## 3. Arquitectura

### Vision final

```
                    Telegram (movil)
                          |
                          v
+-----------------------------------------------------------+
|  Raspberry Pi 5 (Debian 13, ARM64, headless)              |
|                                                           |
|  harness (job-harness)                                    |
|    - tg-bridge ....... comandos / URLs / lenguaje natural |
|    - jobctl .......... daily/apply/fill/submit/retarget/say|
|    - state.json ...... ofertas, candidaturas, stuck        |
|    - routes.conf ..... tarea -> modelo                     |
|                                                           |
|    +-- opencode run --command scrape|rank|apply|chat       |
|    |       repo ai-job-search (prompts + CLI de portales)  |
|    |                                                      |
|    +-- jobctl fill  (implementado)                        |
|            Chromium con depuracion remota en Xvfb :99     |
|              - Playwright (DOM) por CDP ... campos + PDFs  |
|              - CDP <-> Pi + pi-computer-use ... respaldo   |
|            captura -> Telegram -> espera "ok" -> envia     |
+-----------------------------------------------------------+
```

### Componentes

1. **Repo `ai-job-search`** (metodologia): prompts en `.claude/`, comandos
   (`/scrape`, `/rank`, `/apply`...), CLI de portales en `.agents/skills/` y el
   tracker. Desplegado en `~/ai-job-search` en la Pi.

2. **opencode** (ejecutor): corre los comandos del repo en modo no interactivo. En
   modo `opencode run` no existe el *question tool*, asi que los prompts no se
   quedan esperando respuesta: terminan el turno.

3. **harness** (coordinador): `~/job-harness`. Envuelve a opencode, guarda estado,
   habla con Telegram y se arranca con systemd.

4. **Pi + pi-computer-use** (respaldo de formularios): corre dentro de la sesion
   grafica virtual (Xvfb) y actua sobre el **mismo** Chromium que Playwright, por
   CDP. Se usa para los campos que el DOM no puede rellenar.

5. **Telegram**: interfaz de aprobacion y de mando. El bridge solo acepta el id del
   propietario y enruta tres tipos de mensaje: comandos, URLs (retarget/apply) y
   lenguaje natural (lo interpreta un agente).

### Estructura del harness (en el PC de desarrollo y desplegado en `~/job-harness`)

```
harness/
  bin/
    jobctl          CLI: daily, apply, fill, submit, retarget, say, status, fscheck
    tg-bridge       long polling de Telegram; enruta comandos, URLs y lenguaje natural
  lib/
    harness.py      config, estado con lock, API Telegram, runners (opencode,
                    navegador, computer use) y shortlist
  browser/
    fill.ts         relleno por DOM (Playwright), deteccion de atasco y modos CDP
    test-form.html  formulario de prueba
  config/
    routes.conf             tarea -> modelo
    harness.env.example     plantilla de secretos (el real no se commitea)
    answers.example.json    plantilla del banco de respuestas
    opencode.overrides.json parche que se fusiona en el opencode.json del repo
  agents/
    harness.md              agente opencode no interactivo
    general-purpose.md      subagente (triage y revision)
    chat.md                 comando de opencode para lenguaje natural (se instala
                            en el repo como .opencode/command/chat.md)
  systemd/
    job-tg.service          bridge siempre activo
    job-xvfb.service        pantalla virtual Xvfb :99
    job-daily.service/timer scrape+rank+shortlist cada dia a las 12:00
    job-fscheck.service/timer aviso si el disco raiz pasa a solo lectura
  install.sh        despliegue en la Pi
  README.md
```

---

## 4. Estado actual y fases

| Fase | Descripcion | Estado |
| --- | --- | --- |
| 0 | Diagnostico de la Pi y limpieza de restos k3s | Hecho |
| 1a | opencode + bun, ajustes de SD, despliegue del repo, harness | Hecho |
| 1b | LaTeX minimo + poppler (para PDFs) | Hecho |
| 2a | Spike Xvfb + Chromium + Playwright (relleno DOM) | Hecho |
| 2b | Spike Pi + pi-computer-use sobre Xvfb (CDP/AT-SPI2) | Hecho |
| 2c | Banco de respuestas + preguntas por Telegram | Hecho (v1) |
| 2d | `jobctl fill` completo con gate de "ok" | Hecho (v1) |
| 2e | Portales dificiles y captcha con VNC | Pendiente |

Lo que ya funciona y esta verificado en la Pi:

- CLI de portal `freehire-search` (busqueda real de ofertas en Alemania).
- **Portal Stepstone** (`stepstone.de` y `stepstone.at`): skill `stepstone-search`
  con CLI propio. Busqueda por palabras clave y filtro de ciudad (`--location`).
  `stepstone.de` se lee por HTTP; `stepstone.at` bloquea clientes no-browser (403),
  asi que el CLI hace fallback a Chromium headless. Probado en DE y AT.
- **Portales jobs.ch y stellenanzeigen.de**: skills propias (`jobs-ch-search` y
  `stellenanzeigen-search`), ambas por HTTP y sin dependencias. Busqueda con
  `-q`, `--page`, `--limit` y `detail`. Probadas en la Pi y validadas por
  `lint_skills` (18 skills). **Arbeitsagentur**: su API oficial devuelve 403 desde
  Espana (probable geobloqueo/region), asi que no se implemento.
- `opencode run` con el modelo `opencode-go/deepseek-v4.1-flash`.
- `opencode run --command html-report --agent harness --auto` (flujo completo).
- El constructor de shortlist leyendo `seen_jobs.json` real (filtra vetos y tracker).
- El **bridge de Telegram** (`job-tg.service`) corriendo con el bot
  `@your_bot` y el id del propietario configurado.
- **Xvfb :99** gestionado por `job-xvfb.service` (pantalla virtual persistente).
- **Pi + pi-computer-use** configurado con OpenCode Go y capaz de controlar
  Chromium sobre Xvfb.
- **Rellenador de formularios** (`harness/browser/fill.ts`, Playwright + DOM):
  rellena campos por etiqueta/nombre desde `answers.json`, sube CV/carta, marca
  radios (si/no), hace captura y, solo con `--submit`, envia. Soporta valores
  dinamicos (`@start_date_monday` = hoy + 1 mes al lunes siguiente) y modo "pedir"
  (`@ask`, p. ej. el salario: se pregunta por Telegram antes de enviar). Los datos
  voluntarios (fecha de nacimiento, genero) solo se rellenan si el campo es
  obligatorio. Probado contra un formulario de prueba tipo ATS con el ciclo
  `fill` -> pregunta -> respuesta -> `ok` -> `submit`.
- **Navegador compartido por CDP + respaldo computer use**: `jobctl fill` lanza un
  Chromium con depuracion remota (`--remote-debugging-port`); Playwright se conecta
  por CDP y rellena, y si quedan campos con respuesta conocida que el DOM no pudo
  rellenar, Pi + pi-computer-use se conecta al **mismo** Chromium por CDP y los
  rellena. Verificado que Pi lee e interactua con los desplegables react-select de
  Greenhouse por CDP.
- **Todos los CV y cartas en ingles**, forzado tanto en el agente `harness` como en
  el `AGENTS.md` del repo, sea cual sea el idioma de la oferta.
- **Timer diario a las 12:00** (`job-daily.timer`).
- **Bot flexible y redireccion**: los mensajes que no son comandos van a un agente
  (`jobctl say` -> comando `chat`) que interpreta y actua llamando a `jobctl`. Si el
  relleno se atasca (anti-bot, captcha o sin formulario) el bot avisa; entonces
  puedes mandarle un link y reapunta la candidatura reutilizando su CV/carta
  (`jobctl retarget`), o si no habia atasco lo trata como oferta nueva (`apply`).

`@your_bot` responde a comandos, URLs y lenguaje natural; el timer diario
corre a las 12:00. En el estado de la Pi hay candidaturas reales ya redactadas y
alguna esperando el `ok` para enviarse.
- **Cuentas y verificacion**: `fill.ts` detecta formularios de login/registro y los
  rellena con `account_email`/`account_password` (del banco de respuestas) y pulsa
  "Sign in"/"Create account". Si el portal pide un codigo de verificacion, el bot
  mantiene la pagina abierta, te lo pide por Telegram y lo introduce sin recargar
  (`jobctl verify`).
- **Puntuar una oferta suelta**: `jobctl score <url>` (o `puntua <url>` por Telegram)
  evalua una oferta con el framework y el Language Gate **sin redactar ni rellenar**:
  devuelve banda, idioma (PASS/FLAG/FAIL + nota), ubicacion y recomendacion
  (aplicar/dudoso/descartar) con 2-3 razones. Aplica tu regla de descartar si pide
  aleman por encima de B1.

---

## 5. Decisiones y por que

| Decision | Motivo | Alternativas descartadas |
| --- | --- | --- |
| Limpiar los contenedores k3s huerfanos | El LLM huerfano consumia 2GB de 4GB | Dejarlos: no caben Chromium + LaTeX + agente |
| Mantener `k3s-agent` deshabilitado | La Pi deja de ser worker del homelab, libera RAM | Seguir como worker: no cabe en 4GB |
| journald volatile + swap zram | La SD es de baja calidad; no escribir logs ni swap en disco | Escribir en disco: desgasta la SD |
| opencode como ejecutor del repo | El repo ya estaba adaptado a opencode y funciona | Migrar todo a Pi: mas trabajo y hay que readaptar |
| Pi + computer use solo para formularios | Aprovecha la extension de Pi sin reescribir el repo | Usar Pi para todo |
| X11 (Xvfb) en lugar de Wayland | X11 da captura y clics reales; Wayland solo semantica | Wayland: computer use limitado |
| Relleno hibrido: DOM + computer use | DOM es estable y barato; computer use cubre lo opaco | Solo DOM: no resuelve captchas; solo computer use: fragil |
| Tope de 40 ofertas nuevas por `/rank` | `seen_jobs.json` tenia 831 `new`; evita picos de coste | Rankear todo de golpe: caro y lento |
| Modelo base `deepseek-v4.1-flash` | Plan OpenCode Go; buen coste | Modelos Pro por defecto: topan la cuota |
| Parar siempre antes de enviar | Regla del proyecto; evita envios irreversibles | Auto-enviar: riesgo de error |
| Copiar `auth.json` a la Pi | Reutiliza la suscripcion OpenCode Go ya pagada | Reautenticar en la Pi |
| Navegador compartido por CDP | Playwright y Pi usan el mismo Chromium; el respaldo ve lo ya rellenado | Dos navegadores: se pierde el estado |
| Bot flexible + retarget por link | El usuario puede corregir/reorientar cuando el bot se atasca | Solo comandos fijos: rigido ante imprevistos |

Correccion importante respecto al documento de contexto original: decia que
`pi-computer-use` solo funcionaba en macOS. Desde la version 0.5.0 (julio 2026)
soporta Linux con helper nativo ARM64, por lo que la idea original del usuario
(Pi + computer use) si es viable en la Raspberry Pi.

---

## 6. Historial de comandos

Todos los comandos se ejecutan desde el PC de desarrollo (WSL) salvo que se indique
lo contrario. `pi@your-pi` es la Raspberry Pi por Tailscale/SSH.

### 6.1 Diagnostico (solo lectura)

```bash
# Comprobar conectividad y arquitectura
ssh -o BatchMode=yes -o ConnectTimeout=8 pi@your-pi 'echo OK; hostname; uname -m'

# Bloques de inspeccion (OS, RAM, swap, k3s, LLM, herramientas, navegador,
# linger, journald, temperatura, top de RAM, /proc/swaps, unidades en ejecucion,
# config de k3s, tarjeta SD, dmesg, /opt, proyectos previos, shims y cgroups)
ssh -o BatchMode=yes pi@your-pi 'bash -s' <<'EOF'
  ... (varios bloques de solo lectura)
EOF
```

Hallazgos: Debian 13 aarch64; 4GB RAM; swap zram de 2GB; `k3s-agent` disabled pero
con `llama-server` (qwen2.5-1.5b, 2GB RSS) y `node_exporter` huerfanos; sin
opencode/bun/chromium; SD generica de 48GB; Tailscale activo; sudo sin password.

### 6.2 Limpieza de restos k3s (libera ~2GB)

```bash
sudo pkill -f '/app/llama-server'          # mata el proceso del LLM
sudo pkill -f '/bin/node_exporter'         # mata el exporter de metricas
sleep 3
sudo pkill -f 'containerd-shim-runc-v2'    # mata los shims que quedasen
sudo systemctl stop 'cri-containerd-*.scope' 2>/dev/null  # limpia cgroups k8s
```

Resultado: RAM usada de 1.4GB a 326MB; `k3s-agent` sigue disabled.

### 6.3 Instalacion base

```bash
# Bun (runtime para los CLI de portales)
curl -fsSL https://bun.sh/install | bash

# opencode (agente ejecutor)
curl -fsSL https://opencode.ai/install | bash
```

Instalado: bun 1.4.2 y opencode 1.18.35 en `~/.bun/bin` y `~/.opencode/bin`.

### 6.4 Ajustes de SD y sesion

```bash
# journald en memoria (no escribe logs en la SD)
sudo mkdir -p /etc/systemd/journald.conf.d
sudo sh -c 'printf "[Journal]\nStorage=volatile\nRuntimeMaxUse=64M\nSystemMaxUse=64M\n" > /etc/systemd/journald.conf.d/volatile.conf'
sudo systemctl restart systemd-journald

# permitir servicios de usuario sin sesion abierta
sudo loginctl enable-linger pi
```

### 6.5 Despliegue del repo ai-job-search (desde el PC)

```bash
rsync -rltv --no-perms \
  --exclude 'node_modules/' --exclude '__pycache__/' --exclude '.pytest_cache/' \
  --exclude '*.pdf' --exclude '*.aux' --exclude '*.log' --exclude '*.out' \
  --exclude '*.fls' --exclude '*.fdb_latexmk' --exclude '*.synctex.gz' \
  /mnt/c/Users/admin/PROJECTS/ai-job-search/ pi@your-pi:~/ai-job-search/
```

### 6.6 Credenciales de modelo

```bash
# Copia de las credenciales de opencode (OpenCode Go) a la Pi
scp ~/.local/share/opencode/auth.json pi@your-pi:~/.local/share/opencode/auth.json
```

### 6.7 Despliegue del harness (desde el PC)

```bash
rsync -rlptv --no-perms --exclude 'state/*' --exclude 'config/harness.env' \
  --exclude '__pycache__' \
  /mnt/c/Users/admin/PROJECTS/full-automated-ai-job-search/harness/ pi@your-pi:~/job-harness/

# En la Pi: permisos de ejecucion
chmod +x ~/job-harness/bin/*

# Parcheo de ~/ai-job-search/opencode.json (fusion con Python):
#   model = opencode-go/deepseek-v4.1-flash
#   permission.bash."*" = allow, webfetch/websearch/task = allow, edit = allow
# Copia de agentes y comandos a ~/ai-job-search/.opencode/
#   agent/harness.md, agent/general-purpose.md, command/chat.md
```

El script `harness/install.sh` automatiza todo esto (parche, agentes, comando
`chat`, systemd) y ademas habilita `job-xvfb.service`, `job-tg.service`,
`job-daily.timer` y `job-fscheck.timer`.

### 6.8 Pruebas realizadas

```bash
# CLI de portal (busqueda real)
bun run .agents/skills/freehire-search/cli/src/cli.ts search -q "platform engineer" --country DE --limit 3 --format table

# Modelo responde
opencode run -m opencode-go/deepseek-v4.1-flash "Reply with exactly one word: READY"

# Comando del repo + agente harness (flujo completo, escribe reporte)
opencode run --command html-report --agent harness --auto
```

### 6.9 LaTeX + poppler (fase 1b, en la Pi)

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  texlive-luatex texlive-xetex texlive-latex-extra texlive-latex-recommended \
  texlive-fonts-recommended texlive-fonts-extra texlive-lang-german poppler-utils

# Verificacion: compilar el CV y la carta del repo
cd ~/ai-job-search/cv && lualatex -interaction=nonstopmode -halt-on-error main_example.tex
# y la carta con xelatex (cover.cls)
```

### 6.10 Xvfb + Chromium + accesibilidad (fase 2a, en la Pi)

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  xvfb x11-utils dbus-x11 at-spi2-core libatk-adaptor chromium fonts-liberation

# Prueba DOM: Playwright lanzando Chromium sobre Xvfb :99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
cd ~/job-harness/browser && DISPLAY=:99 bun run fill.ts --url file://.../test-form.html ...
```

### 6.11 Node + Pi + pi-computer-use (fase 2b, en la Pi)

```bash
# Node 22 (Pi requiere >= 22.19)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Pi y la extension de computer use
curl -fsSL https://pi.dev/install.sh | sh
pi install npm:@injaneity/pi-computer-use

# Proveedor custom de Pi reutilizando la API key de OpenCode Go
#   ~/.pi/agent/models.json -> baseUrl https://opencode.ai/zen/go/v1 (openai-completions)
#   modelos: deepseek-v4.1-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro

# Prueba: Pi maneja un Chromium externo por CDP
PI_COMPUTER_USE_CDP_PORT=9222 DISPLAY=:99 pi -p --model opencode-go/deepseek-v4.1-flash \
  "report the page title"
```

### 6.12 Despliegue del harness y systemd (en la Pi)

```bash
cd ~/job-harness && ./install.sh
# parchea ~/ai-job-search/opencode.json, instala agentes y el comando chat,
# y habilita job-xvfb.service, job-tg.service, job-daily.timer, job-fscheck.timer
```

### 6.13 Pruebas de formularios y bot flexible

```bash
# Formulario de prueba tipo ATS (13/13 campos)
DISPLAY=:99 bun run fill.ts --url file://.../test-form.html --answers answers.json --cv <cv.pdf>

# Portal real (Greenhouse, Planet Labs): rellena campos estandar y detecta preguntas
# Flujo completo con gate: fill -> pregunta salario -> respuesta -> ok -> submit
~/job-harness/bin/jobctl fill "<url>"
~/job-harness/bin/jobctl submit "<url>"

# Bot flexible y redireccion
~/job-harness/bin/jobctl say "dame un resumen del estado"
~/job-harness/bin/jobctl retarget "<nueva-url>"   # reapunta una candidatura atascada
```

---

## 7. Operacion

### Ver estado de los servicios

```bash
systemctl --user status job-tg.service
systemctl --user list-timers 'job-*'
systemctl --user status job-daily.service
```

### Ver logs

El harness escribe su propio log en `~/job-harness/state/harness.log` (el journald
de usuario no persiste en esta Pi, asi que `journalctl --user` sale vacio). Para
seguirlo en vivo:

```bash
tail -f ~/job-harness/state/harness.log
```

### Arrancar / parar / reiniciar

```bash
systemctl --user restart job-tg.service
systemctl --user stop job-daily.timer
systemctl --user start job-daily.timer
```

### Lanzar tareas a mano

```bash
~/job-harness/bin/jobctl daily          # scrape + rank + shortlist + Telegram
~/job-harness/bin/jobctl apply 1        # preparar la oferta numero 1 del shortlist
~/job-harness/bin/jobctl fill 1         # rellenar el formulario de la oferta 1 (sin enviar)
~/job-harness/bin/jobctl submit <url>   # enviar la solicitud rellenada
~/job-harness/bin/jobctl retarget <url> # reapuntar la candidatura atascada a otra URL
~/job-harness/bin/jobctl say "texto"    # peticion en lenguaje natural (agente)
~/job-harness/bin/jobctl status         # resumen por Telegram
~/job-harness/bin/jobctl fscheck        # comprobar disco de solo lectura
```

### Comandos por Telegram (al bot)

- `<numeros>` (por ejemplo `1 3`): preparar esas candidaturas.
- `fill <n>`: rellenar el formulario de la oferta n.
- `puntua <url>`: puntua una oferta (encaje + idioma + ubicacion) **sin** redactar ni
  rellenar; te da banda, veredicto de idioma/ubicacion y recomendacion
  (aplicar/dudoso/descartar).
- `ok`: continua la candidatura **en curso**: si es un borrador (`drafted`), rellena
  el formulario; si ya esta rellenada (`awaiting_ok`), la envia.
- `no`: cancela la candidatura en curso.
- si el bot te pide un dato (p. ej. salario) o un **codigo de verificacion**,
  responde con el valor (o `skip` para dejar un campo en blanco).
- un **link (URL)**: si hay una candidatura atascada, la reapunta a ese link
  (reutiliza CV/carta); si no, redacta una candidatura nueva (`apply`).
- **cualquier texto libre**: lo interpreta el agente (`say`) y actua o responde.
- `lista`: reenviar el shortlist actual.
- `status`: resumen de estado.
- `daily`: lanzar scrape + rank ahora.
- `help`: ayuda.

### Ficheros de configuracion y secretos

- `~/job-harness/config/harness.env`: token de Telegram y owner id. Permisos 600.
- `~/job-harness/config/routes.conf`: tarea -> modelo. Editar una linea para
  cambiar de modelo.
- `~/job-harness/config/answers.json`: banco de respuestas de formularios. Valores
  especiales: `@ask` (no rellenar; preguntar antes de enviar) y
  `@start_date_monday` (fecha dinamica). No se commitea.
- `~/job-harness/state/state.json`: estado (ofertas, candidaturas, offset de
  Telegram, campo pendiente).
- `~/.local/share/opencode/auth.json` y `~/.pi/agent/models.json`: la **API key de
  OpenCode Go** (opencode y Pi). Si caduca, crear una nueva en la consola de OpenCode
  y sustituirla en ambos ficheros (permisos 600). Reautenticarse NO la renueva.

---

## 8. Riesgos y pendientes

- **AT-SPI2 en Xvfb headless**: se comprobo que el bus de accesibilidad arranca
  (`at-spi-bus-launcher` + `at-spi2-registryd`), pero Chromium no se registra en el
  arbol AT-SPI de un Xvfb pelado. No es bloqueante: pi-computer-use controla
  Chromium por **CDP** (loopback), no por AT-SPI. AT-SPI solo haria falta para
  aplicaciones nativas, que no usamos. Pendiente menor, no critico.
- **DNS con Tailscale**: al lanzar el navegador, la resolucion via MagicDNS
  (100.100.100.100) fallo para un dominio externo; pi-computer-use lo resolvio con
  un mapeo de host. Conviene revisar la config de DNS de Tailscale o el
  `resolv.conf` de la Pi antes de automatizar portales.
- **RAM**: Chromium, Pi y opencode no deben correr a la vez. Ejecucion en serie.
- **Terminos de uso**: LinkedIn prohibe explicitamente la automatizacion y arriesga
  la cuenta.
- **Captchas y login/2FA**: se resuelven a mano una vez por VNC y se reutiliza el
  perfil persistente.
- **Portales duros**: Workday y SuccessFactors probablemente resistan al DOM.
- **LaTeX**: instalado (fase 1b) con texlive-luatex, texlive-xetex,
  texlive-latex-extra, texlive-fonts-extra y poppler-utils. CV y carta compilan.
- **SD de baja calidad**: existe una imagen de respaldo en el PC
  (`~/pi-sd.img.gz`). Pendiente valorar una SD high endurance.
- **Credenciales de Pi**: resuelto. Pi usa un proveedor custom `opencode-go`
  (`~/.pi/agent/models.json`) con la misma API key de OpenCode Go, extraida en la
  propia Pi desde `~/.local/share/opencode/auth.json`.
- **Rellenador v1**: `fill.ts` es heuristico. Probado en un formulario de prueba y en
  una oferta real de Greenhouse (Planet Labs): rellena los campos estandar (nombre,
  email, telefono, pais, ubicacion, LinkedIn, genero, subida de CV) y detecta las
  preguntas personalizadas, que se preguntan por Telegram. Los campos con respuesta
  conocida que el DOM no rellena pasan al respaldo con computer use (Pi por CDP).
  Quedan sin cubrir los campos sin etiqueta asociada (placeholder "Select..."): no
  se pueden ni preguntar con sentido ni rellenar sin dato, asi que se listan para
  revision manual.
- **Proteccion anti-bot**: SmartRecruiters bloquea con un challenge ("Verification
  Required"). Se resolveria a mano por VNC o con medidas anti-deteccion.
- **Salario**: nunca se rellena solo. `fill.ts` lo marca como pendiente y el harness
  lo pregunta por Telegram antes de enviar; el valor es por candidatura y no se
  persiste entre formularios.

---


## 9. Changelog

See the git history for the change log.
