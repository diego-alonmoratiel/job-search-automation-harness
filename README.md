# Job Search Automation Harness

An engineering experiment in **agentic automation**: a small, dependency-light
harness that runs a job-search workflow unattended on a Raspberry Pi, reports to
its owner over Telegram, and **never submits an application without explicit human
approval**.

It is not a "spam bot". The design is deliberately human-in-the-loop, treats job
postings as untrusted input, and keeps secrets and personal data out of the repo.

## Why this exists

Job searching is repetitive: search, deduplicate, score, tailor documents, fill
forms, track outcomes. This project automates the mechanical parts while keeping
the decisions (which role, whether to send) with the human. It is also a
playground for the kind of automation used in platform operations: scheduled jobs,
state machines, retries, provider fallbacks, browser automation and agent
orchestration.

## Architecture

```
                 Telegram (owner)
                       |
                       v
+-------------------------------------------------------------+
|  Raspberry Pi (Linux, ARM64, headless)                      |
|                                                             |
|  harness                                                    |
|    - tg-bridge ........ commands / URLs / natural language  |
|    - jobctl ........... daily / apply / fill / submit / ...  |
|    - state.json ....... offers, applications, pending input  |
|    - routes.conf ...... task -> model routing               |
|                                                             |
|    +-- agent CLI (opencode) --commands--> job-search repo   |
|    |       scrape / rank / apply / score                    |
|    |                                                        |
|    +-- browser layer (Playwright)                           |
|            Chromium on a virtual display (Xvfb)             |
|              - DOM filling + file uploads                   |
|              - CDP shared with a computer-use agent         |
|            screenshot -> Telegram -> wait for "ok" -> send  |
+-------------------------------------------------------------+
```

## Features

- **Scheduled pipeline**: a systemd timer runs search + ranking and sends a
  shortlist to Telegram.
- **State machine**: offers, applications, pending questions, stuck states and the
  "current" application survive restarts.
- **Model routing**: a single `routes.conf` maps each task to a model, with a
  fallback provider on failures.
- **Form filling**: Playwright fills standard fields, selects custom dropdowns,
  uploads CV/cover PDFs and handles login/signup forms.
- **Verification codes**: when a portal asks for an email code, the harness keeps
  the page open, asks the owner on Telegram and enters the code without reloading.
- **Computer-use fallback**: a Playwright browser is shared over CDP with a
  computer-use agent for controls the DOM cannot handle.
- **Stuck detection**: anti-bot/captcha/no-form pages are detected, reported, and
  can be re-pointed to a better URL by the owner.
- **Human approval gate**: nothing is submitted without an explicit "ok".

## Security model

- The Telegram bridge only accepts the configured owner id.
- Secrets (`harness.env`, `answers.json`, API credentials) are never committed and
  live only on the machine, with mode `600`.
- Job postings and portal content are treated as **untrusted data**, never as
  instructions.
- Submission is a separate, explicit step from filling. There is no auto-submit.
- Application state (tracker, seen jobs, generated documents) is kept out of git.

## Tech stack

- Python 3 (standard library only) for the harness.
- TypeScript + Bun for the browser form filler.
- Playwright + Chromium for browser automation, sharing CDP with a computer-use
  agent.
- systemd (user units) for the bridge, the daily timer and health checks.
- Telegram Bot API for the control/approval channel.
- An external agent runner (opencode) and job-search repo for scraping, ranking
  and document generation.

## Quickstart

The harness expects a job-search repo (prompts + portal CLIs) and an agent runner.
See `harness/README.md` for the full setup. In short, on a Linux host:

```bash
# 1. copy the harness to ~/job-harness and configure secrets
cp harness/config/harness.env.example harness/config/harness.env
cp harness/config/answers.example.json harness/config/answers.json
# edit both files (Telegram token, owner id, answers)

# 2. install systemd units (user scope)
cd ~/job-harness && ./install.sh

# 3. run the daily pipeline manually
~/job-harness/bin/jobctl daily
```

## Repository layout

```
harness/
  bin/            jobctl (CLI), tg-bridge (Telegram polling)
  lib/            config, state, Telegram API, agent/browser runners
  browser/        Playwright form filler + test forms
  agents/         agent/command prompts installed into the search repo
  config/         routes, example env, example answers
  systemd/        bridge, daily timer, filesystem health check
  install.sh      deployment helper
```

## Status and scope

Personal project, actively used on a Raspberry Pi. It depends on an external
job-search repository and an agent runner, so it is a harness rather than a
standalone product. Portal support, browser behaviour and agent prompts evolve
over time.

## Disclaimer

For personal use. Respect the terms of service and `robots.txt` of every site you
point it at; some portals prohibit automation. The harness is intentionally built
to require explicit human approval before submitting anything.

## License

MIT. See [LICENSE](LICENSE).
