#!/usr/bin/env python3
"""Shared library for the job-search automation harness.

Pure Python 3 standard library. No third-party dependencies.

Responsibilities:
  * load harness config (env + model routes)
  * read/write the harness state file under a file lock
  * talk to the Telegram Bot API
  * run the ai-job-search repo commands through `opencode run` (non-interactive),
    with model routing and fallback on provider failures
  * build the ranked shortlist from the repo's own seen_jobs.json
"""

from __future__ import annotations

import csv
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = HARNESS_DIR / "config"
STATE_DIR = HARNESS_DIR / "state"
STATE_FILE = STATE_DIR / "state.json"
LOCK_FILE = STATE_DIR / ".state.lock"
LOG_FILE = STATE_DIR / "harness.log"
ENV_FILE = CONFIG_DIR / "harness.env"
ROUTES_FILE = CONFIG_DIR / "routes.conf"

DEFAULTS = {
    "AIJOB_DIR": str(Path.home() / "ai-job-search"),
    "TELEGRAM_BOT_TOKEN": "",
    "TELEGRAM_OWNER_ID": "",
    "SHORTLIST_SIZE": "5",
    "OPENCODE_BIN": "opencode",
    "OPENCODE_AGENT": "harness",
    "RUN_TIMEOUT": "3600",
    # Max number of `status:new` jobs to hand to /rank per run, newest first.
    # Older ones are parked as `deferred` and restored afterwards, so a large
    # backlog is worked through in bounded batches instead of all at once.
    # Set to 0 for no cap.
    "RANK_MAX_NEW": "40",
}

DEFAULT_STATE = {
    "telegram_offset": 0,
    "shortlist": [],
    "applications": {},
    "offered_urls": [],
    "last_scrape": None,
    "last_rank": None,
    "pending_input": None,
    "stuck": None,
    "current": None,
    "alerts": [],
}

# Substrings that mean the provider rejected the call rather than a task failure.
PROVIDER_FAILURE_MARKERS = (
    "invalid api key",
    "unauthorized",
    "401",
    "402",
    "403",
    "429",
    "rate limit",
    "rate_limit",
    "insufficient",
    "quota",
    "credit",
    "no credits",
    "billing",
    "account is not active",
    "overloaded",
    "connection error",
    "econnrefused",
    "etimedout",
    "fetch failed",
)


# --------------------------------------------------------------------------- #
# logging
# --------------------------------------------------------------------------- #
def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    # stderr is captured by journald (volatile) when run as a systemd unit.
    print(line, file=sys.stderr, flush=True)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #
def _parse_kv_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            out[key] = value
    return out


def load_config() -> dict[str, str]:
    cfg = dict(DEFAULTS)
    # Global override first, then repo-local env wins.
    cfg.update(_parse_kv_file(Path.home() / ".config" / "job-harness" / "env"))
    cfg.update(_parse_kv_file(ENV_FILE))
    # Real environment variables win over files (systemd Environment=).
    for key in DEFAULTS:
        if os.environ.get(key):
            cfg[key] = os.environ[key]
    return cfg


def load_routes() -> dict[str, str]:
    routes = {
        "default": "opencode-go/deepseek-v4.1-flash",
        "scrape": "opencode-go/deepseek-v4.1-flash",
        "rank": "opencode-go/deepseek-v4.1-flash",
        "apply": "opencode-go/deepseek-v4.1-flash",
        "review": "opencode-go/deepseek-v4-pro",
        "computer_use": "opencode-go/deepseek-v4-flash-vision-exp",
        "fallback": "opencode-go/deepseek-v4-flash",
    }
    routes.update(_parse_kv_file(ROUTES_FILE))
    return routes


def model_for(task: str) -> str:
    routes = load_routes()
    return routes.get(task) or routes.get("default")


# --------------------------------------------------------------------------- #
# state (locked)
# --------------------------------------------------------------------------- #
class StateLock:
    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.fh = LOCK_FILE.open("w")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_exc):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def load_state() -> dict:
    if not STATE_FILE.exists():
        return dict(DEFAULT_STATE)
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_STATE)
    merged = dict(DEFAULT_STATE)
    merged.update(data)
    return merged


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE_FILE)


# --------------------------------------------------------------------------- #
# telegram
# --------------------------------------------------------------------------- #
def tg_call(config: dict, method: str, **params):
    token = config.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=70) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # keep the API error body
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Telegram {method} HTTP {exc.code}: {body}") from exc
    if not payload.get("ok"):
        raise RuntimeError(f"Telegram {method} failed: {payload}")
    return payload.get("result")


def _owner_chat_id(config: dict) -> str:
    chat_id = config.get("TELEGRAM_OWNER_ID", "")
    if not chat_id:
        raise RuntimeError("TELEGRAM_OWNER_ID is not configured")
    return chat_id


def tg_send(config: dict, text: str) -> None:
    chat_id = _owner_chat_id(config)
    limit = 3800
    chunks = [text[i : i + limit] for i in range(0, len(text), limit)] or [""]
    for chunk in chunks:
        tg_call(config, "sendMessage", chat_id=chat_id, text=chunk, disable_web_page_preview="true")


def tg_send_document(config: dict, path: Path, caption: str = "") -> None:
    chat_id = _owner_chat_id(config)
    token = config.get("TELEGRAM_BOT_TOKEN", "")
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    boundary = "----harnessboundary" + str(int(time.time()))
    parts: list[bytes] = []

    def field(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ).encode()

    parts.append(field("chat_id", str(chat_id)))
    if caption:
        parts.append(field("caption", caption[:1024]))
    file_bytes = path.read_bytes()
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="document"; filename="{path.name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(url, data=body)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"Telegram sendDocument failed: {payload}")


# --------------------------------------------------------------------------- #
# opencode runner
# --------------------------------------------------------------------------- #
def _opencode_env(config: dict) -> dict[str, str]:
    env = dict(os.environ)
    home = str(Path.home())
    extra = [f"{home}/.opencode/bin", f"{home}/.bun/bin", f"{home}/.local/bin"]
    env["PATH"] = ":".join(extra + [env.get("PATH", "/usr/local/bin:/usr/bin:/bin")])
    env.setdefault("HOME", home)
    return env


def _looks_like_provider_failure(output: str) -> bool:
    low = output.lower()
    return any(marker in low for marker in PROVIDER_FAILURE_MARKERS)


# --------------------------------------------------------------------------- #
# browser form filler (Playwright, run via bun)
# --------------------------------------------------------------------------- #
BROWSER_DIR = HARNESS_DIR / "browser"


def run_browser_fill(
    config: dict,
    url: str,
    *,
    cv: str | None = None,
    cover: str | None = None,
    screenshot: str = "/tmp/harness-fill.png",
    submit: bool = False,
    timeout: int = 300,
    answers_path: str | None = None,
    cdp_port: int | None = None,
    no_navigate: bool = False,
    screenshot_only: bool = False,
    verify_code: str | None = None,
) -> dict:
    """Run browser/fill.ts and return its JSON result (dict with error on failure)."""
    answers = Path(answers_path) if answers_path else CONFIG_DIR / "answers.json"
    if not answers.exists():
        raise RuntimeError(f"{answers} no existe; crea el banco de respuestas")
    cmd = [
        "bun",
        "run",
        str(BROWSER_DIR / "fill.ts"),
        "--url",
        url,
        "--answers",
        str(answers),
        "--screenshot",
        screenshot,
    ]
    if cv:
        cmd += ["--cv", cv]
    if cover:
        cmd += ["--cover", cover]
    if submit:
        cmd += ["--submit"]
    if cdp_port:
        cmd += ["--cdp-port", str(cdp_port)]
    if no_navigate:
        cmd += ["--no-navigate"]
    if screenshot_only:
        cmd += ["--screenshot-only"]
    if verify_code:
        cmd += ["--verify-code", verify_code]
    env = _opencode_env(config)
    env.setdefault("DISPLAY", ":99")
    env.setdefault("CHROME_EXECUTABLE", "/usr/bin/chromium")
    log(f"run_browser_fill submit={submit} cdp={cdp_port} shot_only={screenshot_only} url={url}")
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(BROWSER_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raw = exc.stdout or ""
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        out = raw.strip()
        start = out.find("{")
        if start != -1:
            try:
                return json.loads(out[start:])
            except json.JSONDecodeError:
                pass
        return {"error": f"timeout after {timeout}s"}
    out = proc.stdout.strip()
    start = out.find("{")
    if start == -1:
        return {"error": "no JSON output", "stderr": proc.stderr[-500:]}
    try:
        return json.loads(out[start:])
    except json.JSONDecodeError:
        return {"error": "invalid JSON", "raw": out[-500:]}


# --------------------------------------------------------------------------- #
# external Chromium + Pi computer-use fallback
# --------------------------------------------------------------------------- #
def _port_listening(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def launch_chrome(config: dict, url: str, port: int = 9222, profile_dir: str | None = None) -> bool:
    """Start a standalone Chromium with remote debugging (shared with Pi via CDP)."""
    if _port_listening(port):
        return True
    profile = profile_dir or str(STATE_DIR / "chromium-profile")
    Path(profile).mkdir(parents=True, exist_ok=True)
    env = _opencode_env(config)
    env.setdefault("DISPLAY", ":99")
    chrome = env.get("CHROME_EXECUTABLE", "/usr/bin/chromium")
    cmd = [
        chrome,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--force-renderer-accessibility",
        url,
    ]
    log(f"launch_chrome port={port}")
    subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(40):
        if _port_listening(port):
            return True
        time.sleep(1)
    return False


def run_computer_use(config: dict, task: str, cdp_port: int, timeout: int = 600) -> tuple[int, str, str]:
    """Run Pi with the computer-use extension attached to the shared Chromium."""
    env = _opencode_env(config)
    env["DISPLAY"] = env.get("DISPLAY", ":99")
    env["PI_COMPUTER_USE_CDP_PORT"] = str(cdp_port)
    env.setdefault("CHROME_EXECUTABLE", "/usr/bin/chromium")
    pi = str(Path.home() / ".pi" / "agent" / "bin" / "pi")
    if not Path(pi).exists():
        pi = "pi"
    cmd = [pi, "-p", "--model", model_for("computer_use"), task]
    log(f"run_computer_use cdp={cdp_port} model={model_for('computer_use')}")
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(Path(config["AIJOB_DIR"])),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"


def run_opencode(
    config: dict,
    task: str,
    command: str,
    args: str = "",
    *,
    agent: str | None = None,
    timeout: int | None = None,
    allow_fallback: bool = True,
):
    """Run an opencode command non-interactively.

    Returns (returncode, stdout, stderr, model_used).
    On provider failure, retries once with the fallback model.
    """
    aijob = Path(config["AIJOB_DIR"])
    agent = agent or config.get("OPENCODE_AGENT", "harness")
    routes = load_routes()
    timeout = timeout or int(config.get("RUN_TIMEOUT", "3600"))
    model = model_for(task)

    def _attempt(model_id: str):
        cmd = [
            config.get("OPENCODE_BIN", "opencode"),
            "run",
            "--command",
            command,
            "--auto",
            "--agent",
            agent,
            "-m",
            model_id,
        ]
        if args:
            cmd.append(args)
        log(f"run_opencode task={task} command={command} model={model_id} args={args!r}")
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(aijob),
                env=_opencode_env(config),
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as exc:
            return 124, exc.stdout or "", f"timeout after {timeout}s"

    rc, out, err = _attempt(model)
    combined = f"{out}\n{err}"
    if rc != 0 and allow_fallback and _looks_like_provider_failure(combined):
        fallback = routes.get("fallback")
        if fallback and fallback != model:
            log(f"provider failure on {model}, retrying with fallback {fallback}")
            rc, out, err = _attempt(fallback)
            model = fallback
            combined = f"{out}\n{err}"
    if rc != 0 and _looks_like_provider_failure(combined):
        log(f"WARNING: provider failure persisted: {combined[:500]}")
    return rc, out, err, model


# --------------------------------------------------------------------------- #
# shortlist
# --------------------------------------------------------------------------- #
def _tracker_pairs(aijob: Path) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    tracker = aijob / "job_search_tracker.csv"
    if not tracker.exists():
        return pairs
    try:
        with tracker.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                company = (row.get("company") or "").strip().lower()
                role = (row.get("role") or "").strip().lower()
                if company:
                    pairs.add((company, role))
    except OSError:
        pass
    return pairs


def _deadline_within(deadline: str | None, days: int = 7) -> bool:
    if not deadline or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(deadline)):
        return False
    try:
        t = time.strptime(str(deadline), "%Y-%m-%d")
    except ValueError:
        return False
    delta = (time.mktime(t) - time.mktime(time.localtime())) / 86400.0
    return 0 <= delta <= days


def build_shortlist(config: dict, size: int | None = None) -> list[dict]:
    aijob = Path(config["AIJOB_DIR"])
    seen_file = aijob / "job_scraper" / "seen_jobs.json"
    if not seen_file.exists():
        return []
    seen = json.loads(seen_file.read_text(encoding="utf-8")).get("seen", {})
    size = size or int(config.get("SHORTLIST_SIZE", "5"))
    tracker = _tracker_pairs(aijob)
    state = load_state()
    offered = set(state.get("offered_urls", []))

    rows: list[dict] = []
    for key, job in seen.items():
        if job.get("status") != "ranked":
            continue
        if job.get("location_verdict") == "FAIL" or job.get("language_gate") == "FAIL":
            continue
        url = job.get("url") or key
        if url in offered:
            continue
        company = (job.get("company") or "").strip()
        title = (job.get("title") or "").strip()
        if (company.lower(), title.lower()) in tracker:
            continue
        flags = []
        if job.get("location_verdict") == "FLAG":
            flags.append("location")
        if job.get("language_gate") == "FLAG":
            flags.append("idioma")
        if _deadline_within(job.get("deadline")):
            flags.append("deadline <7d")
        rows.append(
            {
                "key": key,
                "url": url,
                "company": company,
                "title": title,
                "score": job.get("rank_score"),
                "verdict": job.get("rank_verdict") or "",
                "location": job.get("location") or "",
                "deadline": job.get("deadline"),
                "flags": flags,
                "strengths": job.get("strengths") or [],
                "gaps": job.get("gaps") or [],
            }
        )

    rows.sort(key=lambda r: (r.get("score") or 0), reverse=True)
    rows = rows[:size]
    for i, row in enumerate(rows, start=1):
        row["n"] = i
        row["status"] = "offered"
    return rows


def render_shortlist(rows: list[dict]) -> str:
    if not rows:
        return "Sin ofertas nuevas que cumplan el filtro. Nada que elegir hoy."
    lines = [f"Shortlist - {time.strftime('%Y-%m-%d')}", ""]
    for r in rows:
        flag = (" ⚠" + ",".join(r["flags"])) if r["flags"] else ""
        lines.append(f"{r['n']}. [{r.get('score')}] {r.get('verdict','')} - {r['title']} @ {r['company']}{flag}")
        if r.get("location"):
            lines.append(f"    {r['location']}")
        lines.append(f"    {r['url']}")
        if r.get("strengths"):
            lines.append(f"    + {r['strengths'][0]}")
        if r.get("gaps"):
            lines.append(f"    - {r['gaps'][0]}")
        lines.append("")
    lines.append('Responde con los numeros (ej: "1 3") para preparar esas candidaturas.')
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# rank batching (keeps a large `new` backlog from being scored all at once)
# --------------------------------------------------------------------------- #
def _seen_file(config: dict) -> Path:
    return Path(config["AIJOB_DIR"]) / "job_scraper" / "seen_jobs.json"


def _write_seen(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def restore_deferred(config: dict) -> int:
    """Return parked `deferred` entries to `new` (crash recovery + after rank)."""
    path = _seen_file(config)
    if not path.exists():
        return 0
    data = json.loads(path.read_text(encoding="utf-8"))
    seen = data.get("seen", {})
    count = 0
    for job in seen.values():
        if job.get("status") == "deferred":
            job["status"] = "new"
            count += 1
    if count:
        _write_seen(path, data)
    return count


def prepare_rank_batch(config: dict, cap: int) -> int:
    """Keep only the newest `cap` status:new jobs as `new`; park the rest.

    Returns the number of jobs parked. No-op when cap <= 0 or the backlog fits.
    """
    if cap <= 0:
        return 0
    path = _seen_file(config)
    if not path.exists():
        return 0
    data = json.loads(path.read_text(encoding="utf-8"))
    seen = data.get("seen", {})
    fresh = [(k, v) for k, v in seen.items() if v.get("status") == "new"]
    if len(fresh) <= cap:
        return 0
    fresh.sort(key=lambda kv: str(kv[1].get("first_seen") or ""), reverse=True)
    for _key, job in fresh[cap:]:
        job["status"] = "deferred"
    _write_seen(path, data)
    log(f"rank batch: kept {cap} newest new jobs, parked {len(fresh) - cap} as deferred")
    return len(fresh) - cap
